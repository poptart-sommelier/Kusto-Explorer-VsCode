// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 58;
const OVERSCAN_ROWS = 8;
const MAX_CACHED_PAGES = 10;
const FILTER_DEBOUNCE_MS = 300;
const MAX_AUTOMATIC_VIEW_RETRIES = 1;
const MIN_COLUMN_WIDTH = 70;
const MAX_COLUMN_WIDTH = 1_000_000;
const AUTO_FIT_MIN_WIDTH = 110;
const AUTO_FIT_VALUE_PADDING = 20;
const AUTO_FIT_HEADER_PADDING = 42;
const instances = new Map();

export function activate(context) {
    installStyles();
    if (context.onDidReceiveMessage) {
        context.onDidReceiveMessage(message => {
            instances.get(message.outputId)?.receive(message);
        });
    }

    return {
        renderOutputItem(outputItem, element) {
            const data = outputItem.json();
            const grid = new ResultGrid(context, outputItem.id, data, element);
            instances.set(outputItem.id, grid);
            grid.render();
        },
        disposeOutputItem(outputId) {
            instances.get(outputId)?.dispose();
            instances.delete(outputId);
        },
    };
}

class ResultGrid {
    constructor(context, outputId, data, element) {
        this.context = context;
        this.outputId = outputId;
        this.sessionId = data.sessionId;
        this.tables = data.tables ?? [];
        this.element = element;
        this.tableIndex = 0;
        this.tableStates = new Map();
        this.requestNumber = 0;
        this.disposables = [];
    }

    render() {
        this.element.replaceChildren();
        this.element.classList.add('kusto-result-output');

        this.tabs = document.createElement('div');
        this.tabs.className = 'kusto-result-tabs';
        this.tabs.setAttribute('role', 'tablist');

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'kusto-result-toolbar';

        this.copyButton = document.createElement('button');
        this.copyButton.type = 'button';
        this.copyButton.textContent = 'Copy selection';
        this.copyButton.disabled = true;
        this.copyButton.addEventListener('click', () => this.copySelection());

        this.continueButton = document.createElement('button');
        this.continueButton.type = 'button';
        this.continueButton.textContent = continuationActionLabel(false, false);
        this.continueButton.addEventListener('click', () => this.continueResults());

        this.clearFiltersButton = document.createElement('button');
        this.clearFiltersButton.type = 'button';
        this.clearFiltersButton.textContent = 'Clear filters';
        this.clearFiltersButton.disabled = true;
        this.clearFiltersButton.addEventListener('click', () => this.clearFilters());

        this.cancelViewButton = document.createElement('button');
        this.cancelViewButton.type = 'button';
        this.cancelViewButton.textContent = 'Cancel update';
        this.cancelViewButton.disabled = true;
        this.cancelViewButton.addEventListener('click', () => this.cancelViewChange());

        this.status = document.createElement('span');
        this.status.className = 'kusto-result-status';
        this.status.setAttribute('aria-live', 'polite');
        this.toolbar.append(
            this.copyButton,
            this.continueButton,
            this.clearFiltersButton,
            this.cancelViewButton,
            this.status,
        );

        this.headerViewport = document.createElement('div');
        this.headerViewport.className = 'kusto-grid-header-viewport';

        this.scroller = document.createElement('div');
        this.scroller.className = 'kusto-grid-scroller';
        this.scroller.tabIndex = 0;
        this.scroller.setAttribute('role', 'grid');
        this.scroller.addEventListener('scroll', () => {
            this.headerRow.style.transform = `translateX(${-this.scroller.scrollLeft}px)`;
            this.renderRows();
        });
        this.scroller.addEventListener('keydown', event => this.onKeyDown(event));

        this.canvas = document.createElement('div');
        this.canvas.className = 'kusto-grid-canvas';
        this.scroller.append(this.canvas);
        this.element.append(this.tabs, this.toolbar, this.headerViewport, this.scroller);
        this.showTable(0);
    }

