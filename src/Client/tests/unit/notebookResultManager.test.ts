// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IClipboard } from '../../features/clipboard';
import {
    KUSTO_NOTEBOOK_RESULT_MIME,
    NotebookResultManager,
} from '../../features/notebookResultManager';
import type { ResultSessionStatus } from '../../features/resultSession';
import { NullServer } from '../../features/server';

describe('NotebookResultManager', () => {
    beforeEach(() => {
        vscodeMock().__rendererMessagings.length = 0;
        vscodeMock().__notebookChangeListeners.length = 0;
        vscodeMock().__notebookCloseListeners.length = 0;
    });

    it('starts and polls a session without materializing result rows', async () => {
        const status = createStatus();
        const server = new NullServer();
        server.startResultSession = vi.fn(async () => ({
            protocolVersion: 1,
            operationId: status.operationId,
            sessionId: status.sessionId,
        }));
        server.getResultSessionStatus = vi.fn(async () => status);
        const manager = createManager(server);

        const result = await manager.runQuery(
            'StormEvents | count',
            'help.kusto.windows.net',
            'Samples',
            'request-1',
            createToken(),
        );

        expect(result).toBe(status);
        expect(server.startResultSession).toHaveBeenCalledWith({
            protocolVersion: 1,
            query: 'StormEvents | count',
            cluster: 'help.kusto.windows.net',
            database: 'Samples',
            isReadOnly: true,
            clientRequestId: 'request-1',
        });
        const output = manager.createOutput(status);
        expect(output.items[0]?.mime).toBe(KUSTO_NOTEBOOK_RESULT_MIME);
        expect(output.items[0]?.data).not.toHaveProperty('rows');
    });

    it('keeps only the latest successful session for a cell', async () => {
        const server = new NullServer();
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        const manager = createManager(server);
        const notebook = createNotebook();
        const cell = createCell();

        manager.prepareSession(notebook, cell, 'session-1');
        await manager.adoptSession(notebook, cell, 'session-1');
        manager.prepareSession(notebook, cell, 'session-2');
        await manager.adoptSession(notebook, cell, 'session-2');

        expect(server.disposeResultSession).toHaveBeenCalledOnce();
        expect(server.disposeResultSession).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('validates renderer requests and returns only the requested page', async () => {
        const server = new NullServer();
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        server.getResultSessionPage = vi.fn(async params => ({
            protocolVersion: 1,
            sessionId: params.sessionId,
            tableId: params.tableId,
            viewRevision: params.viewRevision,
            offset: params.offset,
            rows: [{ sourceIndex: 200, values: [200] }],
            viewRows: 100_000,
        }));
        const manager = createManager(server);
        const notebook = createNotebook();
        const cell = createCell();
        manager.prepareSession(notebook, cell, 'session-1');
        const messaging = vscodeMock().__rendererMessagings[0]!;

        messaging.emitter.fire({
            editor: { notebook },
            message: {
                type: 'page',
                requestId: 'page-1',
                outputId: 'output-1',
                sessionId: 'session-1',
                tableId: 'table-1',
                viewRevision: 0,
                offset: 200,
                count: 200,
            },
        });

        await vi.waitFor(() => expect(server.getResultSessionPage).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(messaging.postedMessages).toHaveLength(1));
        expect(server.getResultSessionPage).toHaveBeenCalledWith({
            sessionId: 'session-1',
            tableId: 'table-1',
            viewRevision: 0,
            offset: 200,
            count: 200,
        });
        expect(messaging.postedMessages[0]?.[0]).toMatchObject({
            type: 'pageResult',
            requestId: 'page-1',
            outputId: 'output-1',
        });
    });

    it('applies complete revisioned filter and sort views for the renderer', async () => {
        const server = new NullServer();
        const status = createStatus();
        status.tables[0]!.view = {
            revision: 1,
            state: 'ready',
            matchedRows: 25,
            filters: [{ columnIndex: 0, state: 'valid' }],
        };
        server.setResultSessionView = vi.fn(async () => ({ accepted: true, revision: 1 }));
        server.getResultSessionStatus = vi.fn(async () => status);
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        const manager = createManager(server);
        const notebook = createNotebook();
        const cell = createCell();
        manager.prepareSession(notebook, cell, 'session-1');
        const messaging = vscodeMock().__rendererMessagings[0]!;

        messaging.emitter.fire({
            editor: { notebook },
            message: {
                type: 'setView',
                requestId: 'view-1',
                outputId: 'output-1',
                sessionId: 'session-1',
                tableId: 'table-1',
                viewRevision: 0,
                revision: 1,
                filters: [{
                    columnIndex: 0,
                    pattern: '^4',
                    caseSensitive: false,
                }],
                sorts: [{
                    columnIndex: 0,
                    direction: 'descending',
                }],
            },
        });

        await vi.waitFor(() => expect(server.setResultSessionView).toHaveBeenCalledWith(
            {
                sessionId: 'session-1',
                tableId: 'table-1',
                revision: 1,
                filters: [{
                    columnIndex: 0,
                    pattern: '^4',
                    caseSensitive: false,
                }],
                sorts: [{
                    columnIndex: 0,
                    direction: 'descending',
                }],
            },
            expect.objectContaining({ isCancellationRequested: false }),
        ));
        await vi.waitFor(() => expect(messaging.postedMessages).toHaveLength(1));
        expect(messaging.postedMessages[0]?.[0]).toMatchObject({
            type: 'viewResult',
            requestId: 'view-1',
            status,
        });
    });

    it('returns current status when a copy uses a stale view', async () => {
        const server = new NullServer();
        const status = createStatus();
        status.tables[0]!.view = {
            revision: 1,
            state: 'ready',
            matchedRows: 10,
            readyRevision: 1,
            readyMatchedRows: 10,
            readyFilters: [],
            readySorts: [],
        };
        server.getResultSessionProjection = vi.fn(async () => {
            throw new Error('The requested result view is stale.');
        });
        server.getResultSessionStatus = vi.fn(async () => status);
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        const manager = createManager(server);
        const notebook = createNotebook();
        manager.prepareSession(notebook, createCell(), 'session-1');
        const messaging = vscodeMock().__rendererMessagings[0]!;

        messaging.emitter.fire({
            editor: { notebook },
            message: {
                type: 'copy',
                requestId: 'copy-1',
                outputId: 'output-1',
                sessionId: 'session-1',
                tableId: 'table-1',
                viewRevision: 0,
                rowRanges: [{ offset: 0, count: 1 }],
                columnIndexes: [0],
            },
        });

        await vi.waitFor(() => expect(messaging.postedMessages).toHaveLength(1));
        expect(messaging.postedMessages[0]?.[0]).toMatchObject({
            type: 'requestError',
            requestId: 'copy-1',
            status,
        });
    });

    it('cancels an in-progress filter evaluation', async () => {
        const server = new NullServer();
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        server.setResultSessionView = vi.fn((_params, token) => new Promise((_, reject) => {
            token?.onCancellationRequested(() => reject(new vscode.CancellationError()));
        }));
        const manager = createManager(server);
        const notebook = createNotebook();
        const cell = createCell();
        manager.prepareSession(notebook, cell, 'session-1');
        const messaging = vscodeMock().__rendererMessagings[0]!;
        const common = {
            outputId: 'output-1',
            sessionId: 'session-1',
            tableId: 'table-1',
            viewRevision: 0,
        };
        const editor = { notebook };

        messaging.emitter.fire({
            editor,
            message: {
                ...common,
                type: 'setView',
                requestId: 'view-1',
                revision: 1,
                filters: [{ columnIndex: 0, pattern: 'Error', caseSensitive: false }],
                sorts: [],
            },
        });
        await vi.waitFor(() => expect(server.setResultSessionView).toHaveBeenCalledOnce());
        messaging.emitter.fire({
            editor,
            message: {
                ...common,
                type: 'cancelView',
                requestId: 'cancel-1',
            },
        });

        await vi.waitFor(() => expect(messaging.postedMessages).toHaveLength(2));
        expect(messaging.postedMessages.map(args => args[0])).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'cancelViewResult', accepted: true }),
            expect.objectContaining({ type: 'viewCancelled', requestId: 'view-1' }),
        ]));
    });

    it('returns the ready status when another renderer supersedes a view', async () => {
        const server = new NullServer();
        const status = createStatus();
        status.tables[0]!.view = {
            revision: 2,
            state: 'ready',
            matchedRows: 10,
            readyRevision: 2,
            readyMatchedRows: 10,
            readyFilters: [],
            readySorts: [],
        };
        server.setResultSessionView = vi.fn(async () => ({ accepted: true, revision: 1 }));
        server.getResultSessionStatus = vi.fn(async () => status);
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        const manager = createManager(server);
        const notebook = createNotebook();
        manager.prepareSession(notebook, createCell(), 'session-1');
        const messaging = vscodeMock().__rendererMessagings[0]!;

        messaging.emitter.fire({
            editor: { notebook },
            message: {
                type: 'setView',
                requestId: 'view-1',
                outputId: 'output-1',
                sessionId: 'session-1',
                tableId: 'table-1',
                viewRevision: 0,
                revision: 1,
                filters: [],
                sorts: [],
            },
        });

        await vi.waitFor(() => expect(messaging.postedMessages).toHaveLength(1));
        expect(messaging.postedMessages[0]?.[0]).toMatchObject({
            type: 'requestError',
            requestId: 'view-1',
            status,
        });
    });

    it('disposes sessions when cells are removed and notebooks close', async () => {
        const server = new NullServer();
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        const manager = createManager(server);
        const notebook = createNotebook();
        const first = createCell('cell-1');
        const second = createCell('cell-2');
        manager.prepareSession(notebook, first, 'session-1');
        await manager.adoptSession(notebook, first, 'session-1');
        manager.prepareSession(notebook, second, 'session-2');
        await manager.adoptSession(notebook, second, 'session-2');

        vscodeMock().__notebookChangeListeners[0]?.({
            notebook,
            contentChanges: [{ addedCells: [], removedCells: [first] }],
            cellChanges: [],
        });
        await vi.waitFor(() => expect(server.disposeResultSession).toHaveBeenCalledWith({ sessionId: 'session-1' }));

        vscodeMock().__notebookCloseListeners[0]?.(notebook);
        await vi.waitFor(() => expect(server.disposeResultSession).toHaveBeenCalledWith({ sessionId: 'session-2' }));
    });

    it('disposes a session when its cell output is cleared', async () => {
        const server = new NullServer();
        server.disposeResultSession = vi.fn(async () => ({ disposed: true }));
        const manager = createManager(server);
        const notebook = createNotebook();
        const cell = createCell();
        manager.prepareSession(notebook, cell, 'session-1');
        await manager.adoptSession(notebook, cell, 'session-1');

        vscodeMock().__notebookChangeListeners[0]?.({
            notebook,
            contentChanges: [],
            cellChanges: [{ cell, outputs: [] }],
        });

        await vi.waitFor(() => expect(server.disposeResultSession).toHaveBeenCalledWith({
            sessionId: 'session-1',
        }));
    });
});

