// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KustoNotebookController } from '../../features/kustoNotebookController';
import type { ConnectionManager } from '../../features/connectionManager';
import type { KustoNotebookManager } from '../../features/kustoNotebookManager';
import {
    KUSTO_NOTEBOOK_RESULT_MIME,
    type NotebookResultManager,
} from '../../features/notebookResultManager';
import type { ResultSessionStatus } from '../../features/resultSession';

interface MockExecution {
    executionOrder?: number;
    token: vscode.CancellationToken;
    start: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    clearOutput: ReturnType<typeof vi.fn>;
    appendOutput: ReturnType<typeof vi.fn>;
    replaceOutput: ReturnType<typeof vi.fn>;
}

describe('KustoNotebookController', () => {
    beforeEach(() => {
        const controllers = (vscode as unknown as {
            __notebookControllers: unknown[];
        }).__notebookControllers;
        controllers.length = 0;
    });

    it('runs KQL as a result session and emits renderer metadata', async () => {
        const status = createStatus();
        const runQuery = vi.fn(async () => status);
        const execution = createExecution(false);
        const resultManager = createResultManager(runQuery);
        const controller = createController(resultManager, execution);
        const cell = createCell('range x from 1 to 2 step 1');
        const notebook = createNotebook();

        await invokeExecuteHandler(controller, cell, notebook);

        expect(runQuery).toHaveBeenCalledWith(
            'range x from 1 to 2 step 1',
            'help.kusto.windows.net',
            'Samples',
            expect.stringMatching(/^KustoExplorerVsCode;/),
            execution.token,
        );
        expect(execution.clearOutput).not.toHaveBeenCalled();
        const output = execution.replaceOutput.mock.calls[0]?.[0] as vscode.NotebookCellOutput;
        expect(output.items[0]?.mime).toBe(KUSTO_NOTEBOOK_RESULT_MIME);
        expect(resultManager.prepareSession).toHaveBeenCalledWith(notebook, cell, status.sessionId);
        expect(resultManager.adoptSession).toHaveBeenCalledWith(notebook, cell, status.sessionId);
        expect(execution.end).toHaveBeenCalledWith(true, expect.any(Number));
    });

    it('does not start a session when execution is already cancelled', async () => {
        const runQuery = vi.fn(async () => createStatus());
        const execution = createExecution(true);
        const controller = createController(createResultManager(runQuery), execution);

        await invokeExecuteHandler(controller, createCell('print 1'), createNotebook());

        expect(runQuery).not.toHaveBeenCalled();
        expect(execution.end).toHaveBeenCalledWith(undefined, expect.any(Number));
    });

    it('appends a diagnostic without replacing previous results', async () => {
        const runQuery = vi.fn(async () => {
            throw new Error('Unexpected token');
        });
        const execution = createExecution(false);
        const controller = createController(createResultManager(runQuery), execution);

        await invokeExecuteHandler(controller, createCell('bad query'), createNotebook());

        expect(execution.replaceOutput).not.toHaveBeenCalled();
        const output = execution.appendOutput.mock.calls[0]?.[0] as vscode.NotebookCellOutput;
        expect(output.items[0]?.mime).toBe('application/vnd.code.notebook.error');
        expect(execution.end).toHaveBeenCalledWith(false, expect.any(Number));
    });

    it('stops sequential execution after a failed cell', async () => {
        const runQuery = vi.fn()
            .mockRejectedValueOnce(new Error('First cell failed'))
            .mockResolvedValueOnce(createStatus());
        const executions = [createExecution(false), createExecution(false)];
        const controller = createController(createResultManager(runQuery), executions);

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
            .mockResolvedValueOnce(createStatus({ database: 'OtherDatabase', tables: [] }))
            .mockResolvedValueOnce(createStatus());
        const controller = createController(
            createResultManager(runQuery),
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
        let releaseFirst!: (value: ResultSessionStatus) => void;
        const firstResult = new Promise<ResultSessionStatus>(resolve => {
            releaseFirst = resolve;
        });
        const runQuery = vi.fn()
            .mockImplementationOnce(() => firstResult)
            .mockResolvedValueOnce(createStatus());
        const controller = createController(
            createResultManager(runQuery),
            [createExecution(false), createExecution(false)],
        );
        const notebook = createNotebook();

        const first = invokeExecuteHandler(controller, createCell('print 1'), notebook);
        await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
        const second = invokeExecuteHandler(controller, createCell('print 2'), notebook);
        await Promise.resolve();
        expect(runQuery).toHaveBeenCalledOnce();

        releaseFirst(createStatus());
        await Promise.all([first, second]);
        expect(runQuery).toHaveBeenCalledTimes(2);
    });

    it('disposes a completed session that has no result tables', async () => {
        const status = createStatus({ tables: [] });
        const resultManager = createResultManager(vi.fn(async () => status));
        const execution = createExecution(false);
        const controller = createController(resultManager, execution);
        const cell = createCell('#database Samples');

        await invokeExecuteHandler(controller, cell, createNotebook());

        expect(resultManager.disposeSession).toHaveBeenCalledWith(status.sessionId);
        expect(resultManager.releaseCellSession).toHaveBeenCalledWith(cell);
    });

    it('disposes a prepared replacement when publishing its output fails', async () => {
        const status = createStatus();
        const resultManager = createResultManager(vi.fn(async () => status));
        const execution = createExecution(false);
        execution.replaceOutput.mockRejectedValueOnce(new Error('output closed'));
        const controller = createController(resultManager, execution);

        await invokeExecuteHandler(controller, createCell('print 1'), createNotebook());

        expect(resultManager.prepareSession).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            status.sessionId,
        );
        expect(resultManager.adoptSession).not.toHaveBeenCalled();
        expect(resultManager.disposeSession).toHaveBeenCalledWith(status.sessionId);
        expect(execution.end).toHaveBeenCalledWith(false, expect.any(Number));
    });
});