    showTable(index) {
        this.tableIndex = index;
        const table = this.tables[index];
        if (!table) {
            this.status.textContent = 'Query completed without tabular results.';
            this.headerViewport.replaceChildren();
            this.canvas.replaceChildren();
            return;
        }

        this.tabs.replaceChildren();
        this.tables.forEach((candidate, candidateIndex) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = candidateIndex === index ? 'active' : '';
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(candidateIndex === index));
            button.textContent = candidate.name || `Result ${candidateIndex + 1}`;
            button.addEventListener('click', () => this.showTable(candidateIndex));
            this.tabs.append(button);
        });

        this.state = this.getTableState(table);
        this.scroller.setAttribute('aria-rowcount', String(this.state.totalRows + 1));
        this.scroller.setAttribute('aria-colcount', String(table.columns.length));
        this.copyButton.disabled = !this.state.selection;
        this.updateContinueButton();
        this.updateFilterButton();
        this.cancelViewButton.disabled = !this.state.pendingView;
        this.scroller.scrollTop = 0;
        this.scroller.scrollLeft = 0;
        this.renderHeader();
        this.updateCanvasSize();
        this.updateStatus();
        this.renderRows();
        if (this.state.queuedView && !this.state.pendingView) {
            this.state.queuedView = false;
            this.sendViewChange(this.state);
        }
    }

    getTableState(table) {
        let state = this.tableStates.get(table.id);
        if (!state) {
            state = {
                table,
                revision: table.view?.revision ?? 0,
                nextRevision: table.view?.revision ?? 0,
                totalRows: table.view?.matchedRows ?? table.totalRows ?? table.rowsRead ?? 0,
                order: table.columns.map((_, index) => index),
                widths: table.columns.map(column => defaultColumnWidth(column)),
                pages: new Map(),
                pendingPages: new Map(),
                pageRequests: new Map(),
                selection: undefined,
                sort: undefined,
                draftSort: undefined,
                filters: new Map(),
                draftFilters: new Map(),
                filterErrors: new Map(),
                pendingView: undefined,
                queuedView: false,
                automaticViewRetries: 0,
                pendingContinuation: undefined,
                pendingEnrichment: undefined,
                filterTimer: undefined,
            };
            this.tableStates.set(table.id, state);
        }
        return state;
    }

    renderHeader() {
        this.headerRow = document.createElement('div');
        this.headerRow.className = 'kusto-grid-header';
        this.headerRow.style.width = `${this.totalWidth()}px`;
        this.headerRow.setAttribute('role', 'row');

        const corner = document.createElement('div');
        corner.className = 'kusto-grid-corner';
        corner.style.width = `${ROW_NUMBER_WIDTH}px`;
        corner.textContent = '#';
        this.headerRow.append(corner);

        this.state.order.forEach((columnIndex, displayIndex) => {
            const column = this.state.table.columns[columnIndex];
            const header = document.createElement('div');
            header.className = 'kusto-grid-header-cell';
            header.style.width = `${this.state.widths[columnIndex]}px`;
            header.dataset.columnIndex = String(columnIndex);
            header.setAttribute('role', 'columnheader');
            const displayedSort = this.state.draftSort;
            header.setAttribute('aria-sort', sortAria(displayedSort, columnIndex));
            header.draggable = true;
            header.dataset.displayIndex = String(displayIndex);

            const label = document.createElement('div');
            label.className = 'kusto-grid-header-label';
            const title = document.createElement('span');
            title.className = 'kusto-grid-header-title';
            title.textContent = column.name;
            title.title = `${column.name} (${column.type})`;
            const type = document.createElement('span');
            type.className = 'kusto-grid-column-type';
            type.textContent = column.type;
            const sort = document.createElement('span');
            sort.className = 'kusto-grid-sort';
            sort.textContent = sortGlyph(displayedSort, columnIndex);
            label.append(title, type, sort);

            const filter = document.createElement('div');
            filter.className = 'kusto-grid-filter';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = this.state.draftFilters.get(columnIndex)?.pattern ?? '';
            input.dataset.columnIndex = String(columnIndex);
            input.placeholder = 'Regex filter';
            input.maxLength = 4096;
            input.setAttribute('aria-label', `Filter ${column.name} with a regular expression`);
            input.title = 'Regular expression. Null values are matched as an empty string.';
            input.spellcheck = false;
            const filterError = this.state.filterErrors.get(columnIndex);
            if (filterError) {
                input.classList.add('invalid');
                input.setAttribute('aria-invalid', 'true');
                input.title = filterError;
            }
            input.addEventListener('input', () => {
                this.updateFilter(columnIndex, input.value, input);
            });
            for (const eventName of ['click', 'pointerdown', 'dragstart']) {
                input.addEventListener(eventName, event => event.stopPropagation());
            }

            const caseButton = document.createElement('button');
            caseButton.type = 'button';
            caseButton.className = 'kusto-grid-filter-case';
            const caseSensitive = this.state.draftFilters.get(columnIndex)?.caseSensitive ?? false;
            caseButton.classList.toggle('active', caseSensitive);
            caseButton.textContent = 'Aa';
            caseButton.title = caseSensitive ? 'Case-sensitive matching' : 'Case-insensitive matching';
            caseButton.setAttribute('aria-pressed', String(caseSensitive));
            caseButton.addEventListener('click', event => {
                event.stopPropagation();
                this.toggleFilterCase(columnIndex);
            });
            caseButton.addEventListener('pointerdown', event => event.stopPropagation());
            filter.append(input, caseButton);

            const resize = document.createElement('span');
            resize.className = 'kusto-grid-resize';
            resize.title = 'Drag or use arrow keys to resize. Double-click or press Enter to fit loaded values.';
            resize.tabIndex = 0;
            resize.setAttribute('role', 'separator');
            resize.setAttribute('aria-orientation', 'vertical');
            resize.setAttribute('aria-label', `Resize ${column.name}`);
            resize.setAttribute('aria-valuemin', String(MIN_COLUMN_WIDTH));
            resize.setAttribute('aria-valuemax', String(MAX_COLUMN_WIDTH));
            resize.setAttribute('aria-valuenow', String(this.state.widths[columnIndex]));
            resize.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
                this.beginResize(event, columnIndex);
            });
            resize.addEventListener('dblclick', event => {
                event.preventDefault();
                event.stopPropagation();
                this.autoFitColumn(columnIndex);
            });
            resize.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.autoFitColumn(columnIndex);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    event.stopPropagation();
                    const direction = event.key === 'ArrowLeft' ? -1 : 1;
                    this.setColumnWidth(
                        columnIndex,
                        this.state.widths[columnIndex] + direction * (event.shiftKey ? 50 : 10),
                    );
                }
            });
            header.append(label, filter, resize);
            label.addEventListener('click', () => this.toggleSort(columnIndex));
            header.addEventListener('dragstart', event => {
                event.dataTransfer?.setData('text/plain', String(displayIndex));
            });
            header.addEventListener('dragover', event => event.preventDefault());
            header.addEventListener('drop', event => {
                event.preventDefault();
                const from = Number(event.dataTransfer?.getData('text/plain'));
                if (Number.isInteger(from)) {
                    this.reorderColumn(from, displayIndex);
                }
            });
            this.headerRow.append(header);
        });
        this.headerRow.style.transform = `translateX(${-this.scroller.scrollLeft}px)`;
        this.headerViewport.replaceChildren(this.headerRow);
    }

    renderRows() {
        if (!this.state) {
            return;
        }
        const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
        const last = Math.min(
            this.state.totalRows,
            Math.ceil((this.scroller.scrollTop + this.scroller.clientHeight) / ROW_HEIGHT) + OVERSCAN_ROWS,
        );
        this.requestVisiblePages(first, last);
        this.canvas.replaceChildren();

        for (let viewIndex = first; viewIndex < last; viewIndex += 1) {
            const row = this.findRow(viewIndex);
            const rowElement = document.createElement('div');
            rowElement.className = 'kusto-grid-row';
            rowElement.style.width = `${this.totalWidth()}px`;
            rowElement.style.transform = `translateY(${viewIndex * ROW_HEIGHT}px)`;
            rowElement.setAttribute('role', 'row');
            rowElement.setAttribute('aria-rowindex', String(viewIndex + 2));

            const rowNumber = document.createElement('div');
            rowNumber.className = 'kusto-grid-row-number';
            rowNumber.style.width = `${ROW_NUMBER_WIDTH}px`;
            rowNumber.textContent = String(viewIndex + 1);
            rowNumber.addEventListener('click', event => {
                this.select(viewIndex, 0, this.state.order.length - 1, event.shiftKey);
            });
            rowElement.append(rowNumber);

            this.state.order.forEach((columnIndex, displayIndex) => {
                const cell = document.createElement('div');
                cell.className = 'kusto-grid-cell';
                cell.id = `kusto-cell-${this.outputId}-${viewIndex}-${displayIndex}`;
                cell.style.width = `${this.state.widths[columnIndex]}px`;
                cell.dataset.columnIndex = String(columnIndex);
                cell.setAttribute('role', 'gridcell');
                cell.setAttribute('aria-colindex', String(displayIndex + 1));
                if (this.isSelected(viewIndex, displayIndex)) {
                    cell.classList.add('selected');
                }
                if (row) {
                    setCellValue(cell, row.values[columnIndex]);
                } else {
                    cell.classList.add('loading');
                    cell.textContent = '...';
                }
                cell.addEventListener('click', event => {
                    this.select(viewIndex, displayIndex, displayIndex, event.shiftKey);
                });
                cell.addEventListener('contextmenu', event => {
                    event.preventDefault();
                    this.requestEnrichment(viewIndex, displayIndex, columnIndex);
                });
                rowElement.append(cell);
            });
            this.canvas.append(rowElement);
        }
        this.evictDistantPages(first);
    }

    requestVisiblePages(first, last) {
        if (this.state.totalRows === 0 || last <= first) {
            return;
        }
        const firstPage = Math.floor(first / PAGE_SIZE) * PAGE_SIZE;
        const lastPage = Math.floor(Math.max(first, last - 1) / PAGE_SIZE) * PAGE_SIZE;
        for (let offset = firstPage; offset <= lastPage; offset += PAGE_SIZE) {
            if (!this.state.pages.has(offset) && !this.state.pendingPages.has(offset)) {
                const revision = this.state.revision;
                const requestId = this.post('page', {
                    offset,
                    count: Math.min(PAGE_SIZE, this.state.totalRows - offset),
                });
                this.state.pendingPages.set(offset, requestId);
                this.state.pageRequests.set(requestId, { offset, revision });
            }
        }
    }

    findRow(viewIndex) {
        const pageOffset = Math.floor(viewIndex / PAGE_SIZE) * PAGE_SIZE;
        return this.state.pages.get(pageOffset)?.rows[viewIndex - pageOffset];
    }

    receive(message) {
        const targetState = this.tableStates.get(message.tableId);
        if (!targetState) {
            return;
        }
        if (message.type === 'pageResult') {
            const page = message.page;
            const pageRequest = targetState.pageRequests.get(message.requestId);
            if (!pageRequest) {
                return;
            }
            targetState.pageRequests.delete(message.requestId);
            if (targetState.pendingPages.get(page.offset) === message.requestId) {
                targetState.pendingPages.delete(page.offset);
            }
            if (page.viewRevision !== targetState.revision) {
                return;
            }
            targetState.pages.set(page.offset, page);
            targetState.totalRows = page.viewRows;
            if (targetState === this.state) {
                this.updateCanvasSize();
                this.updateStatus();
                this.renderRows();
            }
        } else if (message.type === 'viewResult') {
            if (targetState.pendingView?.requestId !== message.requestId) {
                return;
            }
            const table = message.status.tables.find(candidate => candidate.id === targetState.table.id);
            const pendingView = targetState.pendingView;
            targetState.pendingView = undefined;
            targetState.nextRevision = pendingView.revision;
            if (table?.view?.state === 'ready') {
                targetState.sort = pendingView.sort;
                targetState.filters = cloneFilters(pendingView.filters);
                if (!targetState.queuedView) {
                    targetState.draftSort = pendingView.sort;
                    targetState.draftFilters = cloneFilters(pendingView.filters);
                }
                targetState.revision = pendingView.revision;
                targetState.filterErrors.clear();
                targetState.totalRows = table.view.matchedRows ?? table.totalRows ?? table.rowsRead ?? 0;
                targetState.pages.clear();
                targetState.pendingPages.clear();
                targetState.selection = undefined;
            } else {
                targetState.filterErrors = new Map(
                    (table?.view?.filters ?? [])
                        .filter(filter => filter.state === 'invalid')
                        .filter(filter => {
                            if (!targetState.queuedView) {
                                return true;
                            }
                            const attempted = pendingView.filters.get(filter.columnIndex);
                            const draft = targetState.draftFilters.get(filter.columnIndex);
                            return attempted?.pattern === draft?.pattern
                                && attempted?.caseSensitive === draft?.caseSensitive;
                        })
                        .map(filter => [
                            filter.columnIndex,
                            filter.error?.details ?? filter.error?.message ?? 'Invalid regular expression.',
                        ]),
                );
            }
            if (targetState === this.state) {
                this.updateCanvasSize();
                this.updateStatus(table?.view?.state === 'failed'
                    ? table.view.error?.message ?? 'Fix the invalid filter.'
                    : undefined);
                if (table?.view?.state === 'failed') {
                    this.status.classList.add('error');
                }
                this.updateFilterButton();
                this.cancelViewButton.disabled = true;
                this.copyButton.disabled = !targetState.selection;
                this.updateContinueButton();
                this.updateFilterValidation();
                this.renderRows();
            }
            this.sendQueuedView(targetState);
        } else if (message.type === 'continuationResult') {
            if (targetState.pendingContinuation !== message.requestId) {
                return;
            }
            targetState.pendingContinuation = undefined;
            if (targetState === this.state) {
                this.updateContinueButton();
                this.updateStatus(message.kind === 'exactSnapshot'
                    ? 'Created an exact snapshot cell.'
                    : 'Created a live rerun cell.');
            }
        } else if (message.type === 'continuationCancelled') {
            if (targetState.pendingContinuation !== message.requestId) {
                return;
            }
            targetState.pendingContinuation = undefined;
            if (targetState === this.state) {
                this.updateContinueButton();
                this.updateStatus();
            }
        } else if (message.type === 'enrichmentResult' || message.type === 'enrichmentCancelled') {
            if (targetState.pendingEnrichment !== message.requestId) {
                return;
            }
            targetState.pendingEnrichment = undefined;
            if (targetState === this.state) {
                this.updateStatus(message.type === 'enrichmentResult'
                    ? `Created a cell for '${message.name}'.`
                    : undefined);
            }
        } else if (message.type === 'copyResult' && targetState === this.state) {
            this.status.textContent = `Copied ${message.copiedRows.toLocaleString()} row${message.copiedRows === 1 ? '' : 's'}.`;
        } else if (message.type === 'viewCancelled') {
            if (targetState.pendingView?.requestId !== message.requestId) {
                return;
            }
            const table = message.status?.tables.find(candidate => candidate.id === targetState.table.id);
            const cancelledRevision = targetState.pendingView.revision;
            targetState.pendingView = undefined;
            const synchronized = this.synchronizeReadyView(
                targetState,
                table,
                targetState.queuedView,
            );
            if (!synchronized) {
                targetState.nextRevision = table?.view?.revision ?? cancelledRevision;
            }
            if (targetState === this.state) {
                this.cancelViewButton.disabled = true;
                if (synchronized) {
                    this.updateCanvasSize();
                    this.updateFilterButton();
                    this.renderHeader();
                    this.copyButton.disabled = !targetState.selection;
                    this.updateContinueButton();
                }
                this.updateStatus();
                this.renderRows();
            }
            this.sendQueuedView(targetState);
        } else if (message.type === 'viewRejected') {
            if (targetState.pendingView?.requestId !== message.requestId) {
                return;
            }
            const table = message.status?.tables.find(candidate => candidate.id === targetState.table.id);
            targetState.pendingView = undefined;
            if (!this.synchronizeReadyView(targetState, table, true)) {
                targetState.nextRevision = table?.view?.revision ?? message.revision;
            }
            const canRetry = targetState.automaticViewRetries < MAX_AUTOMATIC_VIEW_RETRIES;
            if (canRetry) {
                targetState.automaticViewRetries += 1;
                targetState.queuedView = true;
            }
            if (targetState === this.state) {
                this.cancelViewButton.disabled = true;
                this.copyButton.disabled = !targetState.selection;
                this.updateContinueButton();
                this.status.textContent = canRetry
                    ? 'The view changed elsewhere. Retrying...'
                    : 'The view changed elsewhere. Edit a filter or sort to retry.';
            }
            this.sendQueuedView(targetState);
        } else if (message.type === 'requestError') {
            const failedEnrichment = targetState.pendingEnrichment === message.requestId;
            if (failedEnrichment) {
                targetState.pendingEnrichment = undefined;
            }
            const failedPage = targetState.pageRequests.get(message.requestId);
            if (failedPage) {
                targetState.pageRequests.delete(message.requestId);
                if (targetState.pendingPages.get(failedPage.offset) === message.requestId) {
                    targetState.pendingPages.delete(failedPage.offset);
                }
                if (failedPage.revision !== targetState.revision) {
                    return;
                }
            }
            const failedPendingView = targetState.pendingView?.requestId === message.requestId;
            const failedContinuation = targetState.pendingContinuation === message.requestId;
            if (failedPendingView) {
                targetState.pendingView = undefined;
            }
            if (failedContinuation) {
                targetState.pendingContinuation = undefined;
            }
            const table = message.status?.tables.find(candidate => candidate.id === targetState.table.id);
            const preserveDraft = targetState.queuedView
                || failedPendingView
                || targetState.pendingView !== undefined
                || targetState.filterTimer !== undefined;
            const readyRevisionChanged = table?.view?.readyRevision !== undefined
                && table.view.readyRevision !== targetState.revision;
            const synchronized = readyRevisionChanged
                && this.synchronizeReadyView(targetState, table, preserveDraft);
            if (synchronized
                && failedPendingView
                && !targetState.queuedView
                && targetState.automaticViewRetries < MAX_AUTOMATIC_VIEW_RETRIES) {
                targetState.automaticViewRetries += 1;
                targetState.queuedView = true;
            }
            if (targetState === this.state) {
                if (synchronized) {
                    this.updateCanvasSize();
                    this.updateFilterButton();
                    this.updateContinueButton();
                    this.renderHeader();
                    this.updateStatus('The result view changed in another editor.');
                    this.renderRows();
                } else {
                    if (failedPendingView) {
                        this.renderHeader();
                        this.cancelViewButton.disabled = true;
                    }
                    if (failedContinuation) {
                        this.updateContinueButton();
                    }
                    this.status.textContent = message.message;
                    this.status.classList.add('error');
                }
            }
            this.sendQueuedView(targetState);
        }
    }

    synchronizeReadyView(state, table, preserveDraft) {
        const view = table?.view;
        if (view?.readyRevision === undefined) {
            return false;
        }
        state.revision = view.readyRevision;
        state.nextRevision = Math.max(state.nextRevision, view.revision);
        state.totalRows = view.readyMatchedRows ?? table.totalRows ?? table.rowsRead ?? 0;
        state.filters = filtersToMap(view.readyFilters ?? []);
        state.sort = view.readySorts?.[0];
        state.pages.clear();
        state.pendingPages.clear();
        state.selection = undefined;
        if (!preserveDraft) {
            state.draftFilters = cloneFilters(state.filters);
            state.draftSort = state.sort;
            state.filterErrors.clear();
        }
        return true;
    }

    toggleSort(columnIndex) {
        let requestedSort;
        if (this.state.draftSort?.columnIndex === columnIndex) {
            if (this.state.draftSort.direction === 'ascending') {
                requestedSort = { columnIndex, direction: 'descending' };
            }
        } else {
            requestedSort = { columnIndex, direction: 'ascending' };
        }
        this.state.draftSort = requestedSort;
        this.renderHeader();
        this.queueViewChange('Updating view...');
    }

    updateFilter(columnIndex, pattern, input) {
        const existing = this.state.draftFilters.get(columnIndex);
        if (pattern.length === 0) {
            this.state.draftFilters.delete(columnIndex);
        } else {
            this.state.draftFilters.set(columnIndex, {
                pattern,
                caseSensitive: existing?.caseSensitive ?? false,
            });
        }
        this.state.filterErrors.delete(columnIndex);
        input.classList.remove('invalid');
        input.removeAttribute('aria-invalid');
        input.title = 'Regular expression. Null values are matched as an empty string.';
        this.updateFilterButton();
        this.queueViewChange('Filtering...', true);
    }

    toggleFilterCase(columnIndex) {
        const existing = this.state.draftFilters.get(columnIndex);
        if (!existing) {
            return;
        }
        this.state.draftFilters.set(columnIndex, {
            ...existing,
            caseSensitive: !existing.caseSensitive,
        });
        this.renderHeader();
        this.queueViewChange('Filtering...');
    }

    clearFilters() {
        if (this.state.draftFilters.size === 0) {
            return;
        }
        this.state.draftFilters.clear();
        this.state.filterErrors.clear();
        this.updateFilterButton();
        this.renderHeader();
        this.queueViewChange('Clearing filters...');
    }

    queueViewChange(status, debounce = false) {
        const state = this.state;
        state.automaticViewRetries = 0;
        clearTimeout(state.filterTimer);
        this.updateStatus(status);
        if (state.pendingView) {
            state.queuedView = true;
            this.updateContinueButton();
            return;
        }
        if (debounce) {
            state.filterTimer = setTimeout(() => this.sendViewChange(state), FILTER_DEBOUNCE_MS);
            this.updateContinueButton();
        } else {
            this.sendViewChange(state);
        }
    }

    sendViewChange(state) {
        clearTimeout(state.filterTimer);
        state.filterTimer = undefined;
        if (state.pendingView) {
            state.queuedView = true;
            return;
        }
        const revision = state.nextRevision + 1;
        const filters = cloneFilters(state.draftFilters);
        const sort = state.draftSort;
        const requestId = this.post('setView', {
            revision,
            filters: [...filters].map(([columnIndex, value]) => ({
                columnIndex,
                pattern: value.pattern,
                caseSensitive: value.caseSensitive,
            })),
            sorts: sort ? [sort] : [],
        }, state);
        state.pendingView = { sort, filters, revision, requestId };
        if (state === this.state) {
            this.cancelViewButton.disabled = false;
            this.updateContinueButton();
        }
    }

    sendQueuedView(state) {
        if (!state.queuedView) {
            return;
        }
        state.queuedView = false;
        this.sendViewChange(state);
    }

    updateFilterButton() {
        this.clearFiltersButton.disabled = this.state.draftFilters.size === 0;
    }

    updateFilterValidation() {
        for (const input of this.headerRow.querySelectorAll('.kusto-grid-filter input')) {
            const columnIndex = Number(input.dataset.columnIndex);
            const error = this.state.filterErrors.get(columnIndex);
            input.classList.toggle('invalid', Boolean(error));
            if (error) {
                input.setAttribute('aria-invalid', 'true');
                input.title = error;
            } else {
                input.removeAttribute('aria-invalid');
                input.title = 'Regular expression. Null values are matched as an empty string.';
            }
        }
    }

    cancelViewChange() {
        if (!this.state.pendingView) {
            return;
        }
        clearTimeout(this.state.filterTimer);
        this.state.filterTimer = undefined;
        this.state.queuedView = false;
        this.state.draftSort = this.state.sort;
        this.state.draftFilters = cloneFilters(this.state.filters);
        this.state.filterErrors.clear();
        this.cancelViewButton.disabled = true;
        this.updateFilterButton();
        this.renderHeader();
        this.updateStatus('Cancelling update...');
        this.post('cancelView', {});
    }

    beginResize(event, columnIndex) {
        const startX = event.clientX;
        const startWidth = this.state.widths[columnIndex];
        const onMove = move => {
            this.setColumnWidth(columnIndex, startWidth + move.clientX - startX);
        };
        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }

    setColumnWidth(columnIndex, width) {
        this.state.widths[columnIndex] = clampColumnWidth(width);
        const widthText = `${this.state.widths[columnIndex]}px`;
        const totalWidthText = `${this.totalWidth()}px`;
        const selector = `[data-column-index="${columnIndex}"]`;
        const header = this.headerRow.querySelector(selector);
        if (header) {
            header.style.width = widthText;
            header.querySelector('.kusto-grid-resize')
                ?.setAttribute('aria-valuenow', String(this.state.widths[columnIndex]));
        }
        for (const cell of this.canvas.querySelectorAll(`.kusto-grid-cell${selector}`)) {
            cell.style.width = widthText;
        }
        this.headerRow.style.width = totalWidthText;
        this.canvas.style.width = totalWidthText;
        for (const row of this.canvas.querySelectorAll('.kusto-grid-row')) {
            row.style.width = totalWidthText;
        }
    }

    autoFitColumn(columnIndex) {
        const column = this.state.table.columns[columnIndex];
        if (!column) {
            return;
        }
        const header = this.headerRow.querySelector(`[data-column-index="${columnIndex}"]`);
        const title = header?.querySelector('.kusto-grid-header-title');
        const visibleCell = this.canvas.querySelector(`.kusto-grid-cell[data-column-index="${columnIndex}"]`);
        const measureText = createTextMeasurer(visibleCell ?? this.element);
        const measureHeadingText = createTextMeasurer(title ?? this.element);
        this.setColumnWidth(columnIndex, calculateAutoFitWidth(
            column,
            columnIndex,
            this.state.pages.values(),
            measureText,
            measureHeadingText,
        ));
    }

    reorderColumn(from, to) {
        if (from === to || from < 0 || to < 0
            || from >= this.state.order.length || to >= this.state.order.length) {
            return;
        }
        const [moved] = this.state.order.splice(from, 1);
        this.state.order.splice(to, 0, moved);
        this.renderHeader();
        this.updateCanvasSize();
        this.renderRows();
    }

    select(row, firstColumn, lastColumn, extend) {
        const previous = this.state.selection;
        if (extend && previous) {
            this.state.selection = {
                firstRow: Math.min(previous.anchorRow, row),
                lastRow: Math.max(previous.anchorRow, row),
                firstColumn: Math.min(previous.anchorColumn, firstColumn),
                lastColumn: Math.max(previous.anchorColumn, lastColumn),
                anchorRow: previous.anchorRow,
                anchorColumn: previous.anchorColumn,
            };
        } else {
            this.state.selection = {
                firstRow: row,
                lastRow: row,
                firstColumn,
                lastColumn,
                anchorRow: row,
                anchorColumn: firstColumn,
            };
        }
        this.copyButton.disabled = false;
        this.updateContinueButton();
        this.scroller.setAttribute('aria-activedescendant', `kusto-cell-${this.outputId}-${row}-${firstColumn}`);
        this.renderRows();
    }

    isSelected(row, displayColumn) {
        const selection = this.state.selection;
        return selection
            && row >= selection.firstRow
            && row <= selection.lastRow
            && displayColumn >= selection.firstColumn
            && displayColumn <= selection.lastColumn;
    }

    onKeyDown(event) {
        if (!this.state.selection || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
                event.preventDefault();
                this.copySelection();
            }
            return;
        }
        event.preventDefault();
        let row = this.state.selection.lastRow;
        let column = this.state.selection.lastColumn;
        if (event.key === 'ArrowUp') row -= 1;
        if (event.key === 'ArrowDown') row += 1;
        if (event.key === 'ArrowLeft') column -= 1;
        if (event.key === 'ArrowRight') column += 1;
        row = Math.max(0, Math.min(this.state.totalRows - 1, row));
        column = Math.max(0, Math.min(this.state.order.length - 1, column));
        this.select(row, column, column, event.shiftKey);
        this.scroller.scrollTop = Math.max(
            0,
            Math.min(this.scroller.scrollTop, row * ROW_HEIGHT),
            (row + 1) * ROW_HEIGHT - this.scroller.clientHeight,
        );
    }

    copySelection() {
        const selection = this.state.selection;
        if (!selection) {
            return;
        }
        const columnIndexes = this.state.order.slice(selection.firstColumn, selection.lastColumn + 1);
        this.updateStatus('Copying...');
        this.post('copy', {
            rowRanges: [{
                offset: selection.firstRow,
                count: selection.lastRow - selection.firstRow + 1,
            }],
            columnIndexes,
        });
    }

    continueResults() {
        if (this.state.pendingContinuation) {
            return;
        }
        const selection = this.state.selection;
        const scope = selection ? 'selection' : 'filtered';
        const rowRanges = selection
            ? [{
                offset: selection.firstRow,
                count: selection.lastRow - selection.firstRow + 1,
            }]
            : undefined;
        const columnIndexes = selection
            ? this.state.order.slice(selection.firstColumn, selection.lastColumn + 1)
            : [...this.state.order];
        const requestId = this.post('continue', {
            scope,
            ...(rowRanges ? { rowRanges } : {}),
            columnIndexes,
        });
        this.state.pendingContinuation = requestId;
        this.updateContinueButton();
        this.updateStatus(continuationProgressMessage(
            Boolean(selection),
            this.state.draftFilters.size > 0,
        ));
    }

    updateContinueButton() {
        const selection = this.state.selection;
        this.continueButton.disabled = Boolean(
            this.state.pendingContinuation
            || this.state.pendingView
            || this.state.queuedView
            || this.state.filterTimer
            || this.state.filterErrors.size > 0
            || !filtersEqual(this.state.draftFilters, this.state.filters)
            || !sortsEqual(this.state.draftSort, this.state.sort),
        );
        this.continueButton.textContent = continuationActionLabel(
            Boolean(selection),
            this.state.draftFilters.size > 0,
        );
    }

    /**
     * Sends the right-clicked cell and the current selection for enrichment. The input rows are the
     * union of the selected rows and the clicked row, each included once with all of its columns.
     */
    requestEnrichment(viewIndex, displayIndex, columnIndex) {
        if (this.state.pendingEnrichment || this.state.pendingView || this.state.queuedView) {
            return;
        }
        const selection = this.state.selection;
        const rowRanges = [];
        if (selection && viewIndex >= selection.firstRow && viewIndex <= selection.lastRow) {
            rowRanges.push({
                offset: selection.firstRow,
                count: selection.lastRow - selection.firstRow + 1,
            });
        } else if (selection) {
            const before = viewIndex < selection.firstRow;
            const clicked = { offset: viewIndex, count: 1 };
            const selected = {
                offset: selection.firstRow,
                count: selection.lastRow - selection.firstRow + 1,
            };
            rowRanges.push(...(before ? [clicked, selected] : [selected, clicked]));
        } else {
            rowRanges.push({ offset: viewIndex, count: 1 });
        }

        const selectedColumnIndexes = selection
            ? this.state.order.slice(selection.firstColumn, selection.lastColumn + 1)
            : [columnIndex];
        const requestId = this.post('enrich', {
            rowRanges,
            columnIndexes: [...this.state.order],
            clickedRowIndex: viewIndex,
            clickedColumnIndex: columnIndex,
            selectedColumnIndexes,
        });
        this.state.pendingEnrichment = requestId;
        this.updateStatus('Choose an enrichment...');
        void displayIndex;
    }

    post(type, body, state = this.state) {
        this.requestNumber += 1;
        const requestId = `${this.outputId}-${this.requestNumber}`;
        this.context.postMessage({
            type,
            requestId,
            outputId: this.outputId,
            sessionId: this.sessionId,
            tableId: state.table.id,
            viewRevision: state.revision,
            ...body,
        });
        return requestId;
    }

    updateCanvasSize() {
        this.canvas.style.height = `${this.state.totalRows * ROW_HEIGHT}px`;
        this.canvas.style.width = `${this.totalWidth()}px`;
        this.scroller.setAttribute('aria-rowcount', String(this.state.totalRows + 1));
    }

    totalWidth() {
        return ROW_NUMBER_WIDTH + this.state.order.reduce(
            (total, columnIndex) => total + this.state.widths[columnIndex],
            0,
        );
    }

    updateStatus(message) {
        this.status.classList.remove('error');
        if (message) {
            this.status.textContent = message;
            return;
        }
        const totalRows = this.state.table.totalRows ?? this.state.table.rowsRead ?? this.state.totalRows;
        this.status.textContent = this.state.filters.size > 0
            ? `${this.state.totalRows.toLocaleString()} of ${totalRows.toLocaleString()} rows`
            : `${this.state.totalRows.toLocaleString()} row${this.state.totalRows === 1 ? '' : 's'}`;
    }

    evictDistantPages(firstVisibleRow) {
        if (this.state.pages.size <= MAX_CACHED_PAGES) {
            return;
        }
        const visiblePage = Math.floor(firstVisibleRow / PAGE_SIZE) * PAGE_SIZE;
        const offsets = [...this.state.pages.keys()]
            .sort((left, right) => Math.abs(right - visiblePage) - Math.abs(left - visiblePage));
        while (this.state.pages.size > MAX_CACHED_PAGES) {
            this.state.pages.delete(offsets.shift());
        }
    }

    dispose() {
        for (const state of this.tableStates.values()) {
            clearTimeout(state.filterTimer);
        }
        this.disposables.forEach(disposable => disposable());
        this.disposables = [];
    }
}

