// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const KUSTO_NOTEBOOK_FORMAT_VERSION = 1 as const;
export const KUSTO_NOTEBOOK_TYPE = 'msKustoExplorer.kqlNotebook';
export const KUSTO_NOTEBOOK_CELL_ID_METADATA_KEY = 'msKustoExplorer.cellId';

export type NotebookJsonValue =
    | boolean
    | number
    | string
    | null
    | NotebookJsonValue[]
    | { [key: string]: NotebookJsonValue };

export interface SerializedKustoNotebook {
    formatVersion: typeof KUSTO_NOTEBOOK_FORMAT_VERSION;
    metadata?: KustoNotebookMetadata;
    cells: SerializedKustoNotebookCell[];
}

export interface KustoNotebookMetadata {
    [key: string]: NotebookJsonValue | KustoNotebookConnection | undefined;
    connection?: KustoNotebookConnection;
    custom?: { [key: string]: NotebookJsonValue };
}

export interface KustoNotebookConnection {
    cluster: string;
    database?: string;
    serverKind?: string;
}

export type SerializedKustoNotebookCell =
    | SerializedKustoCodeCell
    | SerializedKustoMarkdownCell;

interface SerializedKustoCellBase {
    id: string;
    text: string;
    metadata?: { [key: string]: NotebookJsonValue };
}

export interface SerializedKustoCodeCell extends SerializedKustoCellBase {
    kind: 'code';
    language: 'kusto';
}

export interface SerializedKustoMarkdownCell extends SerializedKustoCellBase {
    kind: 'markdown';
    language: 'markdown';
}

export function isSerializedKustoNotebook(value: unknown): value is SerializedKustoNotebook {
    if (!isRecord(value)
        || value.formatVersion !== KUSTO_NOTEBOOK_FORMAT_VERSION
        || !Array.isArray(value.cells)
        || value.cells.some(cell => !isSerializedCell(cell))) {
        return false;
    }

    const ids = value.cells.map(cell => cell.id);
    if (new Set(ids).size !== ids.length) {
        return false;
    }

    return value.metadata === undefined || isNotebookMetadata(value.metadata);
}

function isSerializedCell(value: unknown): value is SerializedKustoNotebookCell {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || value.id.length === 0
        || typeof value.text !== 'string'
        || Object.prototype.hasOwnProperty.call(value, 'outputs')) {
        return false;
    }

    const hasValidKindAndLanguage =
        (value.kind === 'code' && value.language === 'kusto')
        || (value.kind === 'markdown' && value.language === 'markdown');

    return hasValidKindAndLanguage
        && (value.metadata === undefined || isJsonObject(value.metadata));
}

function isNotebookMetadata(value: unknown): value is KustoNotebookMetadata {
    if (!isJsonObject(value)) {
        return false;
    }

    if (value.connection !== undefined && !isKustoNotebookConnection(value.connection)) {
        return false;
    }

    return value.custom === undefined || isJsonObject(value.custom);
}

export function isKustoNotebookConnection(value: unknown): value is KustoNotebookConnection {
    return isJsonObject(value)
        && typeof value.cluster === 'string'
        && (value.database === undefined || typeof value.database === 'string')
        && (value.serverKind === undefined || typeof value.serverKind === 'string');
}

function isJsonObject(value: unknown): value is { [key: string]: NotebookJsonValue } {
    return isRecord(value)
        && Object.values(value).every(item => isJsonValue(item));
}

function isJsonValue(value: unknown): value is NotebookJsonValue {
    if (value === null
        || typeof value === 'boolean'
        || typeof value === 'string'
        || (typeof value === 'number' && Number.isFinite(value))) {
        return true;
    }

    if (Array.isArray(value)) {
        return value.every(item => isJsonValue(item));
    }

    return isJsonObject(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
