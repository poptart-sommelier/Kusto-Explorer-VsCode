// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
    KustoNotebookSerializer,
} from '../../features/kustoNotebookSerializer';
import {
    KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY,
    KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY,
    KUSTO_NOTEBOOK_FORMAT_VERSION,
} from '../../features/notebookFormat';

const activeToken = { isCancellationRequested: false } as vscode.CancellationToken;

describe('KustoNotebookSerializer', () => {
    it('round-trips KQL and Markdown cells without outputs', () => {
        const code = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            'StormEvents | take 10',
            'kusto',
        );
        code.metadata = {
            [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'query-1',
            folded: false,
            [KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY]: {
                kind: 'exactSnapshot',
                sourceCellId: 'source-1',
            },
        };
        code.outputs = [new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text('sensitive result'),
        ])];
        const markdown = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Markup,
            '# Findings',
            'markdown',
        );
        markdown.metadata = {
            [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'notes-1',
        };
        const data = new vscode.NotebookData([code, markdown]);
        data.metadata = {
            connection: {
                cluster: 'help.kusto.windows.net',
                database: 'Samples',
            },
        };
        const serializer = new KustoNotebookSerializer();

        const bytes = serializer.serializeNotebook(data, activeToken);
        const persisted = JSON.parse(new TextDecoder().decode(bytes));
        const restored = serializer.deserializeNotebook(bytes, activeToken);

        expect(persisted.formatVersion).toBe(KUSTO_NOTEBOOK_FORMAT_VERSION);
        expect(persisted.cells[0].id).toBe('query-1');
        expect(persisted.cells[0]).not.toHaveProperty('outputs');
        expect(persisted.cells[0].metadata).toEqual({
            folded: false,
            [KUSTO_NOTEBOOK_CONTINUATION_METADATA_KEY]: {
                kind: 'exactSnapshot',
                sourceCellId: 'source-1',
            },
        });
        expect(restored.cells).toHaveLength(2);
        expect(restored.cells[0]?.value).toBe('StormEvents | take 10');
        expect(restored.cells[1]?.kind).toBe(vscode.NotebookCellKind.Markup);
        expect(restored.metadata?.connection).toEqual({
            cluster: 'help.kusto.windows.net',
            database: 'Samples',
        });
    });

    it('creates a KQL cell for an empty file', () => {
        const serializer = new KustoNotebookSerializer();

        const data = serializer.deserializeNotebook(new Uint8Array(), activeToken);

        expect(data.cells).toHaveLength(1);
        expect(data.cells[0]?.kind).toBe(vscode.NotebookCellKind.Code);
        expect(data.cells[0]?.languageId).toBe('kusto');
    });

    it('preserves cell identifiers assigned by the notebook manager', () => {
        const serializer = new KustoNotebookSerializer();
        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print 1', 'kusto');
        cell.metadata = {
            [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: 'stable-id',
        };
        const data = new vscode.NotebookData([cell]);

        const saved = JSON.parse(new TextDecoder().decode(serializer.serializeNotebook(data, activeToken)));

        expect(saved.cells[0].id).toBe('stable-id');
    });

    it('rejects invalid notebook JSON', () => {
        const serializer = new KustoNotebookSerializer();

        expect(() => serializer.deserializeNotebook(
            new TextEncoder().encode('{not-json}'),
            activeToken,
        )).toThrow('Invalid Kusto notebook JSON');
    });

    it('honors cancellation', () => {
        const serializer = new KustoNotebookSerializer();
        const cancelled = { isCancellationRequested: true } as vscode.CancellationToken;

        expect(() => serializer.deserializeNotebook(new Uint8Array(), cancelled))
            .toThrow(vscode.CancellationError);
    });
});
