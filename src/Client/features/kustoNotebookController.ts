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
    buildNotebookResultPreviews,
    KustoNotebookManager,
    NOTEBOOK_PHASE_TWO_MAX_ROWS,
} from './kustoNotebookManager';
import type { IServer, QueryDiagnostic } from './server';

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
        private readonly server: IServer,
        private readonly connections: ConnectionManager,
        private readonly notebookManager: KustoNotebookManager,
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
        await execution.clearOutput();

        if (execution.token.isCancellationRequested) {
            execution.end(undefined, Date.now());
            return { outcome: 'cancelled', connection };
        }

        const query = cell.document.getText();
        if (query.trim().length === 0) {
            await execution.replaceOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text('Cell is empty.'),
            ]));
            execution.end(true, Date.now());
            return { outcome: 'success', connection };
        }

        try {
            const clientRequestId = createClientRequestId();
            const result = await this.server.runQuery(
                query,
                connection.cluster,
                connection.database,
                true,
                NOTEBOOK_PHASE_TWO_MAX_ROWS,
                clientRequestId,
                NOTEBOOK_PHASE_TWO_MAX_ROWS,
                execution.token,
            );

            if (execution.token.isCancellationRequested) {
                await execution.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Query cancelled.'),
                ]));
                execution.end(undefined, Date.now());
                return { outcome: 'cancelled', connection };
            }

            if (!result) {
                throw new Error('The Kusto language server did not return a result.');
            }

            if (result.connection || result.cluster) {
                await this.connections.ensureServer(result.connection ?? result.cluster!);
            }
            let effectiveConnection = connection;
            if (result.cluster || result.database) {
                const cluster = result.cluster ?? connection.cluster;
                const database = result.database ?? (result.cluster ? undefined : connection.database);
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

            if (result.error) {
                await execution.replaceOutput(createErrorOutput(result.error));
                execution.end(false, Date.now());
                return { outcome: 'failed', connection: effectiveConnection };
            }

            const outputs = result.data
                ? createResultOutputs(result.data)
                : [new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Query completed without results.'),
                ])];
            await execution.replaceOutput(outputs);
            execution.end(true, Date.now());
            return { outcome: 'success', connection: effectiveConnection };
        } catch (error) {
            if (execution.token.isCancellationRequested) {
                await execution.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Query cancelled.'),
                ]));
                execution.end(undefined, Date.now());
                return { outcome: 'cancelled', connection };
            }

            const message = error instanceof Error ? error.message : String(error);
            await execution.replaceOutput(new vscode.NotebookCellOutput([
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

function createErrorOutput(diagnostic: QueryDiagnostic): vscode.NotebookCellOutput {
    const message = diagnostic.details
        ? `${diagnostic.message}\n\n${diagnostic.details}`
        : diagnostic.message;
    return new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(new Error(message)),
    ]);
}

function createResultOutputs(data: NonNullable<Awaited<ReturnType<IServer['runQuery']>>>['data']): vscode.NotebookCellOutput[] {
    if (!data) {
        return [];
    }

    const notice = `Notebook queries are temporarily limited to ${NOTEBOOK_PHASE_TWO_MAX_ROWS.toLocaleString()} rows until scalable result sessions are enabled.`;
    const outputs = [
        new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(notice),
        ]),
    ];
    for (const preview of buildNotebookResultPreviews(data)) {
        outputs.push(new vscode.NotebookCellOutput(
            [vscode.NotebookCellOutputItem.text(preview.text)],
            preview.tableName ? { tableName: preview.tableName } : undefined,
        ));
    }
    return outputs;
}
