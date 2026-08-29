// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
    isSerializedKustoNotebook,
    KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY,
    KUSTO_NOTEBOOK_FORMAT_VERSION,
    type NotebookJsonValue,
    type SerializedKustoNotebook,
    type SerializedKustoNotebookCell,
} from './notebookFormat';

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

export class KustoNotebookSerializer implements vscode.NotebookSerializer {
    deserializeNotebook(content: Uint8Array, token: vscode.CancellationToken): vscode.NotebookData {
        throwIfCancelled(token);

        const text = textDecoder.decode(content);
        const serialized = text.trim().length === 0
            ? createEmptySerializedNotebook()
            : parseNotebook(text);

        const cells = serialized.cells.map(cell => {
            const kind = cell.kind === 'code'
                ? vscode.NotebookCellKind.Code
                : vscode.NotebookCellKind.Markup;
            const data = new vscode.NotebookCellData(kind, cell.text, cell.language);
            data.metadata = {
                ...(cell.metadata ?? {}),
                [KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY]: cell.id,
            };
            return data;
        });

        const notebook = new vscode.NotebookData(cells);
        if (serialized.metadata) {
            notebook.metadata = serialized.metadata;
        }
        return notebook;
    }

    serializeNotebook(data: vscode.NotebookData, token: vscode.CancellationToken): Uint8Array {
        throwIfCancelled(token);

        const serialized: SerializedKustoNotebook = {
            formatVersion: KUSTO_NOTEBOOK_FORMAT_VERSION,
            cells: data.cells.map((cell, index) => serializeCell(cell, index)),
        };

        if (data.metadata && Object.keys(data.metadata).length > 0) {
            serialized.metadata = data.metadata;
        }

        if (!isSerializedKustoNotebook(serialized)) {
            throw new Error('The notebook contains unsupported cell languages or non-JSON metadata.');
        }

        return textEncoder.encode(`${JSON.stringify(serialized, null, 2)}\n`);
    }
}

function createEmptySerializedNotebook(): SerializedKustoNotebook {
    return {
        formatVersion: KUSTO_NOTEBOOK_FORMAT_VERSION,
        cells: [{
            id: crypto.randomUUID(),
            kind: 'code',
            language: 'kusto',
            text: '',
        }],
    };
}

function parseNotebook(text: string): SerializedKustoNotebook {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error(`Invalid Kusto notebook JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!isSerializedKustoNotebook(value)) {
        throw new Error(`Unsupported or invalid Kusto notebook format. Expected version ${KUSTO_NOTEBOOK_FORMAT_VERSION}.`);
    }
    return value;
}

function serializeCell(cell: vscode.NotebookCellData, index: number): SerializedKustoNotebookCell {
    const metadata = { ...(cell.metadata ?? {}) } as Record<string, unknown>;
    const rawId = metadata[KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY];
    const id = typeof rawId === 'string' && rawId.length > 0
        ? rawId
        : crypto.randomUUID();
    delete metadata[KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY];

    const serializedMetadata = Object.keys(metadata).length > 0
        ? metadata as Record<string, NotebookJsonValue>
        : undefined;

    if (cell.kind === vscode.NotebookCellKind.Code) {
        if (cell.languageId !== 'kusto') {
            throw new Error(`Code cell ${index + 1} must use the Kusto language before the notebook can be saved.`);
        }
        return {
            id,
            kind: 'code',
            language: 'kusto',
            text: cell.value,
            ...(serializedMetadata ? { metadata: serializedMetadata } : {}),
        };
    }

    if (cell.languageId !== 'markdown') {
        throw new Error(`Markdown cell ${index + 1} must use Markdown before the notebook can be saved.`);
    }
    return {
        id,
        kind: 'markdown',
        language: 'markdown',
        text: cell.value,
        ...(serializedMetadata ? { metadata: serializedMetadata } : {}),
    };
}

function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}
