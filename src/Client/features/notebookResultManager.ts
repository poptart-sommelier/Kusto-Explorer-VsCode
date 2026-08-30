// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import type { IClipboard } from './clipboard';
import type { KustoNotebookManager } from './kustoNotebookManager';
import {
    RESULT_SESSION_MAX_PAGE_SIZE,
    RESULT_SESSION_MAX_PROJECTION_PAGE_SIZE,
    RESULT_SESSION_PROTOCOL_VERSION,
    type ResultSessionColumnFilter,
    type ResultSessionColumnSort,
    type ResultSessionProjectionScope,
    type ResultSessionRowRange,
    type ResultSessionStatus,
} from './resultSession';
import type { IServer } from './server';
import { escapeTsv, formatCellValue } from './tsv';

export const KUSTO_NOTEBOOK_RESULT_MIME = 'application/vnd.ms-kusto.result-session+json';
export const KUSTO_NOTEBOOK_RESULT_RENDERER_ID = 'msKustoExplorer.kqlNotebookResultRenderer';

const STATUS_POLL_INTERVAL_MS = 100;
const MAX_COPY_ROWS = 100_000;
const MAX_COPY_CHARACTERS = 10_000_000;
const LARGE_SNAPSHOT_WARNING_ROWS = 1_000;
const LARGE_SNAPSHOT_WARNING_BYTES = 48 * 1_024;

interface ActiveResultSession {
    notebookUri: string;
    sessionId: string;
}

interface RendererRequest {
    type: 'page' | 'setView' | 'cancelView' | 'copy' | 'continue';
    requestId: string;
    outputId: string;
    sessionId: string;
    tableId: string;
    viewRevision: number;
}

interface PageRequest extends RendererRequest {
    type: 'page';
    offset: number;
    count: number;
}

interface ViewRequest extends RendererRequest {
    type: 'setView';
    revision: number;
    filters: ResultSessionColumnFilter[];
    sorts: ResultSessionColumnSort[];
}

interface CancelViewRequest extends RendererRequest {
    type: 'cancelView';
}

interface CopyRequest extends RendererRequest {
    type: 'copy';
    rowRanges: Array<{ offset: number; count: number }>;
    columnIndexes: number[];
}

interface ContinueRequest extends RendererRequest {
    type: 'continue';
    scope: ResultSessionProjectionScope;
    rowRanges?: ResultSessionRowRange[];
    columnIndexes: number[];
}

export class NotebookResultManager implements vscode.Disposable {
    private readonly messaging: vscode.NotebookRendererMessaging;
    private readonly disposables: vscode.Disposable[];
    private readonly sessionsByCell = new Map<string, ActiveResultSession>();
    private readonly pendingSessionsByCell = new Map<string, ActiveResultSession>();
    private readonly viewCancellations = new Map<string, vscode.CancellationTokenSource>();
    private readonly rendererIds = new WeakMap<vscode.NotebookEditor, number>();
    private nextRendererId = 0;

