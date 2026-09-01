// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import {
    discoverEnrichments,
    type EnrichmentFileSystem,
    type EnrichmentSnippet,
} from './enrichmentCatalog';
import type {
    ResultSessionColumn,
    ResultSessionEnrichmentPrompt,
} from './resultSession';

export const ENRICHMENT_FOLDER_SETTING = 'msKustoExplorer.notebook.enrichmentFolder';

export interface EnrichmentSelection {
    snippet: EnrichmentSnippet;
    prompts: ResultSessionEnrichmentPrompt[];
}

/**
 * Presents the configured enrichment library and collects the inputs a snippet declares.
 *
 * This is the VS Code-facing half of the enrichment feature; discovery and header parsing live in
 * the testable {@link discoverEnrichments} data model.
 */
export interface IEnrichmentLibrary {
    /**
     * Returns the chosen snippet and its resolved prompt values, or undefined when the user
     * cancels or the library cannot offer anything to run.
     */
    pickEnrichment(columns: ResultSessionColumn[]): Promise<EnrichmentSelection | undefined>;
}

export class EnrichmentLibrary implements IEnrichmentLibrary {
    async pickEnrichment(
        columns: ResultSessionColumn[],
    ): Promise<EnrichmentSelection | undefined> {
        const root = this.getConfiguredRoot();
        if (!root) {
            await this.promptForFolder();
            return undefined;
        }

        const snippets = await discoverEnrichments(createEnrichmentFileSystem(root));
        if (snippets.length === 0) {
            const choice = await vscode.window.showInformationMessage(
                `No .kql enrichments were found in ${root.fsPath}.`,
                'Open Folder',
                'Change Folder',
            );
            if (choice === 'Open Folder') {
                await vscode.commands.executeCommand('revealFileInOS', root);
            } else if (choice === 'Change Folder') {
                await this.selectFolder();
            }
            return undefined;
        }

        const snippet = await this.pickSnippet(snippets);
        if (!snippet) {
            return undefined;
        }
        if (snippet.error) {
            throw new Error(`Enrichment '${snippet.id}' cannot be run. ${snippet.error}`);
        }

        const prompts = await this.collectPrompts(snippet, columns);
        return prompts ? { snippet, prompts } : undefined;
    }

    private getConfiguredRoot(): vscode.Uri | undefined {
        const configured = vscode.workspace
            .getConfiguration()
            .get<string>(ENRICHMENT_FOLDER_SETTING);
        return configured && configured.trim().length > 0
            ? vscode.Uri.file(configured.trim())
            : undefined;
    }

    private async promptForFolder(): Promise<void> {
        const choice = await vscode.window.showInformationMessage(
            'No Kusto enrichment folder is configured.',
            'Select Folder...',
        );
        if (choice === 'Select Folder...') {
            await this.selectFolder();
        }
    }

    private async selectFolder(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Use as enrichment folder',
        });
        const folder = picked?.[0];
        if (!folder) {
            return;
        }
        await vscode.workspace.getConfiguration().update(
            ENRICHMENT_FOLDER_SETTING,
            folder.fsPath,
            vscode.ConfigurationTarget.Global,
        );
    }

    private async pickSnippet(
        snippets: EnrichmentSnippet[],
    ): Promise<EnrichmentSnippet | undefined> {
        const items: Array<vscode.QuickPickItem & { snippet?: EnrichmentSnippet }> = [];
        let group: string | undefined;
        for (const snippet of snippets) {
            if (snippet.group !== group) {
                group = snippet.group;
                items.push({
                    label: group.length > 0 ? group : 'Enrichments',
                    kind: vscode.QuickPickItemKind.Separator,
                });
            }
            items.push({
                label: snippet.name,
                description: snippet.error ? '$(error) invalid header' : snippet.id,
                ...(snippet.description || snippet.error
                    ? { detail: snippet.error ?? snippet.description }
                    : {}),
                snippet,
            });
        }

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Run Kusto Enrichment',
            placeHolder: 'Select an enrichment to run against the selected rows',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return picked?.snippet;
    }

    private async collectPrompts(
        snippet: EnrichmentSnippet,
        columns: ResultSessionColumn[],
    ): Promise<ResultSessionEnrichmentPrompt[] | undefined> {
        const resolved: ResultSessionEnrichmentPrompt[] = [];
        for (const prompt of snippet.prompts) {
            const source = await vscode.window.showQuickPick(
                [
                    { label: 'Enter a value', useColumn: false },
                    { label: 'Use a column from the clicked row', useColumn: true },
                ],
                {
                    title: `${snippet.name}: ${prompt.label}`,
                    placeHolder: `How should '${prompt.name}' (${prompt.type}) be supplied?`,
                },
            );
            if (!source) {
                return undefined;
            }

            if (source.useColumn) {
                const column = await vscode.window.showQuickPick(
                    columns.map((candidate, index) => ({
                        label: candidate.name,
                        description: candidate.type,
                        index,
                    })),
                    {
                        title: `${snippet.name}: ${prompt.label}`,
                        placeHolder: `Column supplying '${prompt.name}'`,
                    },
                );
                if (!column) {
                    return undefined;
                }
                resolved.push({ name: prompt.name, columnIndex: column.index });
                continue;
            }

            const text = await vscode.window.showInputBox({
                title: `${snippet.name}: ${prompt.label}`,
                prompt: prompt.type === 'string'
                    ? `Value for '${prompt.name}'. It is quoted and escaped automatically.`
                    : `Value for '${prompt.name}' as a ${prompt.type} expression, for example 7d or ago(1h).`,
                validateInput: value => value.trim().length > 0
                    ? undefined
                    : 'Enter a value.',
            });
            if (text === undefined) {
                return undefined;
            }
            resolved.push({ name: prompt.name, type: prompt.type, text });
        }
        return resolved;
    }
}

/**
 * Adapts the workspace file system to the catalog.
 *
 * `FileType` is a flag set: the disk provider reports a symlinked directory as
 * `SymbolicLink | Directory`, so the directory bit must be tested rather than compared, otherwise a
 * symlinked folder of shared snippets would be treated as a file and silently skipped.
 */
export function createEnrichmentFileSystem(root: vscode.Uri): EnrichmentFileSystem {
    return {
        readDirectory: async segments => {
            const entries = await vscode.workspace.fs.readDirectory(
                vscode.Uri.joinPath(root, ...segments));
            return entries.map(([name, type]) => ({
                name,
                isDirectory: (type & vscode.FileType.Directory) !== 0,
            }));
        },
        readFile: async segments => {
            const bytes = await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(root, ...segments));
            return new TextDecoder().decode(bytes);
        },
    };
}
