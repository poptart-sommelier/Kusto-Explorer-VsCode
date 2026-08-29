// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildNotebookResultPreviews,
    KustoNotebookManager,
    NOTEBOOK_PREVIEW_MAX_CHARACTERS,
} from '../../features/kustoNotebookManager';
import { KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY } from '../../features/notebookFormat';
import type { ConnectionManager } from '../../features/connectionManager';
import type { ResultData } from '../../features/server';

describe('buildNotebookResultPreviews', () => {
    it('formats typed result tables as bounded TSV text', () => {
        const data: ResultData = {
            tables: [{
                name: 'PrimaryResult',
                columns: [
                    { name: 'State', type: 'string' },
                    { name: 'Count', type: 'long' },
                ],
                rows: [['WA', 42], ['OR', 7]],
            }],
        };

        const previews = buildNotebookResultPreviews(data);

        expect(previews).toEqual([{
            tableName: 'PrimaryResult',
            text: 'PrimaryResult (2 rows)\nState\tCount\nWA\t42\nOR\t7',
        }]);
    });

    it('truncates output that exceeds the character budget', () => {
        const data: ResultData = {
            tables: [{
                name: 'Large',
                columns: [{ name: 'Value', type: 'string' }],
                rows: [['a'.repeat(100)], ['b'.repeat(100)]],
            }],
        };

        const previews = buildNotebookResultPreviews(data, 120);

        expect(previews[0]?.text).toContain('Output truncated');
        expect(previews[0]?.text.length).toBeLessThanOrEqual(120);
        expect(previews[0]?.text.length).toBeLessThan(NOTEBOOK_PREVIEW_MAX_CHARACTERS);
    });

    it('describes a query with no tabular results', () => {
        expect(buildNotebookResultPreviews({ tables: [] })).toEqual([
            { text: 'Query completed without tabular results.' },
        ]);
    });
});

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

function createCell(): vscode.NotebookCell {
    return {
        index: 0,
        kind: vscode.NotebookCellKind.Code,
        metadata: {},
        document: {
            uri: vscode.Uri.parse('vscode-notebook-cell:///investigation.kqlnb#cell-1'),
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
