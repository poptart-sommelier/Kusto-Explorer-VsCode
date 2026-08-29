// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KustoNotebookController } from '../../features/kustoNotebookController';
import type { ConnectionManager } from '../../features/connectionManager';
import type { KustoNotebookManager } from '../../features/kustoNotebookManager';
import { NOTEBOOK_PHASE_TWO_MAX_ROWS } from '../../features/kustoNotebookManager';
import { NullServer, type IServer, type RunQueryResult } from '../../features/server';

interface MockExecution {
    executionOrder?: number;
    token: vscode.CancellationToken;
    start: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    clearOutput: ReturnType<typeof vi.fn>;
    replaceOutput: ReturnType<typeof vi.fn>;
}

describe('KustoNotebookController', () => {
    beforeEach(() => {
        const controllers = (vscode as unknown as {
            __notebookControllers: unknown[];
        }).__notebookControllers;
        controllers.length = 0;
    });

    it('runs KQL through the existing server with temporary safety limits', async () => {
        const result: RunQueryResult = {
            data: {
                tables: [{
                    name: 'PrimaryResult',
                    columns: [{ name: 'Value', type: 'long' }],
                    rows: [[1], [2]],
                }],
            },
        };
        const runQuery = vi.fn(async () => result);
        const server = new NullServer();
        server.runQuery = runQuery;
        const execution = createExecution(false);
        const controller = createController(server, execution);
        const cell = createCell('range x from 1 to 2 step 1');
        const notebook = createNotebook();

        await invokeExecuteHandler(controller, cell, notebook);

        expect(runQuery).toHaveBeenCalledWith(
            'range x from 1 to 2 step 1',
            'help.kusto.windows.net',
            'Samples',
            true,
            NOTEBOOK_PHASE_TWO_MAX_ROWS,
            expect.stringMatching(/^KustoExplorerVsCode;/),
            NOTEBOOK_PHASE_TWO_MAX_ROWS,
            execution.token,
        );
        expect(execution.replaceOutput).toHaveBeenCalled();
        const outputs = execution.replaceOutput.mock.calls[0]?.[0] as vscode.NotebookCellOutput[];
        expect(outputs[0]?.items[0]?.data).toContain('temporarily limited');
        expect(outputs[1]?.items[0]?.data).toContain('PrimaryResult');
        expect(execution.end).toHaveBeenCalledWith(true, expect.any(Number));
    });

    it('does not call the server when execution is already cancelled', async () => {
        const runQuery = vi.fn(async () => null);
        const server = new NullServer();
        server.runQuery = runQuery;
        const execution = createExecution(true);
        const controller = createController(server, execution);

        await invokeExecuteHandler(
            controller,
            createCell('print 1'),
            createNotebook(),
        );

        expect(runQuery).not.toHaveBeenCalled();
        expect(execution.end).toHaveBeenCalledWith(undefined, expect.any(Number));
    });

    it('renders server diagnostics as failed cell output', async () => {
        const server = new NullServer();
        server.runQuery = async () => ({
            error: { message: 'Bad query', details: 'Unexpected token' },
        });
        const execution = createExecution(false);
        const controller = createController(server, execution);

        await invokeExecuteHandler(
            controller,
            createCell('bad query'),
            createNotebook(),
        );

        const output = execution.replaceOutput.mock.calls[0]?.[0] as vscode.NotebookCellOutput;
        expect(output.items[0]?.mime).toBe('application/vnd.code.notebook.error');
        expect(execution.end).toHaveBeenCalledWith(false, expect.any(Number));
    });

    it('stops sequential execution after a failed cell', async () => {
        const runQuery = vi.fn()
            .mockResolvedValueOnce({ error: { message: 'First cell failed' } })
            .mockResolvedValueOnce({ data: { tables: [] } });
        const server = new NullServer();
        server.runQuery = runQuery;
        const executions = [createExecution(false), createExecution(false)];
        const controller = createController(server, executions);

        await invokeExecuteHandler(
            controller,
            [createCell('bad query'), createCell('print 2')],
            createNotebook(),
        );

        expect(runQuery).toHaveBeenCalledOnce();
        expect(executions[1]?.start).not.toHaveBeenCalled();
    });

    it('uses a database directive result for the next cell', async () => {
        const runQuery = vi.fn()
            .mockResolvedValueOnce({ database: 'OtherDatabase' })
            .mockResolvedValueOnce({ data: { tables: [] } });
        const server = new NullServer();
        server.runQuery = runQuery;
        const controller = createController(
            server,
            [createExecution(false), createExecution(false)],
        );

        await invokeExecuteHandler(
            controller,
            [createCell('#database OtherDatabase'), createCell('print 2')],
            createNotebook(),
        );

        expect(runQuery.mock.calls[1]?.[2]).toBe('OtherDatabase');
    });

    it('serializes separate execution gestures for the same notebook', async () => {
        let releaseFirst!: (value: RunQueryResult) => void;
        const firstResult = new Promise<RunQueryResult>(resolve => {
            releaseFirst = resolve;
        });
        const runQuery = vi.fn()
            .mockImplementationOnce(() => firstResult)
            .mockResolvedValueOnce({ data: { tables: [] } });
        const server = new NullServer();
        server.runQuery = runQuery;
        const controller = createController(
            server,
            [createExecution(false), createExecution(false)],
        );
        const notebook = createNotebook();

        const first = invokeExecuteHandler(controller, createCell('print 1'), notebook);
        await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
        const second = invokeExecuteHandler(controller, createCell('print 2'), notebook);
        await Promise.resolve();
        expect(runQuery).toHaveBeenCalledOnce();

        releaseFirst({ data: { tables: [] } });
        await Promise.all([first, second]);
        expect(runQuery).toHaveBeenCalledTimes(2);
    });
});

