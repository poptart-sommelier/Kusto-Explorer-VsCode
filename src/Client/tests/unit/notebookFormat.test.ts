// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';
import {
    isSerializedKustoNotebook,
    KUSTO_NOTEBOOK_FORMAT_VERSION,
    type SerializedKustoNotebook,
} from '../../features/notebookFormat';

function createNotebook(): SerializedKustoNotebook {
    return {
        formatVersion: KUSTO_NOTEBOOK_FORMAT_VERSION,
        metadata: {
            connection: {
                cluster: 'https://help.kusto.windows.net',
                database: 'Samples',
                serverKind: 'Kusto',
            },
            custom: {
                investigation: 'failed sign-ins',
                tags: ['security', 'sample'],
            },
        },
        cells: [
            {
                id: 'query-1',
                kind: 'code',
                language: 'kusto',
                text: 'StormEvents | take 10',
            },
            {
                id: 'notes-1',
                kind: 'markdown',
                language: 'markdown',
                text: '# Findings',
                metadata: { collapsed: false },
            },
        ],
    };
}

describe('Kusto notebook format', () => {
    it('accepts the version 1 format', () => {
        expect(isSerializedKustoNotebook(createNotebook())).toBe(true);
    });

    it('rejects unsupported versions', () => {
        expect(isSerializedKustoNotebook({
            ...createNotebook(),
            formatVersion: 2,
        })).toBe(false);
    });

    it('rejects persisted cell outputs', () => {
        const notebook = createNotebook() as unknown as {
            cells: Array<Record<string, unknown>>;
        };
        notebook.cells[0]!.outputs = [{ data: 'sensitive result' }];

        expect(isSerializedKustoNotebook(notebook)).toBe(false);
    });

    it('requires the language to match the cell kind', () => {
        const notebook = createNotebook() as unknown as {
            cells: Array<Record<string, unknown>>;
        };
        notebook.cells[0]!.language = 'markdown';

        expect(isSerializedKustoNotebook(notebook)).toBe(false);
    });

    it('rejects duplicate cell identifiers', () => {
        const notebook = createNotebook();
        notebook.cells[1]!.id = notebook.cells[0]!.id;

        expect(isSerializedKustoNotebook(notebook)).toBe(false);
    });

    it('rejects non-JSON metadata values', () => {
        const notebook = createNotebook() as unknown as {
            metadata: { custom: Record<string, unknown> };
        };
        notebook.metadata.custom.callback = () => undefined;

        expect(isSerializedKustoNotebook(notebook)).toBe(false);
    });
});
