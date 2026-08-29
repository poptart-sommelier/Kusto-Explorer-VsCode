// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Integration Tests', () => {

    test('Kusto language is registered', async () => {
        const languages = await vscode.languages.getLanguages();
        assert.ok(
            languages.includes('kusto'),
            `Expected 'kusto' in registered languages, got: ${languages.join(', ')}`
        );
    });

    test('Can open a Kusto document', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kusto',
            content: 'StormEvents | take 10',
        });
        assert.strictEqual(doc.languageId, 'kusto');
        assert.strictEqual(doc.getText(), 'StormEvents | take 10');
    });

    test('Extension contributes kusto language configuration', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kusto',
            content: '',
        });
        const editor = await vscode.window.showTextDocument(doc);
        assert.ok(editor, 'Should be able to show a kusto document in an editor');
    });

    test('Can create a native Kusto notebook', async () => {
        await vscode.commands.executeCommand('msKustoExplorer.newNotebook');

        const editor = vscode.window.activeNotebookEditor;
        assert.ok(editor, 'Expected the new notebook to be visible');
        assert.strictEqual(editor.notebook.notebookType, 'msKustoExplorer.kqlNotebook');
        assert.strictEqual(editor.notebook.cellCount, 1);
        assert.strictEqual(editor.notebook.cellAt(0).document.languageId, 'kusto');
    });
});
