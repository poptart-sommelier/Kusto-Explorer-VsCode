// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Discovery and parsing for the user-provided KQL enrichment library.
 *
 * This module is the testable data model half of the enrichment feature: it contains no VS Code UI
 * and reaches the file system only through {@link EnrichmentFileSystem}.
 */

/** Names the generated enrichment cell always defines. A prompt may not reuse one. */
export const ENRICHMENT_RESERVED_NAMES = [
    'LocalResult',
    'ClickedColumn',
    'ClickedValue',
    'SelectedColumns',
] as const;

/** Folder depth scanned below the library root. */
export const ENRICHMENT_MAX_DEPTH = 5;

/** Kusto scalar types a snippet may declare for a prompt. */
export const ENRICHMENT_PROMPT_TYPES = [
    'bool',
    'datetime',
    'decimal',
    'dynamic',
    'guid',
    'int',
    'long',
    'real',
    'string',
    'timespan',
] as const;

export type EnrichmentPromptType = typeof ENRICHMENT_PROMPT_TYPES[number];

export interface EnrichmentPrompt {
    name: string;
    type: EnrichmentPromptType;
    label: string;
}

export interface EnrichmentSnippet {
    /** Stable identifier: the snippet path relative to the library root, using `/`. */
    id: string;
    /** Display name: `@name` when present, otherwise the filename without its extension. */
    name: string;
    /** Relative folder path used to group the snippet, or `''` for the library root. */
    group: string;
    description?: string;
    prompts: EnrichmentPrompt[];
    /** Snippet KQL with `@` directive lines removed. */
    body: string;
    /** Set when the header is invalid. The snippet is listed but cannot be run. */
    error?: string;
}

export interface EnrichmentDirectoryEntry {
    name: string;
    isDirectory: boolean;
}

/**
 * File-system access for the enrichment library. Paths are segment arrays relative to the library
 * root so that the catalog never has to join platform-specific paths.
 */
export interface EnrichmentFileSystem {
    readDirectory(segments: string[]): Promise<EnrichmentDirectoryEntry[]>;
    readFile(segments: string[]): Promise<string>;
}

const DIRECTIVE_PATTERN = /^\s*\/\/\s*@([A-Za-z][A-Za-z0-9_-]*)\b[ \t]*(.*)$/;
const PROMPT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z]+)\s*(.*)$/;
const COMMENT_PATTERN = /^\s*\/\//;

/**
 * Recursively discovers `.kql` snippets under the library root.
 *
 * Hidden and dot-prefixed folders are skipped, and scanning stops at {@link ENRICHMENT_MAX_DEPTH}.
 * Unreadable folders and files are skipped rather than failing the whole scan, so one bad file
 * cannot hide an entire library.
 */
export async function discoverEnrichments(
    fileSystem: EnrichmentFileSystem,
    maxDepth: number = ENRICHMENT_MAX_DEPTH,
): Promise<EnrichmentSnippet[]> {
    const snippets: EnrichmentSnippet[] = [];
    await scanDirectory(fileSystem, [], snippets, maxDepth);
    return snippets.sort(compareSnippets);
}

async function scanDirectory(
    fileSystem: EnrichmentFileSystem,
    segments: string[],
    snippets: EnrichmentSnippet[],
    remainingDepth: number,
): Promise<void> {
    let entries: EnrichmentDirectoryEntry[];
    try {
        entries = await fileSystem.readDirectory(segments);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const childSegments = [...segments, entry.name];
        if (entry.isDirectory) {
            if (remainingDepth > 1) {
                await scanDirectory(fileSystem, childSegments, snippets, remainingDepth - 1);
            }
            continue;
        }
        if (!entry.name.toLowerCase().endsWith('.kql')) {
            continue;
        }
        let text: string;
        try {
            text = await fileSystem.readFile(childSegments);
        } catch {
            continue;
        }
        snippets.push(parseEnrichmentSnippet(childSegments, text));
    }
}