function createController(
    server: IServer,
    execution: MockExecution | MockExecution[],
): Record<string, unknown> {
    const connections = {
        ensureServer: vi.fn(async () => undefined),
        findServerInfo: vi.fn(() => undefined),
        getServersAndGroups: vi.fn(() => ({ items: [] })),
        getDatabasesForCluster: vi.fn(async () => []),
    } as unknown as ConnectionManager;
    const manager = {
        getConnection: vi.fn(() => ({
            cluster: 'help.kusto.windows.net',
            database: 'Samples',
        })),
        synchronizeConnection: vi.fn(async () => undefined),
        setConnection: vi.fn(async () => undefined),
    } as unknown as KustoNotebookManager;
    new KustoNotebookController(server, connections, manager);

    const controllers = (vscode as unknown as {
        __notebookControllers: Array<Record<string, unknown>>;
    }).__notebookControllers;
    const controller = controllers[0]!;
    const executions = Array.isArray(execution) ? [...execution] : [execution];
    controller.createNotebookCellExecution = () => executions.shift()!;
    return controller;
}

function createExecution(cancelled: boolean): MockExecution {
    return {
        token: { isCancellationRequested: cancelled } as vscode.CancellationToken,
        start: vi.fn(),
        end: vi.fn(),
        clearOutput: vi.fn(async () => undefined),
        replaceOutput: vi.fn(async () => undefined),
    };
}

function createCell(text: string): vscode.NotebookCell {
    return {
        kind: vscode.NotebookCellKind.Code,
        document: {
            languageId: 'kusto',
            getText: () => text,
            uri: vscode.Uri.parse('vscode-notebook-cell:///investigation.kqlnb#cell-1'),
        },
    } as unknown as vscode.NotebookCell;
}

function createNotebook(): vscode.NotebookDocument {
    return {
        notebookType: 'msKustoExplorer.kqlNotebook',
        metadata: {
            connection: {
                cluster: 'help.kusto.windows.net',
                database: 'Samples',
            },
        },
        uri: vscode.Uri.parse('file:///investigation.kqlnb'),
        getCells: () => [],
    } as unknown as vscode.NotebookDocument;
}

async function invokeExecuteHandler(
    controller: Record<string, unknown>,
    cells: vscode.NotebookCell | vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
): Promise<void> {
    const handler = controller.executeHandler as (
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
        controller: unknown,
    ) => Promise<void>;
    await handler(Array.isArray(cells) ? cells : [cells], notebook, controller);
}
