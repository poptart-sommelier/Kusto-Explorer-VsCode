// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';
import {
    RESULT_SESSION_MAX_PAGE_SIZE,
    RESULT_SESSION_MAX_PROJECTION_PAGE_SIZE,
    RESULT_SESSION_METHODS,
    RESULT_SESSION_PROTOCOL_VERSION,
    type GetResultSessionPageParams,
    type ResultSessionStatus,
    type SetResultSessionViewParams,
    type StartResultSessionParams,
} from '../../features/resultSession';

describe('Result session protocol', () => {
    it('uses stable versioned method names', () => {
        expect(RESULT_SESSION_PROTOCOL_VERSION).toBe(1);
        expect(RESULT_SESSION_MAX_PAGE_SIZE).toBe(1000);
        expect(RESULT_SESSION_MAX_PROJECTION_PAGE_SIZE).toBe(1000);
        expect(RESULT_SESSION_METHODS).toEqual({
            start: 'kusto/startResultSession',
            cancel: 'kusto/cancelResultSessionOperation',
            status: 'kusto/getResultSessionStatus',
            setView: 'kusto/setResultSessionView',
            page: 'kusto/getResultSessionPage',
            projection: 'kusto/getResultSessionProjection',
            dispose: 'kusto/disposeResultSession',
        });
    });

    it('represents an asynchronous query and result-session lifecycle', () => {
        const request: StartResultSessionParams = {
            protocolVersion: RESULT_SESSION_PROTOCOL_VERSION,
            query: 'StormEvents | take 100000',
            cluster: 'help.kusto.windows.net',
            database: 'Samples',
            isReadOnly: true,
            clientRequestId: 'notebook/cell-1',
        };
        const status: ResultSessionStatus = {
            protocolVersion: RESULT_SESSION_PROTOCOL_VERSION,
            operationId: 'operation-1',
            sessionId: 'session-1',
            state: 'materializing',
            tables: [{
                id: 'primary',
                name: 'PrimaryResult',
                columns: [{ name: 'State', type: 'string' }],
                rowsRead: 25000,
                isComplete: false,
            }],
            provenance: {
                query: request.query,
                cluster: request.cluster,
                database: request.database,
                executionStartedAt: '2026-08-28T12:00:00.000Z',
                clientRequestId: request.clientRequestId,
                notebookUri: 'file:///investigation.kqlnb',
                cellId: 'cell-1',
                continuationKind: 'source',
                isStaleSinceSnapshot: false,
            },
        };

        expect(status.state).toBe('materializing');
        expect(status.tables[0]!.rowsRead).toBe(25000);
    });

    it('uses revisions to bind pages to an exact filtered view', () => {
        const view: SetResultSessionViewParams = {
            sessionId: 'session-1',
            tableId: 'primary',
            revision: 7,
            filters: [
                { columnIndex: 0, pattern: '^ERROR', caseSensitive: false },
                { columnIndex: 3, pattern: 'timeout$', caseSensitive: true },
            ],
            sorts: [{ columnIndex: 1, direction: 'descending' }],
        };
        const page: GetResultSessionPageParams = {
            sessionId: view.sessionId,
            tableId: view.tableId,
            viewRevision: view.revision,
            offset: 400,
            count: 200,
        };

        expect(page.viewRevision).toBe(7);
        expect(view.filters).toHaveLength(2);
    });

    it('attributes invalid regex errors to their columns', () => {
        const status: ResultSessionStatus = {
            protocolVersion: RESULT_SESSION_PROTOCOL_VERSION,
            operationId: 'operation-1',
            sessionId: 'session-1',
            state: 'completed',
            tables: [{
                id: 'primary',
                name: 'PrimaryResult',
                columns: [],
                rowsRead: 100_000,
                totalRows: 100_000,
                isComplete: true,
                view: {
                    revision: 9,
                    state: 'failed',
                    filters: [{
                        columnIndex: 3,
                        state: 'invalid',
                        error: { message: 'Unterminated character class' },
                    }],
                },
            }],
        };

        expect(status.tables[0]?.view?.filters?.[0]?.columnIndex).toBe(3);
    });
});