/**
 * Parses one snippet file into its display metadata, declared prompts, and runnable body.
 *
 * A header is a run of `// @directive` lines at the top of the file. Only those directive lines are
 * removed from the body, so ordinary leading comments such as a copyright banner survive into the
 * generated cell. Unknown directives are ignored so that an older extension can still run a snippet
 * written for a newer one.
 */
export function parseEnrichmentSnippet(
    segments: string[],
    text: string,
): EnrichmentSnippet {
    const id = segments.join('/');
    const fileName = segments[segments.length - 1] ?? '';
    const group = segments.slice(0, -1).join('/');
    const lines = text.split(/\r?\n/);

    let displayName: string | undefined;
    let description: string | undefined;
    const prompts: EnrichmentPrompt[] = [];
    const errors: string[] = [];
    const bodyLines: string[] = [];
    let inHeader = true;

    for (const line of lines) {
        if (inHeader) {
            const isBlank = line.trim().length === 0;
            const directive = DIRECTIVE_PATTERN.exec(line);
            if (directive) {
                applyDirective(directive[1] ?? '', (directive[2] ?? '').trim(), {
                    setName: value => { displayName = value; },
                    setDescription: value => { description = value; },
                    prompts,
                    errors,
                });
                continue;
            }
            if (!isBlank && !COMMENT_PATTERN.test(line)) {
                inHeader = false;
            }
        }
        bodyLines.push(line);
    }

    const body = bodyLines.join('\n').trim();
    if (body.length === 0) {
        errors.push('The snippet contains no KQL.');
    }

    return {
        id,
        name: displayName ?? stripExtension(fileName),
        group,
        ...(description ? { description } : {}),
        prompts,
        body,
        ...(errors.length > 0 ? { error: errors.join(' ') } : {}),
    };
}

function applyDirective(
    directive: string,
    value: string,
    sink: {
        setName: (value: string) => void;
        setDescription: (value: string) => void;
        prompts: EnrichmentPrompt[];
        errors: string[];
    },
): void {
    switch (directive.toLowerCase()) {
        case 'name':
            if (value.length > 0) {
                sink.setName(value);
            }
            return;
        case 'description':
            if (value.length > 0) {
                sink.setDescription(value);
            }
            return;
        case 'prompt': {
            const prompt = PROMPT_PATTERN.exec(value);
            if (!prompt) {
                sink.errors.push(
                    `Invalid @prompt directive '${value}'. Expected '@prompt name:type description'.`);
                return;
            }
            const name = prompt[1] ?? '';
            const type = (prompt[2] ?? '').toLowerCase();
            const label = (prompt[3] ?? '').trim();
            if (!isPromptType(type)) {
                sink.errors.push(
                    `Unknown prompt type '${prompt[2]}' for '${name}'. Expected one of ${ENRICHMENT_PROMPT_TYPES.join(', ')}.`);
                return;
            }
            if ((ENRICHMENT_RESERVED_NAMES as readonly string[]).includes(name)) {
                sink.errors.push(
                    `Prompt '${name}' uses a name reserved by the generated cell.`);
                return;
            }
            if (sink.prompts.some(existing => existing.name === name)) {
                sink.errors.push(`Prompt '${name}' is declared more than once.`);
                return;
            }
            sink.prompts.push({ name, type, label: label.length > 0 ? label : name });
            return;
        }
        default:
            return;
    }
}

function isPromptType(value: string): value is EnrichmentPromptType {
    return (ENRICHMENT_PROMPT_TYPES as readonly string[]).includes(value);
}

function stripExtension(fileName: string): string {
    const index = fileName.lastIndexOf('.');
    return index > 0 ? fileName.slice(0, index) : fileName;
}

function compareSnippets(left: EnrichmentSnippet, right: EnrichmentSnippet): number {
    const byGroup = left.group.localeCompare(right.group, undefined, { sensitivity: 'base' });
    return byGroup !== 0
        ? byGroup
        : left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}
