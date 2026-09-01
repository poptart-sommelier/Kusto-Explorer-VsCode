// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { QueryDiagnostic } from './server';

export const RESULT_SESSION_PROTOCOL_VERSION = 1 as const;
export const RESULT_SESSION_MAX_PAGE_SIZE = 1_000;
export const RESULT_SESSION_MAX_PROJECTION_PAGE_SIZE = 1_000;

export const RESULT_SESSION_METHODS = {
    start: 'kusto/startResultSession',
    cancel: 'kusto/cancelResultSessionOperation',
    status: 'kusto/getResultSessionStatus',
    setView: 'kusto/setResultSessionView',
    page: 'kusto/getResultSessionPage',
    projection: 'kusto/getResultSessionProjection',
    continuation: 'kusto/createResultSessionContinuation',
    enrichment: 'kusto/createResultSessionEnrichment',
    dispose: 'kusto/disposeResultSession',
} as const;

export type ResultSessionState =
    | 'queued'
    | 'running'
    | 'materializing'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'disposed';

export type ResultSessionViewState = 'none' | 'evaluating' | 'ready' | 'failed';
export type ResultSessionFilterState = 'valid' | 'invalid';
export type ResultSessionSortDirection = 'ascending' | 'descending';
export type ResultSessionProjectionScope = 'all' | 'filtered' | 'selection';
export type ResultSessionContinuationKind = 'source' | 'exactSnapshot' | 'liveRerun';

export interface StartResultSessionParams {
    protocolVersion: typeof RESULT_SESSION_PROTOCOL_VERSION;
    query: string;
    cluster?: string;
    database?: string;
    isReadOnly?: boolean;
    maxRows?: number;
    clientRequestId?: string;
}

export interface StartResultSessionResult {
    protocolVersion: typeof RESULT_SESSION_PROTOCOL_VERSION;
    operationId: string;
    sessionId: string;
}

export interface CancelResultSessionOperationParams {
    operationId: string;
}

export interface CancelResultSessionOperationResult {
    accepted: boolean;
}

export interface GetResultSessionStatusParams {
    sessionId: string;
}

export interface ResultSessionStatus {
    protocolVersion: typeof RESULT_SESSION_PROTOCOL_VERSION;
    operationId: string;
    sessionId: string;
    state: ResultSessionState;
    tables: ResultSessionTableStatus[];
    /** Effective connection directive value, used by the extension host and never sent to the renderer. */
    connection?: string;
    provenance?: ResultSessionProvenance;
    error?: QueryDiagnostic;
}

export interface ResultSessionTableStatus {
    id: string;
    name: string;
    columns: ResultSessionColumn[];
    rowsRead: number;
    totalRows?: number;
    isComplete: boolean;
    view?: ResultSessionViewStatus;
}

export interface ResultSessionColumn {
    name: string;
    type: string;
}

export interface ResultSessionViewStatus {
    revision: number;
    state: ResultSessionViewState;
    matchedRows?: number;
    filters?: ResultSessionColumnFilterStatus[];
    error?: QueryDiagnostic;
    readyRevision?: number;
    readyMatchedRows?: number;
    readyFilters?: ResultSessionColumnFilter[];
    readySorts?: ResultSessionColumnSort[];
}

export interface ResultSessionColumnFilterStatus {
    columnIndex: number;
    state: ResultSessionFilterState;
    error?: QueryDiagnostic;
}

export interface ResultSessionProvenance {
    query: string;
    cluster?: string;
    database?: string;
    executionStartedAt: string;
    executionCompletedAt?: string;
    clientRequestId?: string;
    notebookUri?: string;
    cellId?: string;
    continuationKind?: ResultSessionContinuationKind;
    isStaleSinceSnapshot?: boolean;
}

export interface SetResultSessionViewParams {
    sessionId: string;
    tableId: string;
    revision: number;
    filters: ResultSessionColumnFilter[];
    sorts: ResultSessionColumnSort[];
}

export interface ResultSessionColumnFilter {
    columnIndex: number;
    pattern: string;
    caseSensitive: boolean;
}

export interface ResultSessionColumnSort {
    columnIndex: number;
    direction: ResultSessionSortDirection;
}

export interface SetResultSessionViewResult {
    accepted: boolean;
    revision: number;
}

export interface GetResultSessionPageParams {
    sessionId: string;
    tableId: string;
    viewRevision: number;
    offset: number;
    /** Must be between 1 and RESULT_SESSION_MAX_PAGE_SIZE. */
    count: number;
}

export interface ResultSessionPage {
    protocolVersion: typeof RESULT_SESSION_PROTOCOL_VERSION;
    sessionId: string;
    tableId: string;
    viewRevision: number;
    offset: number;
    rows: ResultSessionRow[];
    viewRows: number;
}

export interface ResultSessionRow {
    sourceIndex: number;
    values: unknown[];
}

export interface GetResultSessionProjectionParams {
    sessionId: string;
    tableId: string;
    viewRevision: number;
    scope: ResultSessionProjectionScope;
    rowRanges?: ResultSessionRowRange[];
    columnIndexes: number[];
    offset: number;
    /** Must be between 1 and RESULT_SESSION_MAX_PROJECTION_PAGE_SIZE. */
    count: number;
}

export interface ResultSessionRowRange {
    offset: number;
    count: number;
}

export interface ResultSessionProjection {
    protocolVersion: typeof RESULT_SESSION_PROTOCOL_VERSION;
    sessionId: string;
    tableId: string;
    viewRevision: number;
    columns: ResultSessionColumn[];
    rows: ResultSessionRow[];
    offset: number;
    projectedRows: number;
    hasMore: boolean;
}

export interface CreateResultSessionContinuationParams {
    sessionId: string;
    tableId: string;
    viewRevision: number;
    scope: ResultSessionProjectionScope;
    rowRanges?: ResultSessionRowRange[];
    columnIndexes: number[];
}

export interface CreateResultSessionContinuationResult {
    snapshotQuery?: string;
    snapshotTextBytes: number;
    queryTextBudgetBytes: number;
    projectedRows: number;
    liveRerunQuery?: string;
    liveRerunTextBytes?: number;
    liveRerunUnavailableReason?: string;
}

export interface CreateResultSessionEnrichmentParams {
    sessionId: string;
    tableId: string;
    viewRevision: number;
    /** Ordered, non-overlapping view row ranges covering the enrichment input rows. */
    rowRanges: ResultSessionRowRange[];
    columnIndexes: number[];
    /** View index of the right-clicked row. */
    clickedRowIndex: number;
    clickedColumnIndex: number;
    selectedColumnIndexes: number[];
    prompts: ResultSessionEnrichmentPrompt[];
    snippet: string;
}

export interface ResultSessionEnrichmentPrompt {
    name: string;
    /** Declared Kusto scalar type. Only `string` values are quoted and escaped. */
    type?: string;
    /** Manually entered value. Ignored when `columnIndex` is set. */
    text?: string;
    /** Binds the prompt to the right-clicked row's value in this column. */
    columnIndex?: number;
}

export interface CreateResultSessionEnrichmentResult {
    /** Generated cell text, or undefined when it does not fit the query-text budget. */
    query?: string;
    queryTextBytes: number;
    queryTextBudgetBytes: number;
    projectedRows: number;
}

export interface DisposeResultSessionParams {
    sessionId: string;
}

export interface DisposeResultSessionResult {
    disposed: boolean;
}