function cloneFilters(filters) {
    return new Map([...filters].map(([columnIndex, value]) => [
        columnIndex,
        { ...value },
    ]));
}

function filtersEqual(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const [columnIndex, filter] of left) {
        const other = right.get(columnIndex);
        if (filter.pattern !== other?.pattern
            || filter.caseSensitive !== other?.caseSensitive) {
            return false;
        }
    }
    return true;
}

function sortsEqual(left, right) {
    return left?.columnIndex === right?.columnIndex
        && left?.direction === right?.direction;
}

function filtersToMap(filters) {
    return new Map(filters.map(filter => [
        filter.columnIndex,
        {
            pattern: filter.pattern,
            caseSensitive: filter.caseSensitive,
        },
    ]));
}

function defaultColumnWidth(column) {
    return Math.max(110, Math.min(260, 48 + String(column.name).length * 8));
}

export function continuationActionLabel(hasSelection, hasFilters) {
    if (hasSelection) {
        return 'Create cell from selection';
    }
    if (hasFilters) {
        return 'Create cell from filtered results';
    }
    return 'Create cell from all results';
}

export function continuationProgressMessage(hasSelection, hasFilters) {
    if (hasSelection) {
        return 'Creating snapshot from selection...';
    }
    if (hasFilters) {
        return 'Creating snapshot from filtered results...';
    }
    return 'Creating snapshot from all results...';
}