    constructor(
        context: vscode.ExtensionContext,
        private readonly server: IServer,
        private readonly clipboard: IClipboard,
        private readonly notebookManager: KustoNotebookManager,
    ) {
        this.messaging = vscode.notebooks.createRendererMessaging(KUSTO_NOTEBOOK_RESULT_RENDERER_ID);
        this.disposables = [
            this.messaging.onDidReceiveMessage(event => {
                void this.handleRendererMessage(event).catch(error => {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Kusto result grid: ${message}`);
                });
            }),
            vscode.workspace.onDidChangeNotebookDocument(event => {
                for (const change of event.contentChanges) {
                    for (const cell of change.removedCells) {
                        this.releaseCell(cell);
                    }
                }
                for (const change of event.cellChanges) {
                    if (change.outputs !== undefined
                        && !change.outputs.some(output => output.items.some(
                            item => item.mime === KUSTO_NOTEBOOK_RESULT_MIME))) {
                        this.releaseCell(change.cell);
                    }
                }
            }),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                this.releaseNotebook(notebook);
            }),
        ];
        context.subscriptions.push(this);
    }

    async runQuery(
        query: string,
        cluster: string,
        database: string | undefined,
        clientRequestId: string,
        token: vscode.CancellationToken,
    ): Promise<ResultSessionStatus> {
        const started = await this.server.startResultSession({
            protocolVersion: RESULT_SESSION_PROTOCOL_VERSION,
            query,
            cluster,
            ...(database ? { database } : {}),
            isReadOnly: true,
            clientRequestId,
        });

        let cancelled = false;
        const cancellation = token.onCancellationRequested(() => {
            cancelled = true;
            void this.server.cancelResultSessionOperation({ operationId: started.operationId }).catch(error => {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showWarningMessage(`Failed to cancel a Kusto query: ${message}`);
            });
        });
        let releaseRequested = false;
        const release = async () => {
            if (releaseRequested) {
                return;
            }
            releaseRequested = true;
            try {
                await this.server.disposeResultSession({ sessionId: started.sessionId });
            } catch (error) {
                this.reportCleanupError(error);
            }
        };

        try {
            while (true) {
                if (cancelled || token.isCancellationRequested) {
                    await this.server.cancelResultSessionOperation({ operationId: started.operationId });
                    await release();
                    throw new vscode.CancellationError();
                }

                const status = await this.server.getResultSessionStatus({ sessionId: started.sessionId });
                if (status.state === 'completed') {
                    return status;
                }
                if (status.state === 'failed') {
                    await release();
                    throw new Error(status.error?.details ?? status.error?.message ?? 'Query failed.');
                }
                if (status.state === 'cancelled' || status.state === 'disposed') {
                    await release();
                    throw new vscode.CancellationError();
                }
                await delay(STATUS_POLL_INTERVAL_MS);
            }
        } catch (error) {
            await release();
            throw error;
        } finally {
            cancellation.dispose();
        }
    }

    createOutput(status: ResultSessionStatus): vscode.NotebookCellOutput {
        return new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json({
                protocolVersion: RESULT_SESSION_PROTOCOL_VERSION,
                sessionId: status.sessionId,
                tables: status.tables,
            }, KUSTO_NOTEBOOK_RESULT_MIME),
        ]);
    }

    async adoptSession(
        notebook: vscode.NotebookDocument,
        cell: vscode.NotebookCell,
        sessionId: string,
    ): Promise<void> {
        const key = cell.document.uri.toString();
        const previous = this.sessionsByCell.get(key);
        const pending = this.pendingSessionsByCell.get(key);
        if (pending?.sessionId !== sessionId) {
            throw new Error('The replacement result session was not prepared.');
        }
        this.pendingSessionsByCell.delete(key);
        this.sessionsByCell.set(key, {
            notebookUri: notebook.uri.toString(),
            sessionId,
        });
        if (previous && previous.sessionId !== sessionId) {
            try {
                await this.server.disposeResultSession({ sessionId: previous.sessionId });
            } catch (error) {
                this.reportCleanupError(error);
            }
        }
    }

    prepareSession(
        notebook: vscode.NotebookDocument,
        cell: vscode.NotebookCell,
        sessionId: string,
    ): void {
        const key = cell.document.uri.toString();
        if (this.pendingSessionsByCell.has(key)) {
            throw new Error('A replacement result session is already pending for this cell.');
        }
        this.pendingSessionsByCell.set(key, {
            notebookUri: notebook.uri.toString(),
            sessionId,
        });
    }

    async disposeSession(sessionId: string): Promise<void> {
        this.cancelViewsForSession(sessionId);
        for (const [cellUri, session] of this.sessionsByCell) {
            if (session.sessionId === sessionId) {
                this.sessionsByCell.delete(cellUri);
            }
        }
        for (const [cellUri, session] of this.pendingSessionsByCell) {
            if (session.sessionId === sessionId) {
                this.pendingSessionsByCell.delete(cellUri);
            }
        }
        try {
            await this.server.disposeResultSession({ sessionId });
        } catch (error) {
            this.reportCleanupError(error);
        }
    }

    async releaseCellSession(cell: vscode.NotebookCell): Promise<void> {
        const key = cell.document.uri.toString();
        const sessions = [
            this.sessionsByCell.get(key),
            this.pendingSessionsByCell.get(key),
        ].filter((session): session is ActiveResultSession => session !== undefined);
        this.sessionsByCell.delete(key);
        this.pendingSessionsByCell.delete(key);
        await Promise.all([...new Set(sessions.map(session => session.sessionId))]
            .map(sessionId => this.disposeSession(sessionId)));
    }

    dispose(): void {
        this.disposables.splice(0).forEach(disposable => disposable.dispose());
        const sessionIds = [...new Set([
            ...this.sessionsByCell.values(),
            ...this.pendingSessionsByCell.values(),
        ].map(value => value.sessionId))];
        this.sessionsByCell.clear();
        this.pendingSessionsByCell.clear();
        for (const cancellation of this.viewCancellations.values()) {
            cancellation.cancel();
            cancellation.dispose();
        }
        this.viewCancellations.clear();
        for (const sessionId of sessionIds) {
            this.disposeInBackground(sessionId);
        }
    }

    private releaseCell(cell: vscode.NotebookCell): void {
        const key = cell.document.uri.toString();
        const sessions = [
            this.sessionsByCell.get(key),
            this.pendingSessionsByCell.get(key),
        ].filter((session): session is ActiveResultSession => session !== undefined);
        this.sessionsByCell.delete(key);
        this.pendingSessionsByCell.delete(key);
        for (const sessionId of new Set(sessions.map(session => session.sessionId))) {
            this.disposeInBackground(sessionId);
        }
    }

    private releaseNotebook(notebook: vscode.NotebookDocument): void {
        const notebookUri = notebook.uri.toString();
        for (const sessions of [this.sessionsByCell, this.pendingSessionsByCell]) {
            for (const [cellUri, session] of sessions) {
                if (session.notebookUri === notebookUri) {
                    sessions.delete(cellUri);
                    this.disposeInBackground(session.sessionId);
                }
            }
        }
    }

    private disposeInBackground(sessionId: string): void {
        this.cancelViewsForSession(sessionId);
        void this.server.disposeResultSession({ sessionId }).catch(error => {
            this.reportCleanupError(error);
        });
    }

    private reportCleanupError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`Failed to release a Kusto result session: ${message}`);
    }

    private cancelViewsForSession(sessionId: string): void {
        const prefix = `${sessionId}\0`;
        for (const [key, cancellation] of this.viewCancellations) {
            if (key.startsWith(prefix)) {
                cancellation.cancel();
                this.viewCancellations.delete(key);
            }
        }
    }

    private async handleRendererMessage(
        event: { editor: vscode.NotebookEditor; message: unknown },
    ): Promise<void> {
        const request = parseRendererRequest(event.message);
        if (!request) {
            return;
        }

        let viewAccepted = false;
        let viewCancellation: vscode.CancellationTokenSource | undefined;
        try {
            this.assertActiveSession(event.editor.notebook, request.sessionId);
            if (request.type === 'page') {
                const page = await this.server.getResultSessionPage({
                    sessionId: request.sessionId,
                    tableId: request.tableId,
                    viewRevision: request.viewRevision,
                    offset: request.offset,
                    count: request.count,
                });
                await this.reply(event.editor, request, { type: 'pageResult', page });
            } else if (request.type === 'cancelView') {
                const cancellation = this.viewCancellations
                    .get(viewCancellationKey(
                        request.sessionId,
                        request.tableId,
                        request.outputId,
                        this.getRendererId(event.editor),
                    ));
                const accepted = cancellation !== undefined;
                cancellation?.cancel();
                await this.reply(event.editor, request, { type: 'cancelViewResult', accepted });
            } else if (request.type === 'setView') {
                const viewKey = viewCancellationKey(
                    request.sessionId,
                    request.tableId,
                    request.outputId,
                    this.getRendererId(event.editor),
                );
                viewCancellation = new vscode.CancellationTokenSource();
                this.viewCancellations.set(viewKey, viewCancellation);
                try {
                    const result = await this.server.setResultSessionView({
                        sessionId: request.sessionId,
                        tableId: request.tableId,
                        revision: request.revision,
                        filters: request.filters,
                        sorts: request.sorts,
                    }, viewCancellation.token);
                    if (!result.accepted) {
                        const status = await this.server.getResultSessionStatus({
                            sessionId: request.sessionId,
                        });
                        await this.reply(event.editor, request, {
                            type: 'viewRejected',
                            revision: result.revision,
                            status,
                        });
                        return;
                    }
                    viewAccepted = true;
                    const status = await this.waitForView(
                        request.sessionId,
                        request.tableId,
                        request.revision,
                        viewCancellation.token,
                    );
                    await this.reply(event.editor, request, { type: 'viewResult', status });
                } finally {
                    if (this.viewCancellations.get(viewKey) === viewCancellation) {
                        this.viewCancellations.delete(viewKey);
                    }
                    viewCancellation.dispose();
                }
            } else if (request.type === 'copy') {
                const copiedRows = await this.copyProjection(request);
                await this.reply(event.editor, request, { type: 'copyResult', copiedRows });
            } else {
                const kind = await this.continueInNewCell(event.editor, request);
                await this.reply(event.editor, request, kind
                    ? { type: 'continuationResult', kind }
                    : { type: 'continuationCancelled' });
            }
        } catch (error) {
            if (request.type === 'setView'
                && (error instanceof vscode.CancellationError
                    || viewCancellation?.token.isCancellationRequested)) {
                let status: ResultSessionStatus | undefined;
                try {
                    status = await this.server.getResultSessionStatus({
                        sessionId: request.sessionId,
                    });
                } catch (statusError) {
                    const statusMessage = statusError instanceof Error
                        ? statusError.message
                        : String(statusError);
                    void vscode.window.showWarningMessage(
                        `Could not read the cancelled Kusto result view: ${statusMessage}`,
                    );
                }
                await this.reply(event.editor, request, {
                    type: 'viewCancelled',
                    ...(status ? { status } : {}),
                });
                return;
            }
            let message = error instanceof Error ? error.message : String(error);
            let status: ResultSessionStatus | undefined;
            if (request.type === 'setView' && viewAccepted) {
                try {
                    status = await this.server.getResultSessionStatus({
                        sessionId: request.sessionId,
                    });
                    const table = status.tables.find(candidate => candidate.id === request.tableId);
                    if (table?.view?.revision === request.revision
                        && (table.view.state === 'ready' || table.view.state === 'failed')) {
                        await this.reply(event.editor, request, { type: 'viewResult', status });
                        return;
                    }
                } catch (recoveryError) {
                    const recoveryMessage = recoveryError instanceof Error
                        ? recoveryError.message
                        : String(recoveryError);
                    message = `${message} The current result view could not be recovered: ${recoveryMessage}`;
                }
            }
            if (request.type === 'page'
                || request.type === 'copy'
                || request.type === 'continue') {
                try {
                    status = await this.server.getResultSessionStatus({
                        sessionId: request.sessionId,
                    });
                } catch (statusError) {
                    const statusMessage = statusError instanceof Error
                        ? statusError.message
                        : String(statusError);
                    message = `${message} The current result view could not be read: ${statusMessage}`;
                }
            }
            await this.reply(event.editor, request, {
                type: 'requestError',
                message,
                ...(status ? { status } : {}),
            });
        }
    }

    private assertActiveSession(notebook: vscode.NotebookDocument, sessionId: string): void {
        const notebookUri = notebook.uri.toString();
        const active = [
            ...this.sessionsByCell.values(),
            ...this.pendingSessionsByCell.values(),
        ].some(session =>
            session.notebookUri === notebookUri && session.sessionId === sessionId);
        if (!active) {
            throw new Error('This result session is no longer active.');
        }
    }

    private getRendererId(editor: vscode.NotebookEditor): number {
        let id = this.rendererIds.get(editor);
        if (id === undefined) {
            id = ++this.nextRendererId;
            this.rendererIds.set(editor, id);
        }
        return id;
    }

    private async waitForView(
        sessionId: string,
        tableId: string,
        revision: number,
        token: vscode.CancellationToken,
    ): Promise<ResultSessionStatus> {
        while (true) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const status = await this.server.getResultSessionStatus({ sessionId });
            const table = status.tables.find(candidate => candidate.id === tableId);
            if (!table) {
                throw new Error('The selected result table no longer exists.');
            }
            if (table.view?.revision === revision && table.view.state === 'ready') {
                return status;
            }
            if (table.view?.revision === revision && table.view.state === 'failed') {
                return status;
            }
            if (table.view && table.view.revision > revision) {
                throw new Error('The result view was replaced by a newer filter or sort.');
            }
            if (status.state !== 'completed') {
                throw new Error(status.error?.message ?? 'The result session is no longer available.');
            }
            await delay(STATUS_POLL_INTERVAL_MS);
        }
    }

    private async copyProjection(request: CopyRequest): Promise<number> {
        const requestedRows = request.rowRanges.reduce((total, range) => total + range.count, 0);
        if (requestedRows < 1 || requestedRows > MAX_COPY_ROWS) {
            throw new Error(`Select between 1 and ${MAX_COPY_ROWS.toLocaleString()} rows to copy.`);
        }
        if (request.columnIndexes.length < 1) {
            throw new Error('Select at least one column to copy.');
        }

        let offset = 0;
        let copiedRows = 0;
        let columns: Array<{ name: string }> = [];
        const lines: string[] = [];
        let characterCount = 0;
        while (true) {
            const projection = await this.server.getResultSessionProjection({
                sessionId: request.sessionId,
                tableId: request.tableId,
                viewRevision: request.viewRevision,
                scope: 'selection',
                rowRanges: request.rowRanges,
                columnIndexes: request.columnIndexes,
                offset,
                count: RESULT_SESSION_MAX_PROJECTION_PAGE_SIZE,
            });
            if (columns.length === 0) {
                columns = projection.columns;
            }
            for (const row of projection.rows) {
                const line = row.values.map(value => escapeTsv(formatCellValue(value))).join('\t');
                characterCount += line.length + 1;
                if (characterCount > MAX_COPY_CHARACTERS) {
                    throw new Error('The selection is too large to copy safely. Select fewer rows or columns.');
                }
                lines.push(line);
            }
            copiedRows += projection.rows.length;
            if (!projection.hasMore) {
                break;
            }
            offset += projection.rows.length;
        }

        const isSingleCell = copiedRows === 1 && columns.length === 1;
        if (!isSingleCell) {
            const header = columns.map(column => escapeTsv(column.name)).join('\t');
            if (characterCount + header.length + 1 > MAX_COPY_CHARACTERS) {
                throw new Error('The selection is too large to copy safely. Select fewer rows or columns.');
            }
            lines.unshift(header);
        }
        await this.clipboard.copyText(lines.join('\n'));
        return copiedRows;
    }

    private async continueInNewCell(
        editor: vscode.NotebookEditor,
        request: ContinueRequest,
    ): Promise<'exactSnapshot' | 'liveRerun' | undefined> {
        const sourceCell = this.findSourceCell(editor.notebook, request.sessionId);
        const result = await this.server.createResultSessionContinuation({
            sessionId: request.sessionId,
            tableId: request.tableId,
            viewRevision: request.viewRevision,
            scope: request.scope,
            ...(request.rowRanges ? { rowRanges: request.rowRanges } : {}),
            columnIndexes: request.columnIndexes,
        });

        if (result.snapshotQuery) {
            if (result.projectedRows >= LARGE_SNAPSHOT_WARNING_ROWS
                || result.snapshotTextBytes >= LARGE_SNAPSHOT_WARNING_BYTES) {
                const choice = await vscode.window.showWarningMessage(
                    `This exact snapshot will embed ${result.projectedRows.toLocaleString()} rows (${formatBytes(result.snapshotTextBytes)}) in the notebook. Create it?`,
                    {
                        modal: true,
                        detail: 'Snapshot values will be saved in the notebook and may appear in service query logs when the generated cell is run.',
                    },
                    'Create snapshot cell',
                );
                if (choice !== 'Create snapshot cell') {
                    return undefined;
                }
            }
            await this.notebookManager.insertContinuationCell(
                editor,
                sourceCell,
                result.snapshotQuery,
                'exactSnapshot',
            );
            return 'exactSnapshot';
        }

        if (!result.liveRerunQuery) {
            throw new Error(result.liveRerunUnavailableReason
                ?? 'The selected results are too large to continue within this service\'s safe query-text limit.');
        }

        const budget = formatBytes(result.queryTextBudgetBytes);
        const selected = request.scope === 'selection' ? 'selected rows' : 'filtered results';
        const choice = await vscode.window.showWarningMessage(
            `The ${selected} cannot be embedded within the ${budget} safety budget. Generate a live rerun cell instead?`,
            {
                modal: true,
                detail: 'The new cell will run the original query again. Added, removed, or changed server rows may produce different results. Review the generated KQL before running it.',
            },
            'Generate live rerun cell',
        );
        if (choice !== 'Generate live rerun cell') {
            return undefined;
        }

        await this.notebookManager.insertContinuationCell(
            editor,
            sourceCell,
            result.liveRerunQuery,
            'liveRerun',
        );
        return 'liveRerun';
    }

    private findSourceCell(
        notebook: vscode.NotebookDocument,
        sessionId: string,
    ): vscode.NotebookCell {
        const notebookUri = notebook.uri.toString();
        const cellUri = [...this.sessionsByCell.entries()]
            .find(([, session]) =>
                session.notebookUri === notebookUri
                && session.sessionId === sessionId)?.[0];
        const cell = cellUri
            ? notebook.getCells().find(candidate => candidate.document.uri.toString() === cellUri)
            : undefined;
        if (!cell) {
            throw new Error('The source cell for this result session no longer exists.');
        }
        return cell;
    }

    private async reply(
        editor: vscode.NotebookEditor,
        request: RendererRequest,
        body: Record<string, unknown>,
    ): Promise<void> {
        await this.messaging.postMessage({
            ...body,
            requestId: request.requestId,
            outputId: request.outputId,
            sessionId: request.sessionId,
            tableId: request.tableId,
        }, editor);
    }
}

function parseRendererRequest(
    value: unknown,
): PageRequest | ViewRequest | CancelViewRequest | CopyRequest | ContinueRequest | undefined {
    if (!isRecord(value)
        || typeof value.requestId !== 'string'
        || typeof value.outputId !== 'string'
        || typeof value.sessionId !== 'string'
        || typeof value.tableId !== 'string'
        || !isNonNegativeInteger(value.viewRevision)) {
        return undefined;
    }

    const common = {
        requestId: value.requestId,
        outputId: value.outputId,
        sessionId: value.sessionId,
        tableId: value.tableId,
        viewRevision: value.viewRevision,
    };
    if (value.type === 'page'
        && isNonNegativeInteger(value.offset)
        && isPositiveInteger(value.count)
        && value.count <= RESULT_SESSION_MAX_PAGE_SIZE) {
        return { ...common, type: 'page', offset: value.offset, count: value.count };
    }
    if (value.type === 'setView'
        && isNonNegativeInteger(value.revision)
        && Array.isArray(value.filters)
        && value.filters.every(isColumnFilter)
        && Array.isArray(value.sorts)
        && value.sorts.every(isColumnSort)) {
        return {
            ...common,
            type: 'setView',
            revision: value.revision,
            filters: value.filters,
            sorts: value.sorts,
        };
    }
    if (value.type === 'cancelView') {
        return { ...common, type: 'cancelView' };
    }
    if (value.type === 'copy'
        && Array.isArray(value.rowRanges)
        && value.rowRanges.every(isRowRange)
        && Array.isArray(value.columnIndexes)
        && value.columnIndexes.every(isNonNegativeInteger)) {
        return {
            ...common,
            type: 'copy',
            rowRanges: value.rowRanges,
            columnIndexes: value.columnIndexes,
        };
    }
    if (value.type === 'continue'
        && (value.scope === 'filtered' || value.scope === 'selection')
        && (value.rowRanges === undefined
            || (Array.isArray(value.rowRanges) && value.rowRanges.every(isRowRange)))
        && Array.isArray(value.columnIndexes)
        && value.columnIndexes.length > 0
        && value.columnIndexes.every(isNonNegativeInteger)
        && (value.scope !== 'selection'
            || (Array.isArray(value.rowRanges) && value.rowRanges.length > 0))) {
        return {
            ...common,
            type: 'continue',
            scope: value.scope,
            ...(value.rowRanges ? { rowRanges: value.rowRanges } : {}),
            columnIndexes: value.columnIndexes,
        };
    }

    return undefined;
}

function formatBytes(bytes: number): string {
    return bytes >= 1024
        ? `${Math.round(bytes / 1024).toLocaleString()} KiB`
        : `${bytes.toLocaleString()} bytes`;
}

function viewCancellationKey(
    sessionId: string,
    tableId: string,
    outputId: string,
    rendererId: number,
): string {
    return `${sessionId}\0${tableId}\0${outputId}\0${rendererId}`;
}

function isColumnFilter(value: unknown): value is ResultSessionColumnFilter {
    return isRecord(value)
        && isNonNegativeInteger(value.columnIndex)
        && typeof value.pattern === 'string'
        && typeof value.caseSensitive === 'boolean';
}

function isColumnSort(value: unknown): value is ResultSessionColumnSort {
    return isRecord(value)
        && isNonNegativeInteger(value.columnIndex)
        && (value.direction === 'ascending' || value.direction === 'descending');
}

function isRowRange(value: unknown): value is { offset: number; count: number } {
    return isRecord(value)
        && isNonNegativeInteger(value.offset)
        && isPositiveInteger(value.count);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return isNonNegativeInteger(value) && value > 0;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
