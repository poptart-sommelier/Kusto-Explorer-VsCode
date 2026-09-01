// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from './connectionManager';
import {
    isKustoNotebookConnection,
    KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY,
    KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY,
    KUSTO_NOTEBOOK_TYPE,
    type KustoNotebookContinuationKind,
    type KustoNotebookConnection,
} from './notebookFormat';

export class KustoNotebookManager implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[];
    private readonly synchronizedCells = new Map<string, Set<string>>();
    private readonly notebookQueues = new Map<string, Promise<void>>();

    constructor(
        context: vscode.ExtensionContext,
        private readonly connections: ConnectionManager,
    ) {
        this.disposables = [
            vscode.workspace.onDidOpenNotebookDocument(notebook => {
                if (notebook.notebookType === KUSTO_NOTEBOOK_TYPE) {
                    this.runFromEvent(notebook);
                }
            }),
            vscode.workspace.onDidChangeNotebookDocument(event => {
                if (event.notebook.notebookType !== KUSTO_NOTEBOOK_TYPE) {
                    return;
                }

                const cellsChanged = event.contentChanges.some(change =>
                    change.addedCells.length > 0 || change.removedCells.length > 0);
                if (event.metadata !== undefined || cellsChanged) {
                    this.runFromEvent(event.notebook);
                }
            }),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                if (notebook.notebookType === KUSTO_NOTEBOOK_TYPE) {
                    void this.enqueue(
                        notebook,
                        () => this.clearConnections(notebook.uri.toString()),
                    ).catch(error => {
                        const message = error instanceof Error ? error.message : String(error);
                        void vscode.window.showErrorMessage(`Failed to close Kusto notebook: ${message}`);
                    });
                }
            }),
            vscode.workspace.onWillSaveNotebookDocument(event => {
                if (event.notebook.notebookType === KUSTO_NOTEBOOK_TYPE) {
                    event.waitUntil(this.ensureCellIds(event.notebook));
                }
            }),
        ];
        context.subscriptions.push(this);

        for (const notebook of vscode.workspace.notebookDocuments) {
            if (notebook.notebookType === KUSTO_NOTEBOOK_TYPE) {
                this.runFromEvent(notebook);
            }
        }
    }

    getConnection(notebook: vscode.NotebookDocument): KustoNotebookConnection | undefined {
        const connection: unknown = notebook.metadata.connection;
        return isKustoNotebookConnection(connection) ? connection : undefined;
    }

    async setConnection(
        notebook: vscode.NotebookDocument,
        connection: KustoNotebookConnection,
    ): Promise<void> {
        if (connectionsEqual(this.getConnection(notebook), connection)) {
            await this.synchronizeConnection(notebook, connection);
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [
            vscode.NotebookEdit.updateNotebookMetadata({
                ...notebook.metadata,
                connection,
            }),
        ]);

        if (!await vscode.workspace.applyEdit(edit)) {
            throw new Error('VS Code could not update the notebook connection.');
        }
        await this.synchronizeConnection(notebook, connection);
    }

    async synchronizeConnection(
        notebook: vscode.NotebookDocument,
        explicitConnection?: KustoNotebookConnection,
    ): Promise<void> {
        return this.enqueue(notebook, () =>
            this.synchronizeConnectionCore(notebook, explicitConnection));
    }

    async ensureCellIds(notebook: vscode.NotebookDocument): Promise<void> {
        return this.enqueue(notebook, () => this.ensureCellIdsCore(notebook));
    }

    private async synchronizeConnectionCore(
        notebook: vscode.NotebookDocument,
        explicitConnection?: KustoNotebookConnection,
    ): Promise<void> {
        const notebookKey = notebook.uri.toString();
        const previousCells = this.synchronizedCells.get(notebookKey) ?? new Set<string>();
        const currentCells = new Set(
            notebook.getCells()
                .filter(cell => cell.kind === vscode.NotebookCellKind.Code)
                .map(cell => cell.document.uri.toString()),
        );

        for (const removedUri of previousCells) {
            if (!currentCells.has(removedUri)) {
                await this.connections.clearTransientDocumentConnection(removedUri);
            }
        }

        const connection = explicitConnection ?? this.getConnection(notebook);
        if (connection) {
            for (const cellUri of currentCells) {
                await this.connections.setTransientDocumentConnection(
                    cellUri,
                    connection.cluster,
                    connection.database,
                );
            }
        } else {
            for (const cellUri of currentCells) {
                await this.connections.clearTransientDocumentConnection(cellUri);
            }
        }

        this.synchronizedCells.set(notebookKey, currentCells);
    }

    async createNotebook(): Promise<vscode.NotebookEditor> {
        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'kusto');
        cell.metadata = {
            [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: crypto.randomUUID(),
        };
        const data = new vscode.NotebookData([cell]);
        const activeConnection = await this.connections.getActiveDocumentConnection();
        if (activeConnection) {
            const serverKind = this.connections.findServerInfo(activeConnection.cluster)?.serverKind;
            data.metadata = {
                connection: {
                    cluster: activeConnection.cluster,
                    ...(activeConnection.database ? { database: activeConnection.database } : {}),
                    ...(serverKind ? { serverKind } : {}),
                },
            };
        }

        const notebook = await vscode.workspace.openNotebookDocument(KUSTO_NOTEBOOK_TYPE, data);
        return vscode.window.showNotebookDocument(notebook);
    }

    async insertContinuationCell(
        editor: vscode.NotebookEditor,
        sourceCell: vscode.NotebookCell,
        query: string,
        kind: KustoNotebookContinuationKind,
        enrichmentId?: string,
    ): Promise<void> {
        return this.enqueue(
            editor.notebook,
            () => this.insertContinuationCellCore(editor, sourceCell, query, kind, enrichmentId),
        );
    }

    private async insertContinuationCellCore(
        editor: vscode.NotebookEditor,
        sourceCell: vscode.NotebookCell,
        query: string,
        kind: KustoNotebookContinuationKind,
        enrichmentId?: string,
    ): Promise<void> {
        const cells = editor.notebook.getCells();
        const sourceIndex = cells.findIndex(cell =>
            cell.document.uri.toString() === sourceCell.document.uri.toString());
        if (sourceIndex < 0) {
            throw new Error('The source notebook cell no longer exists.');
        }

        const sourceCellId = sourceCell.metadata[KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY];
        if (typeof sourceCellId !== 'string' || sourceCellId.length === 0) {
            throw new Error('The source notebook cell does not have a stable identifier.');
        }

        const cell = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            query,
            'kusto',
        );
        cell.metadata = {
            [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: crypto.randomUUID(),
            [KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY]: {
                kind,
                sourceCellId,
                ...(enrichmentId ? { enrichmentId } : {}),
            },
        };
        const insertionIndex = sourceIndex + 1;
        const edit = new vscode.WorkspaceEdit();
        edit.set(editor.notebook.uri, [
            vscode.NotebookEdit.insertCells(insertionIndex, [cell]),
        ]);
        if (!await vscode.workspace.applyEdit(edit)) {
            throw new Error('VS Code could not insert the continuation cell.');
        }

        const range = new vscode.NotebookRange(insertionIndex, insertionIndex + 1);
        editor.selection = range;
        editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
        if (vscode.window.activeNotebookEditor === editor) {
            void focusContinuationCell().catch(error => {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showWarningMessage(
                    `The continuation cell was created but could not be focused: ${message}`,
                );
            });
        }
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        for (const notebookKey of this.synchronizedCells.keys()) {
            void this.clearConnections(notebookKey);
        }
        this.notebookQueues.clear();
    }

    private runFromEvent(notebook: vscode.NotebookDocument): void {
        void this.enqueue(notebook, async () => {
            await this.ensureCellIdsCore(notebook);
            await this.synchronizeConnectionCore(notebook);
        }).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to initialize Kusto notebook: ${message}`);
        });
    }

    private async ensureCellIdsCore(notebook: vscode.NotebookDocument): Promise<void> {
        const edits: vscode.NotebookEdit[] = [];
        const seenIds = new Set<string>();
        for (const cell of notebook.getCells()) {
            const id: unknown = cell.metadata[KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY];
            if (typeof id === 'string' && id.length > 0 && !seenIds.has(id)) {
                seenIds.add(id);
                continue;
            }

            let replacementId = crypto.randomUUID();
            while (seenIds.has(replacementId)) {
                replacementId = crypto.randomUUID();
            }
            seenIds.add(replacementId);
            edits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, {
                ...cell.metadata,
                [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: replacementId,
            }));
        }

        if (edits.length === 0) {
            return;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(notebook.uri, edits);
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            throw new Error('VS Code could not assign stable notebook cell identifiers.');
        }
    }

    private enqueue(
        notebook: vscode.NotebookDocument,
        operation: () => Promise<void>,
    ): Promise<void> {
        const key = notebook.uri.toString();
        const previous = this.notebookQueues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.notebookQueues.set(key, next);
        const cleanup = () => {
            if (this.notebookQueues.get(key) === next) {
                this.notebookQueues.delete(key);
            }
        };
        void next.then(cleanup, cleanup);
        return next;
    }

    private async clearConnections(notebookKey: string): Promise<void> {
        const cellUris = this.synchronizedCells.get(notebookKey);
        this.synchronizedCells.delete(notebookKey);
        if (!cellUris) {
            return;
        }

        for (const cellUri of cellUris) {
            await this.connections.clearTransientDocumentConnection(cellUri);
        }
    }
}

async function focusContinuationCell(): Promise<void> {
    await vscode.commands.executeCommand('notebook.cell.edit');
    await vscode.commands.executeCommand('cursorBottom');
    await vscode.commands.executeCommand('cursorEnd');
}

function connectionsEqual(
    left: KustoNotebookConnection | undefined,
    right: KustoNotebookConnection,
): boolean {
    return left?.cluster === right.cluster
        && left.database === right.database
        && left.serverKind === right.serverKind;
}
