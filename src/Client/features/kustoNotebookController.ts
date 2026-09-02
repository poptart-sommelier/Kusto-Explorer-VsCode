// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { createClientRequestId } from './clientRequestId';
import {
    isServer,
    isServerGroup,
    type ConnectionManager,
    type ServerInfo,
} from './connectionManager';
import {
    KUSTO_NOTEBOOK_TYPE,
    type KustoNotebookConnection,
} from './notebookFormat';
import {
    KustoNotebookManager,
} from './kustoNotebookManager';
import type { NotebookResultManager } from './notebookResultManager';

const KUSTO_NOTEBOOK_CONTROLLER_ID = 'msKustoExplorer.kqlNotebookController';

interface ServerQuickPickItem extends vscode.QuickPickItem {
    server: ServerInfo;
}

interface DatabaseQuickPickItem extends vscode.QuickPickItem {
    database: string;
}

export class KustoNotebookController implements vscode.Disposable {
    private readonly controller: vscode.NotebookController;
    private readonly executionQueues = new Map<string, Promise<void>>();
    private executionOrder = 0;

    constructor(
        private readonly connections: ConnectionManager,
        private readonly notebookManager: KustoNotebookManager,
        private readonly resultManager: NotebookResultManager,
    ) {
        this.controller = vscode.notebooks.createNotebookController(
            KUSTO_NOTEBOOK_CONTROLLER_ID,
            KUSTO_NOTEBOOK_TYPE,
            'Kusto',
        );
        this.controller.supportedLanguages = ['kusto'];
        this.controller.supportsExecutionOrder = true;
        this.controller.executeHandler = (cells, notebook) =>
            this.enqueueExecution(notebook, () => this.executeCells(cells, notebook));
    }

