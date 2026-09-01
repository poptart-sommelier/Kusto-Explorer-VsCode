// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    discoverEnrichments,
    parseEnrichmentSnippet,
    type EnrichmentDirectoryEntry,
    type EnrichmentFileSystem,
} from '../../features/enrichmentCatalog';
import { createEnrichmentFileSystem } from '../../features/enrichmentLibrary';

function fakeFileSystem(files: Record<string, string>): EnrichmentFileSystem {
    const directories = new Map<string, EnrichmentDirectoryEntry[]>();
    const add = (key: string, entry: EnrichmentDirectoryEntry) => {
        const entries = directories.get(key) ?? [];
        if (!entries.some(existing => existing.name === entry.name)) {
            entries.push(entry);
        }
        directories.set(key, entries);
    };

    directories.set('', []);
    for (const path of Object.keys(files)) {
        const segments = path.split('/');
        for (let index = 0; index < segments.length; index++) {
            const parent = segments.slice(0, index).join('/');
            const isDirectory = index < segments.length - 1;
            add(parent, { name: segments[index] as string, isDirectory });
            if (isDirectory) {
                const key = segments.slice(0, index + 1).join('/');
                if (!directories.has(key)) {
                    directories.set(key, []);
                }
            }
        }
    }

    return {
        readDirectory: async segments => {
            const entries = directories.get(segments.join('/'));
            if (!entries) {
                throw new Error('Directory not found.');
            }
            return entries;
        },
        readFile: async segments => {
            const text = files[segments.join('/')];
            if (text === undefined) {
                throw new Error('File not found.');
            }
            return text;
        },
    };
}

describe('enrichment snippet parsing', () => {
    it('reads display metadata and prompts from the header', () => {
        const snippet = parseEnrichmentSnippet(['signin', 'failures.kql'], [
            '// @name Failed sign-ins for device',
            '// @description Correlates rows against sign-in logs.',
            '// @prompt lookback:timespan Lookback window',
            'SigninLogs',
            '| where TimeGenerated > ago(lookback)',
        ].join('\n'));

        expect(snippet.id).toBe('signin/failures.kql');
        expect(snippet.group).toBe('signin');
        expect(snippet.name).toBe('Failed sign-ins for device');
        expect(snippet.description).toBe('Correlates rows against sign-in logs.');
        expect(snippet.prompts).toEqual([
            { name: 'lookback', type: 'timespan', label: 'Lookback window' },
        ]);
        expect(snippet.error).toBeUndefined();
    });

    it('falls back to the filename and defaults a missing prompt label', () => {
        const snippet = parseEnrichmentSnippet(['lookup.kql'], [
            '// @prompt threshold:int',
            'LocalResult | where Count > threshold',
        ].join('\n'));

        expect(snippet.name).toBe('lookup');
        expect(snippet.group).toBe('');
        expect(snippet.prompts).toEqual([
            { name: 'threshold', type: 'int', label: 'threshold' },
        ]);
    });

    it('strips only directive lines and keeps ordinary leading comments', () => {
        const snippet = parseEnrichmentSnippet(['x.kql'], [
            '// Copyright someone',
            '// @name Kept',
            '// Explains the query',
            'LocalResult',
        ].join('\n'));

        expect(snippet.body).toBe([
            '// Copyright someone',
            '// Explains the query',
            'LocalResult',
        ].join('\n'));
    });

    it('ignores unknown directives so newer snippets still run', () => {
        const snippet = parseEnrichmentSnippet(['x.kql'], '// @future something\nLocalResult');

        expect(snippet.error).toBeUndefined();
        expect(snippet.body).toBe('LocalResult');
    });

    it('reports a prompt that would shadow a generated name', () => {
        const snippet = parseEnrichmentSnippet(['x.kql'], '// @prompt ClickedValue:string V\nLocalResult');

        expect(snippet.error).toContain('ClickedValue');
        expect(snippet.error).toContain('reserved');
        expect(snippet.prompts).toEqual([]);
    });

    it('reports unknown types, duplicates, malformed directives, and empty bodies', () => {
        expect(parseEnrichmentSnippet(['x.kql'], '// @prompt a:notAType L\nLocalResult').error)
            .toContain("Unknown prompt type 'notAType'");
        expect(parseEnrichmentSnippet(['x.kql'], [
            '// @prompt a:int First',
            '// @prompt a:int Second',
            'LocalResult',
        ].join('\n')).error).toContain('declared more than once');
        expect(parseEnrichmentSnippet(['x.kql'], '// @prompt oops\nLocalResult').error)
            .toContain('Invalid @prompt directive');
        expect(parseEnrichmentSnippet(['x.kql'], '// @name Only a header').error)
            .toContain('no KQL');
    });

    it('stops treating directives as header once KQL has started', () => {
        const snippet = parseEnrichmentSnippet(['x.kql'], [
            'LocalResult',
            '// @prompt late:int Too late',
        ].join('\n'));

        expect(snippet.prompts).toEqual([]);
        expect(snippet.body).toContain('// @prompt late:int Too late');
    });
});

describe('enrichment discovery', () => {
    it('finds snippets recursively and groups them by relative folder', async () => {
        const snippets = await discoverEnrichments(fakeFileSystem({
            'root.kql': 'LocalResult',
            'network/dns.kql': 'LocalResult',
            'network/deep/nested.kql': 'LocalResult',
            'notes.txt': 'ignored',
        }));

        expect(snippets.map(snippet => [snippet.group, snippet.name])).toEqual([
            ['', 'root'],
            ['network', 'dns'],
            ['network/deep', 'nested'],
        ]);
    });

    it('skips hidden folders and stops at the depth limit', async () => {
        const snippets = await discoverEnrichments(fakeFileSystem({
            '.hidden/secret.kql': 'LocalResult',
            'a/b/c/too-deep.kql': 'LocalResult',
            'a/shallow.kql': 'LocalResult',
        }), 2);

        expect(snippets.map(snippet => snippet.id)).toEqual(['a/shallow.kql']);
    });

    it('keeps listing other snippets when one file cannot be read', async () => {
        const base = fakeFileSystem({ 'good.kql': 'LocalResult', 'bad.kql': 'LocalResult' });
        const snippets = await discoverEnrichments({
            readDirectory: base.readDirectory,
            readFile: async segments => {
                if (segments.join('/') === 'bad.kql') {
                    throw new Error('denied');
                }
                return base.readFile(segments);
            },
        });

        expect(snippets.map(snippet => snippet.id)).toEqual(['good.kql']);
    });

    it('treats a symlinked folder as a directory', async () => {
        vi.spyOn(vscode.workspace.fs, 'readDirectory').mockImplementation(async uri => {
            const path = (uri as { fsPath: string }).fsPath;
            return path.endsWith('/linked')
                ? [['inside.kql', vscode.FileType.File | vscode.FileType.SymbolicLink]]
                : [['linked', vscode.FileType.Directory | vscode.FileType.SymbolicLink]];
        });
        vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
            new TextEncoder().encode('LocalResult'));

        const snippets = await discoverEnrichments(
            createEnrichmentFileSystem(vscode.Uri.file('/library')));

        expect(snippets.map(snippet => snippet.id)).toEqual(['linked/inside.kql']);
        vi.restoreAllMocks();
    });
});