export function calculateAutoFitWidth(
    column,
    columnIndex,
    pages,
    measureText,
    measureHeadingText = measureText,
) {
    let widest = Math.max(
        AUTO_FIT_MIN_WIDTH,
        measureHeadingText(String(column.name)) + AUTO_FIT_HEADER_PADDING,
        measureText(String(column.type)) + AUTO_FIT_VALUE_PADDING,
    );
    for (const page of pages) {
        for (const row of page.rows) {
            widest = Math.max(
                widest,
                measureText(displayCellText(row.values[columnIndex])) + AUTO_FIT_VALUE_PADDING,
            );
        }
    }
    return clampColumnWidth(Math.ceil(widest));
}

export function clampColumnWidth(width) {
    return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
}

export function displayCellText(value) {
    if (value === null || value === undefined) {
        return '(null)';
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function createTextMeasurer(element) {
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
        context.font = getComputedStyle(element).font;
    }
    return value => context
        ? context.measureText(value).width
        : value.length * 8;
}

function setCellValue(cell, value) {
    if (value === null || value === undefined) {
        cell.textContent = displayCellText(value);
        cell.classList.add('null');
        return;
    }
    cell.textContent = displayCellText(value);
}

function sortGlyph(sort, columnIndex) {
    if (sort?.columnIndex !== columnIndex) return '';
    return sort.direction === 'ascending' ? '\u25B2' : '\u25BC';
}

function sortAria(sort, columnIndex) {
    if (sort?.columnIndex !== columnIndex) return 'none';
    return sort.direction;
}

function installStyles() {
    if (document.getElementById('kusto-result-grid-styles')) {
        return;
    }
    const style = document.createElement('style');
    style.id = 'kusto-result-grid-styles';
    style.textContent = `
        .kusto-result-output { color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
        .kusto-result-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); }
        .kusto-result-tabs button, .kusto-result-toolbar button {
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            border: 0; padding: 5px 10px; cursor: pointer;
        }
        .kusto-result-tabs button.active {
            color: var(--vscode-tab-activeForeground);
            background: var(--vscode-tab-activeBackground);
            border-bottom: 2px solid var(--vscode-focusBorder);
        }
        .kusto-result-toolbar { display: flex; align-items: center; gap: 10px; min-height: 30px; }
        .kusto-result-toolbar button:disabled { opacity: .55; cursor: default; }
        .kusto-result-status { color: var(--vscode-descriptionForeground); }
        .kusto-result-status.error { color: var(--vscode-errorForeground); }
        .kusto-grid-header-viewport {
            overflow: hidden; border: 1px solid var(--vscode-panel-border);
            border-bottom: 0; background: var(--vscode-editorGroupHeader-tabsBackground);
        }
        .kusto-grid-header { display: flex; height: 66px; will-change: transform; }
        .kusto-grid-corner, .kusto-grid-header-cell, .kusto-grid-row-number, .kusto-grid-cell {
            box-sizing: border-box; flex: none; border-right: 1px solid var(--vscode-panel-border);
        }
        .kusto-grid-corner, .kusto-grid-row-number {
            position: sticky; left: 0; z-index: 2; text-align: right; padding-right: 9px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            color: var(--vscode-descriptionForeground);
        }
        .kusto-grid-corner { padding-top: 11px; }
        .kusto-grid-header-cell {
            position: relative; display: flex; flex-direction: column;
            padding: 2px 5px 4px; user-select: none;
            color: var(--vscode-editor-foreground);
        }
        .kusto-grid-header-label {
            display: grid; grid-template-columns: 1fr auto; grid-template-rows: 19px 13px;
            padding: 0 3px; cursor: pointer;
        }
        .kusto-grid-header-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .kusto-grid-column-type { grid-row: 2; font-size: 10px; color: var(--vscode-descriptionForeground); }
        .kusto-grid-sort { padding-left: 4px; }
        .kusto-grid-filter { display: flex; height: 24px; margin-top: 2px; }
        .kusto-grid-filter input {
            box-sizing: border-box; width: 100%; min-width: 0; height: 24px;
            color: var(--vscode-input-foreground); background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent); padding: 2px 5px; outline: none;
        }
        .kusto-grid-filter input:focus { border-color: var(--vscode-focusBorder); }
        .kusto-grid-filter input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
        .kusto-grid-filter-case {
            flex: none; width: 30px; height: 24px; padding: 0; border: 1px solid var(--vscode-input-border, transparent);
            color: var(--vscode-descriptionForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer;
        }
        .kusto-grid-filter-case.active {
            color: var(--vscode-button-foreground); background: var(--vscode-button-background);
        }
        .kusto-grid-resize { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; }
        .kusto-grid-scroller {
            position: relative; height: 340px; resize: vertical; overflow: auto;
            border: 1px solid var(--vscode-panel-border); outline: none;
            background: var(--vscode-editor-background);
        }
        .kusto-grid-scroller:focus { border-color: var(--vscode-focusBorder); }
        .kusto-grid-canvas { position: relative; min-height: 1px; }
        .kusto-grid-row { position: absolute; top: 0; left: 0; display: flex; height: 28px; }
        .kusto-grid-row:nth-child(even) { background: var(--vscode-keybindingTable-rowsBackground); }
        .kusto-grid-row-number, .kusto-grid-cell {
            height: 28px; padding: 5px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
        }
        .kusto-grid-row-number { cursor: pointer; }
        .kusto-grid-cell.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
        .kusto-grid-cell.null { color: var(--vscode-descriptionForeground); font-style: italic; }
        .kusto-grid-cell.loading { color: var(--vscode-descriptionForeground); }
    `;
    document.head.append(style);
}