function createController(
    resultManager: NotebookResultManager,
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
    new KustoNotebookController(connections, manager, resultManager);

    const controllers = (vscode as unknown as {
        __notebookControllers: Array<Record<string, unknown>>;
    }).__notebookControllers;
    const controller = controllers[0]!;
    const executions = Array.isArray(execution) ? [...execution] : [execution];
    controller.createNotebookCellExecution = () => executions.shift()!;
    return controller;
}

function createResultManager(
    runQuery: (...args: Parameters<NotebookResultManager['runQuery']>) => Promise<ResultSessionStatus>,
): NotebookResultManager {
    return {
        runQuery: vi.fn(runQuery),
        createOutput: vi.fn((status: ResultSessionStatus) => new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
                { sessionId: status.sessionId, tables: status.tables },
                KUSTO_NOTEBOOK_RESULT_MIME,
            ),
        ])),
        prepareSession: vi.fn(),
        adoptSession: vi.fn(async () => undefined),
        disposeSession: vi.fn(async () => undefined),
        releaseCellSession: vi.fn(async () => undefined),
        dispose: vi.fn(),
    } as unknown as NotebookResultManager;
}

function createStatus(
    options: { database?: string; tables?: ResultSessionStatus['tables'] } = {},
): ResultSessionStatus {
    return {
        protocolVersion: 1,
        operationId: 'operation-1',
        sessionId: 'session-1',
        state: 'completed',
        tables: options.tables ?? [{
            id: 'table-1',
            name: 'PrimaryResult',
            columns: [{ name: 'Value', type: 'long' }],
            rowsRead: 2,
            totalRows: 2,
            isComplete: true,
        }],
        provenance: {
            query: 'print Value = 1',
            cluster: 'help.kusto.windows.net',
            database: options.database ?? 'Samples',
            executionStartedAt: new Date(0).toISOString(),
        },
    };
}

function createExecution(cancelled: boolean): MockExecution {
    return {
        token: {
            isCancellationRequested: cancelled,
            onCancellationRequested: () => ({ dispose: () => undefined }),
        } as vscode.CancellationToken,
        start: vi.fn(),
        end: vi.fn(),
        clearOutput: vi.fn(async () => undefined),
        appendOutput: vi.fn(async () => undefined),
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