function createManager(server: NullServer): NotebookResultManager {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const clipboard = {
        copyText: vi.fn(async () => undefined),
    } as unknown as IClipboard;
    return new NotebookResultManager(context, server, clipboard);
}

function createStatus(): ResultSessionStatus {
    return {
        protocolVersion: 1,
        operationId: 'operation-1',
        sessionId: 'session-1',
        state: 'completed',
        tables: [{
            id: 'table-1',
            name: 'PrimaryResult',
            columns: [{ name: 'Count', type: 'long' }],
            rowsRead: 100_000,
            totalRows: 100_000,
            isComplete: true,
        }],
        provenance: {
            query: 'StormEvents | count',
            cluster: 'help.kusto.windows.net',
            database: 'Samples',
            executionStartedAt: new Date(0).toISOString(),
        },
    };
}

function createToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
    } as vscode.CancellationToken;
}

function createNotebook(): vscode.NotebookDocument {
    return {
        uri: vscode.Uri.parse('file:///investigation.kqlnb'),
        notebookType: 'msKustoExplorer.kqlNotebook',
    } as vscode.NotebookDocument;
}

function createCell(id: string = 'cell-1'): vscode.NotebookCell {
    return {
        document: {
            uri: vscode.Uri.parse(`vscode-notebook-cell:///investigation.kqlnb#${id}`),
        },
    } as vscode.NotebookCell;
}

interface MockVscode {
    __rendererMessagings: Array<{
        emitter: vscode.EventEmitter<{ editor: { notebook: vscode.NotebookDocument }; message: unknown }>;
        postedMessages: unknown[][];
    }>;
    __notebookChangeListeners: Array<(event: unknown) => void>;
    __notebookCloseListeners: Array<(notebook: vscode.NotebookDocument) => void>;
}

function vscodeMock(): MockVscode {
    return vscode as unknown as MockVscode;
}
