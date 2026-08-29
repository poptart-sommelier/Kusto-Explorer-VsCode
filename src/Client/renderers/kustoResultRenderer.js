// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 58;
const OVERSCAN_ROWS = 8;
const MAX_CACHED_PAGES = 10;
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

        this.status = document.createElement('span');
        this.status.className = 'kusto-result-status';
        this.status.setAttribute('aria-live', 'polite');
        this.toolbar.append(this.copyButton, this.status);

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
        this.scroller.scrollTop = 0;
        this.scroller.scrollLeft = 0;
        this.renderHeader();
        this.updateCanvasSize();
        this.updateStatus();
        this.renderRows();
    }

    getTableState(table) {
        let state = this.tableStates.get(table.id);
        if (!state) {
            state = {
                table,
                revision: table.view?.revision ?? 0,
                totalRows: table.view?.matchedRows ?? table.totalRows ?? table.rowsRead ?? 0,
                order: table.columns.map((_, index) => index),
                widths: table.columns.map(column => defaultColumnWidth(column)),
                pages: new Map(),
                pendingPages: new Set(),
                selection: undefined,
                sort: undefined,
                pendingView: undefined,
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
            header.setAttribute('role', 'columnheader');
            const displayedSort = this.state.pendingView?.sort ?? this.state.sort;
            header.setAttribute('aria-sort', sortAria(displayedSort, columnIndex));
            header.draggable = true;
            header.dataset.displayIndex = String(displayIndex);

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
            const resize = document.createElement('span');
            resize.className = 'kusto-grid-resize';
            resize.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
                this.beginResize(event, columnIndex);
            });
            header.append(title, type, sort, resize);
            header.addEventListener('click', () => this.toggleSort(columnIndex));
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
                this.state.pendingPages.add(offset);
                this.post('page', {
                    offset,
                    count: Math.min(PAGE_SIZE, this.state.totalRows - offset),
                });
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
            targetState.pendingPages.delete(page.offset);
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
        } else if (message.type === 'sortResult') {
            if (targetState.pendingView?.requestId !== message.requestId) {
                return;
            }
            const table = message.status.tables.find(candidate => candidate.id === targetState.table.id);
            targetState.sort = targetState.pendingView.sort;
            targetState.revision = targetState.pendingView.revision;
            targetState.pendingView = undefined;
            targetState.totalRows = table?.view?.matchedRows ?? table?.totalRows ?? table?.rowsRead ?? 0;
            targetState.pages.clear();
            targetState.pendingPages.clear();
            if (targetState === this.state) {
                this.updateCanvasSize();
                this.updateStatus();
                this.renderRows();
            }
        } else if (message.type === 'copyResult' && targetState === this.state) {
            this.status.textContent = `Copied ${message.copiedRows.toLocaleString()} row${message.copiedRows === 1 ? '' : 's'}.`;
        } else if (message.type === 'requestError') {
            targetState.pendingPages.clear();
            const failedPendingView = targetState.pendingView?.requestId === message.requestId;
            if (failedPendingView) {
                targetState.pendingView = undefined;
            }
            if (targetState === this.state) {
                if (failedPendingView) {
                    this.renderHeader();
                }
                this.status.textContent = message.message;
                this.status.classList.add('error');
            }
        }
    }

    toggleSort(columnIndex) {
        if (this.state.pendingView) {
            return;
        }
        let requestedSort;
        if (this.state.sort?.columnIndex === columnIndex) {
            if (this.state.sort.direction === 'ascending') {
                requestedSort = { columnIndex, direction: 'descending' };
            }
        } else {
            requestedSort = { columnIndex, direction: 'ascending' };
        }
        const revision = this.state.revision + 1;
        const requestId = this.post('setSort', {
            revision,
            sorts: requestedSort ? [requestedSort] : [],
        });
        this.state.pendingView = { sort: requestedSort, revision, requestId };
        this.renderHeader();
        this.updateStatus('Sorting...');
    }

    beginResize(event, columnIndex) {
        const startX = event.clientX;
        const startWidth = this.state.widths[columnIndex];
        const onMove = move => {
            this.state.widths[columnIndex] = Math.max(70, Math.min(600, startWidth + move.clientX - startX));
            this.renderHeader();
            this.updateCanvasSize();
            this.renderRows();
        };
        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
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

    post(type, body) {
        this.requestNumber += 1;
        const requestId = `${this.outputId}-${this.requestNumber}`;
        this.context.postMessage({
            type,
            requestId,
            outputId: this.outputId,
            sessionId: this.sessionId,
            tableId: this.state.table.id,
            viewRevision: this.state.revision,
            ...body,
        });
        return requestId;
    }

    updateCanvasSize() {
        this.canvas.style.height = `${this.state.totalRows * ROW_HEIGHT}px`;
        this.canvas.style.width = `${this.totalWidth()}px`;
    }

    totalWidth() {
        return ROW_NUMBER_WIDTH + this.state.order.reduce(
            (total, columnIndex) => total + this.state.widths[columnIndex],
            0,
        );
    }

    updateStatus(message) {
        this.status.classList.remove('error');
        this.status.textContent = message
            ?? `${this.state.totalRows.toLocaleString()} row${this.state.totalRows === 1 ? '' : 's'}`;
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
        this.disposables.forEach(disposable => disposable());
        this.disposables = [];
    }
}

function defaultColumnWidth(column) {
    return Math.max(110, Math.min(260, 48 + String(column.name).length * 8));
}

function setCellValue(cell, value) {
    if (value === null || value === undefined) {
        cell.textContent = '(null)';
        cell.classList.add('null');
        return;
    }
    if (typeof value === 'object') {
        try {
            cell.textContent = JSON.stringify(value);
        } catch {
            cell.textContent = String(value);
        }
        return;
    }
    cell.textContent = String(value);
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
        .kusto-grid-header { display: flex; height: 38px; will-change: transform; }
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
            position: relative; display: grid; grid-template-columns: 1fr auto; grid-template-rows: 21px 15px;
            padding: 2px 8px; user-select: none; cursor: pointer;
            color: var(--vscode-editor-foreground);
        }
        .kusto-grid-header-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .kusto-grid-column-type { grid-row: 2; font-size: 10px; color: var(--vscode-descriptionForeground); }
        .kusto-grid-sort { padding-left: 4px; }
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
