// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Minimal mock of the vscode module for unit testing.
// Add additional mocks here as needed when testing features that use the vscode API.

export const workspace = {
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    getConfiguration: () => ({
        get: (_key: string, defaultValue?: unknown) => defaultValue,
        has: () => false,
        inspect: () => undefined,
        update: async () => {},
    }),
    registerFileSystemProvider: () => ({ dispose: () => {} }),
    registerNotebookSerializer: () => ({ dispose: () => {} }),
    onDidOpenNotebookDocument: () => ({ dispose: () => {} }),
    onDidChangeNotebookDocument: () => ({ dispose: () => {} }),
    onDidCloseNotebookDocument: () => ({ dispose: () => {} }),
    onWillSaveNotebookDocument: () => ({ dispose: () => {} }),
    applyEdit: async () => true,
    openNotebookDocument: async (_type: string, data: NotebookData) => ({
        notebookType: _type,
        metadata: data.metadata ?? {},
        uri: Uri.parse('untitled:notebook.kqlnb'),
        getCells: () => [],
    }),
    notebookDocuments: [],
    workspaceFolders: [],
};

export const window = {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async <T>(items: readonly T[]) => items[0],
    showNotebookDocument: async (notebook: unknown) => ({ notebook }),
    activeNotebookEditor: undefined,
    createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        clear: () => {},
        show: () => {},
        dispose: () => {},
    }),
};

export const Uri = {
    parse: (value: string) => ({ toString: () => value, fsPath: value, scheme: 'file' }),
    file: (path: string) => ({ toString: () => path, fsPath: path, scheme: 'file' }),
};

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
}

export enum FileChangeType {
    Changed = 1,
    Created = 2,
    Deleted = 3,
}

export enum NotebookCellKind {
    Markup = 1,
    Code = 2,
}

export class NotebookCellData {
    outputs?: NotebookCellOutput[];
    metadata?: { [key: string]: unknown };
    constructor(
        public kind: NotebookCellKind,
        public value: string,
        public languageId: string,
    ) {}
}

export class NotebookData {
    metadata?: { [key: string]: unknown };
    constructor(public cells: NotebookCellData[]) {}
}

export class NotebookCellOutputItem {
    private constructor(
        public data: unknown,
        public mime: string,
    ) {}

    static text(value: string, mime: string = 'text/plain') {
        return new NotebookCellOutputItem(value, mime);
    }

    static error(value: Error) {
        return new NotebookCellOutputItem(value, 'application/vnd.code.notebook.error');
    }
}

export class NotebookCellOutput {
    constructor(
        public items: NotebookCellOutputItem[],
        public metadata?: { [key: string]: unknown },
    ) {}
}

export class CancellationError extends Error {}

export class NotebookEdit {
    static updateCellMetadata(index: number, metadata: { [key: string]: unknown }) {
        return { index, metadata };
    }

    static updateNotebookMetadata(metadata: { [key: string]: unknown }) {
        return { metadata };
    }
}

export class WorkspaceEdit {
    entries: Array<{ uri: unknown; edits: unknown[] }> = [];
    set(uri: unknown, edits: unknown[]) {
        this.entries.push({ uri, edits });
    }
}

export const __notebookControllers: Array<Record<string, unknown>> = [];

export const notebooks = {
    createNotebookController: (id: string, notebookType: string, label: string) => {
        const controller: Record<string, unknown> = {
            id,
            notebookType,
            label,
            supportedLanguages: [],
            supportsExecutionOrder: false,
            executeHandler: () => undefined,
            createNotebookCellExecution: () => {
                throw new Error('No notebook execution mock configured.');
            },
            dispose: () => undefined,
        };
        __notebookControllers.push(controller);
        return controller;
    },
};

export class EventEmitter<T = void> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data?: T) { for (const l of this.listeners) l(data as T); }
    dispose() { this.listeners = []; }
}

export class Disposable {
    static from(..._disposables: { dispose: () => unknown }[]) {
        return new Disposable(() => {});
    }
    constructor(private callOnDispose: () => unknown) {}
    dispose() { this.callOnDispose(); }
}
