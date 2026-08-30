// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KustoNotebookManager } from '../../features/kustoNotebookManager';
import {
    KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY,
    KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY,
} from '../../features/notebookFormat';
import type { ConnectionManager } from '../../features/connectionManager';

describe('KustoNotebookManager', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('assigns persistent identifiers to cells added by the notebook UI', async () => {
        const { manager } = createManager();
        const notebook = createNotebook([createCell()]);
        const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);

        await manager.ensureCellIds(notebook);

        const edit = applyEdit.mock.calls[0]?.[0] as unknown as {
            entries: Array<{ edits: Array<{ metadata: Record<string, unknown> }> }>;
        };
        expect(edit.entries[0]?.edits[0]?.metadata[KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY])
            .toEqual(expect.any(String));
        manager.dispose();
    });

    it('replaces duplicate cell identifiers', async () => {
        const { manager } = createManager();
        const first = createCell();
        const second = createCell();
        second.index = 1;
        first.metadata = { [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'duplicate' };
        second.metadata = { [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'duplicate' };
        const notebook = createNotebook([first, second]);
        const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);

        await manager.ensureCellIds(notebook);

        const edit = applyEdit.mock.calls[0]?.[0] as unknown as {
            entries: Array<{ edits: Array<{ index: number; metadata: Record<string, unknown> }> }>;
        };
        expect(edit.entries[0]?.edits).toHaveLength(1);
        expect(edit.entries[0]?.edits[0]?.index).toBe(1);
        expect(edit.entries[0]?.edits[0]?.metadata[KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY])
            .not.toBe('duplicate');
        manager.dispose();
    });

    it('does not edit notebook metadata when the connection is unchanged', async () => {
        const { manager } = createManager();
        const connection = { cluster: 'help.kusto.windows.net', database: 'Samples' };
        const notebook = createNotebook([], { connection });
        const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');

        await manager.setConnection(notebook, connection);

        expect(applyEdit).not.toHaveBeenCalled();
        manager.dispose();
    });

    it('clears transient connections for removed cells', async () => {
        const { manager, connections } = createManager();
        let cells = [createCell()];
        const notebook = createNotebook([], {
            connection: { cluster: 'help.kusto.windows.net', database: 'Samples' },
        });
        notebook.getCells = () => cells;
        await manager.synchronizeConnection(notebook);

        cells = [];
        await manager.synchronizeConnection(notebook);

        expect(connections.clearTransientDocumentConnection).toHaveBeenCalledWith(
            'vscode-notebook-cell:///investigation.kqlnb#cell-1',
        );
        manager.dispose();
    });

    it('inserts a labeled continuation cell after its source', async () => {
        const { manager } = createManager();
        const source = createCell();
        source.metadata = { [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'source-id' };
        const notebook = createNotebook([source]);
        const revealRange = vi.fn();
        const editor = {
            notebook,
            selection: undefined,
            revealRange,
        } as unknown as vscode.NotebookEditor;
        const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);

        await manager.insertContinuationCell(
            editor,
            source,
            'let LocalResult = datatable (Value: long) [1];\nLocalResult',
            'exactSnapshot',
        );

        const edit = applyEdit.mock.calls[0]?.[0] as unknown as {
            entries: Array<{
                edits: Array<{
                    index: number;
                    cells: vscode.NotebookCellData[];
                }>;
            }>;
        };
        expect(edit.entries[0]?.edits[0]?.index).toBe(1);
        const inserted = edit.entries[0]?.edits[0]?.cells[0];
        expect(inserted?.value).toContain('LocalResult');
        expect(inserted?.metadata).toMatchObject({
            [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: expect.any(String),
            [KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY]: {
                kind: 'exactSnapshot',
                sourceCellId: 'source-id',
            },
        });
        expect(editor.selection).toMatchObject({ start: 1, end: 2 });
        expect(revealRange).toHaveBeenCalledOnce();
        manager.dispose();
    });

    it('serializes continuation insertions and recomputes the source position', async () => {
        const { manager } = createManager();
        const first = createCell('first');
        const second = createCell('second');
        first.metadata = { [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'first-id' };
        second.metadata = { [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'second-id' };
        const cells = [first, second];
        const notebook = createNotebook(cells);
        const editor = {
            notebook,
            revealRange: vi.fn(),
        } as unknown as vscode.NotebookEditor;
        let completeFirstEdit: ((applied: boolean) => void) | undefined;
        const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit')
            .mockImplementationOnce(() => new Promise(resolve => {
                completeFirstEdit = resolve;
            }))
            .mockResolvedValue(true);

        const firstInsertion = manager.insertContinuationCell(
            editor,
            first,
            'LocalResult',
            'exactSnapshot',
        );
        const secondInsertion = manager.insertContinuationCell(
            editor,
            second,
            'LocalResult',
            'exactSnapshot',
        );
        await vi.waitFor(() => expect(applyEdit).toHaveBeenCalledTimes(1));

        cells.splice(1, 0, createCell('inserted'));
        completeFirstEdit?.(true);
        await Promise.all([firstInsertion, secondInsertion]);

        const secondEdit = applyEdit.mock.calls[1]?.[0] as unknown as {
            entries: Array<{ edits: Array<{ index: number }> }>;
        };
        expect(secondEdit.entries[0]?.edits[0]?.index).toBe(3);
        manager.dispose();
    });
});

function createManager(): {
    manager: KustoNotebookManager;
    connections: {
        setTransientDocumentConnection: ReturnType<typeof vi.fn>;
        clearTransientDocumentConnection: ReturnType<typeof vi.fn>;
    };
} {
    const connections = {
        setTransientDocumentConnection: vi.fn(async () => undefined),
        clearTransientDocumentConnection: vi.fn(async () => undefined),
        getActiveDocumentConnection: vi.fn(async () => undefined),
        findServerInfo: vi.fn(() => undefined),
    };
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    return {
        manager: new KustoNotebookManager(
            context,
            connections as unknown as ConnectionManager,
        ),
        connections,
    };
}

function createCell(id: string = 'cell-1'): vscode.NotebookCell {
    return {
        index: 0,
        kind: vscode.NotebookCellKind.Code,
        metadata: {},
        document: {
            uri: vscode.Uri.parse(`vscode-notebook-cell:///investigation.kqlnb#${id}`),
        },
    } as unknown as vscode.NotebookCell;
}

function createNotebook(
    cells: vscode.NotebookCell[],
    metadata: Record<string, unknown> = {},
): vscode.NotebookDocument {
    return {
        notebookType: 'msKustoExplorer.kqlNotebook',
        metadata,
        uri: vscode.Uri.parse('file:///investigation.kqlnb'),
        getCells: () => cells,
    } as unknown as vscode.NotebookDocument;
}