    async selectConnection(notebook: vscode.NotebookDocument): Promise<KustoNotebookConnection | undefined> {
        const items = this.getServerItems();
        if (items.length === 0) {
            await vscode.window.showWarningMessage(
                'No Kusto connections are configured. Add one in the Kusto Connections view first.',
            );
            return undefined;
        }

        const selectedServer = items.length === 1
            ? items[0]
            : await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a Kusto connection for this notebook',
                matchOnDescription: true,
                matchOnDetail: true,
            });
        if (!selectedServer) {
            return undefined;
        }

        const databases = await this.connections.getDatabasesForCluster(selectedServer.server.cluster);
        let database: string | undefined;
        if (databases.length === 1) {
            database = databases[0];
        } else if (databases.length > 1) {
            const databaseItems: DatabaseQuickPickItem[] = databases.map(name => ({
                label: `$(database) ${name}`,
                database: name,
            }));
            const selectedDatabase = await vscode.window.showQuickPick(databaseItems, {
                placeHolder: 'Select a database for this notebook',
                matchOnDescription: true,
            });
            if (!selectedDatabase) {
                return undefined;
            }
            database = selectedDatabase.database;
        }

        const connection: KustoNotebookConnection = {
            cluster: selectedServer.server.cluster,
            ...(database ? { database } : {}),
            ...(selectedServer.server.serverKind ? { serverKind: selectedServer.server.serverKind } : {}),
        };
        await this.notebookManager.setConnection(notebook, connection);
        return connection;
    }

    dispose(): void {
        this.executionQueues.clear();
        this.controller.dispose();
    }

    private async executeCells(
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
    ): Promise<void> {
        const codeCells = cells.filter(cell =>
            cell.kind === vscode.NotebookCellKind.Code
            && cell.document.languageId === 'kusto');
        if (codeCells.length === 0) {
            return;
        }

        let connection = this.notebookManager.getConnection(notebook)
            ?? await this.selectConnection(notebook);
        if (!connection) {
            return;
        }

        await this.notebookManager.synchronizeConnection(notebook, connection);
        for (const cell of codeCells) {
            const result = await this.executeCell(cell, notebook, connection);
            connection = result.connection;
            if (result.outcome !== 'success') {
                break;
            }
        }
    }

    private async executeCell(
        cell: vscode.NotebookCell,
        notebook: vscode.NotebookDocument,
        connection: KustoNotebookConnection,
    ): Promise<{
        outcome: 'success' | 'failed' | 'cancelled';
        connection: KustoNotebookConnection;
    }> {
        const execution = this.controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this.executionOrder;
        execution.start(Date.now());

        if (execution.token.isCancellationRequested) {
            execution.end(undefined, Date.now());
            return { outcome: 'cancelled', connection };
        }

        const query = cell.document.getText();
        if (query.trim().length === 0) {
            await execution.replaceOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text('Cell is empty.'),
            ]));
            await this.resultManager.releaseCellSession(cell);
            execution.end(true, Date.now());
            return { outcome: 'success', connection };
        }

        let replacementSessionId: string | undefined;
        try {
            const clientRequestId = createClientRequestId();
            const result = await this.resultManager.runQuery(
                query,
                connection.cluster,
                connection.database,
                clientRequestId,
                execution.token,
            );
            replacementSessionId = result.sessionId;

            if (execution.token.isCancellationRequested) {
                await this.resultManager.disposeSession(result.sessionId);
                replacementSessionId = undefined;
                await execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Query cancelled. Previous results were kept.'),
                ]));
                execution.end(undefined, Date.now());
                return { outcome: 'cancelled', connection };
            }

            const serverConnection = result.connection ?? result.provenance?.cluster;
            if (serverConnection) {
                await this.connections.ensureServer(serverConnection);
            }
            let effectiveConnection = connection;
            // Provenance echoes the requested connection back when the query did not
            // redirect, so adopting it unconditionally would rewrite the notebook's
            // saved connection after every run. Only follow a genuine redirect, and
            // never drop a field the notebook already has.
            const provenanceCluster = result.provenance?.cluster;
            const provenanceDatabase = result.provenance?.database;
            const redirected = (provenanceCluster !== undefined && provenanceCluster !== connection.cluster)
                || (provenanceDatabase !== undefined && provenanceDatabase !== connection.database);
            if (redirected) {
                const cluster = provenanceCluster ?? connection.cluster;
                const database = provenanceDatabase
                    ?? (cluster === connection.cluster ? connection.database : undefined);
                const serverKind = this.connections.findServerInfo(cluster)?.serverKind;
                effectiveConnection = {
                    cluster,
                    ...(database ? { database } : {}),
                    ...(serverKind
                        ? { serverKind }
                        : {}),
                };
                await this.notebookManager.setConnection(notebook, effectiveConnection);
            }

            if (result.tables.length === 0) {
                await execution.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Query completed without results.'),
                ]));
                await this.resultManager.disposeSession(result.sessionId);
                replacementSessionId = undefined;
                await this.resultManager.releaseCellSession(cell);
            } else {
                this.resultManager.prepareSession(notebook, cell, result.sessionId);
                await execution.replaceOutput(this.resultManager.createOutput(result));
                await this.resultManager.adoptSession(notebook, cell, result.sessionId);
                replacementSessionId = undefined;
            }
            execution.end(true, Date.now());
            return { outcome: 'success', connection: effectiveConnection };
        } catch (error) {
            if (replacementSessionId) {
                await this.resultManager.disposeSession(replacementSessionId);
            }
            if (execution.token.isCancellationRequested) {
                await execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Query cancelled. Previous results were kept.'),
                ]));
                execution.end(undefined, Date.now());
                return { outcome: 'cancelled', connection };
            }

            const message = error instanceof Error ? error.message : String(error);
            await execution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error(new Error(message)),
            ]));
            execution.end(false, Date.now());
            return { outcome: 'failed', connection };
        }
    }

    private enqueueExecution(
        notebook: vscode.NotebookDocument,
        operation: () => Promise<void>,
    ): Promise<void> {
        const key = notebook.uri.toString();
        const previous = this.executionQueues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.executionQueues.set(key, next);
        const cleanup = () => {
            if (this.executionQueues.get(key) === next) {
                this.executionQueues.delete(key);
            }
        };
        void next.then(cleanup, cleanup);
        return next;
    }

    private getServerItems(): ServerQuickPickItem[] {
        const items: ServerQuickPickItem[] = [];
        for (const item of this.connections.getServersAndGroups().items) {
            if (isServer(item)) {
                items.push(toServerQuickPick(item));
            } else if (isServerGroup(item)) {
                for (const server of item.servers) {
                    items.push(toServerQuickPick(server, item.name));
                }
            }
        }
        return items;
    }
}

function toServerQuickPick(server: ServerInfo, group?: string): ServerQuickPickItem {
    return {
        label: `$(server) ${server.displayName ?? server.cluster}`,
        description: server.cluster,
        ...(group ? { detail: `Group: ${group}` } : {}),
        server,
    };
}
