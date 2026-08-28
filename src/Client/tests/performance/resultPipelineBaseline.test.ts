// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { IClipboard } from '../../features/clipboard';
import { DataTableProvider } from '../../features/dataTableProvider';
import { NullServer, type ResultTable } from '../../features/server';
import type { IWebView } from '../../features/webview';

const rowCount = 100_000;
const columnCount = 20;

describe('Current result pipeline baseline', () => {
    it('measures transport serialization and synchronous webview construction', () => {
        const fixtureStartHeap = process.memoryUsage().heapUsed;
        const fixtureStart = performance.now();
        const table = createMixedTypeTable();
        const fixtureMs = performance.now() - fixtureStart;
        const fixtureHeapBytes = process.memoryUsage().heapUsed - fixtureStartHeap;

        const transportStartHeap = process.memoryUsage().heapUsed;
        const transportStart = performance.now();
        let transportJson: string | undefined = JSON.stringify(table);
        const transportSerializationMs = performance.now() - transportStart;
        const transportUtf8Bytes = Buffer.byteLength(transportJson, 'utf8');
        const transportHeapBytes = process.memoryUsage().heapUsed - transportStartHeap;
        transportJson = undefined;

        let renderedContent = '';
        const webview: IWebView = {
            setup: () => undefined,
            setContent: html => { renderedContent = html; },
            invoke: () => undefined,
            handle: () => ({ dispose: () => undefined }),
        };
        const clipboard: IClipboard = {
            setContext: () => undefined,
            getContext: () => undefined,
            clearContext: () => undefined,
            copyItems: async () => undefined,
            copyText: async () => undefined,
        };

        const renderStartHeap = process.memoryUsage().heapUsed;
        const renderStart = performance.now();
        const view = new DataTableProvider(new NullServer(), clipboard).createView(webview, table);
        const synchronousWebviewConstructionMs = performance.now() - renderStart;
        const webviewUtf8Bytes = Buffer.byteLength(renderedContent, 'utf8');
        const webviewHeapBytes = process.memoryUsage().heapUsed - renderStartHeap;

        console.log(JSON.stringify({
            runtime: process.version,
            rows: rowCount,
            columns: columnCount,
            fixtureMs,
            fixtureHeapBytes,
            transportSerializationMs,
            transportUtf8Bytes,
            transportHeapBytes,
            synchronousWebviewConstructionMs,
            webviewUtf8Bytes,
            webviewHeapBytes,
        }, null, 2));

        expect(table.rows).toHaveLength(rowCount);
        expect(table.columns).toHaveLength(columnCount);
        expect(transportUtf8Bytes).toBeGreaterThan(0);
        expect(webviewUtf8Bytes).toBeGreaterThan(transportUtf8Bytes);

        view.dispose();
        renderedContent = '';
        expect(transportJson).toBeUndefined();
    });
});

function createMixedTypeTable(): ResultTable {
    const columns = Array.from({ length: columnCount }, (_, index) => {
        const types = ['string', 'int', 'long', 'real', 'decimal', 'bool', 'datetime', 'timespan', 'guid', 'dynamic'];
        return {
            name: `Column${index}`,
            type: types[index % types.length]!,
        };
    });

    const rows = Array.from({ length: rowCount }, (_, index) => {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        const guidPrefix = index.toString(16).padStart(8, '0');
        return [
            index % 17 === 0 ? null : `row-${index.toString().padStart(6, '0')}`,
            index,
            index * 10_000,
            index / 3,
            index / 7,
            index % 2 === 0,
            timestamp,
            `${Math.floor(index / 3600)}:${Math.floor(index / 60) % 60}:${index % 60}`,
            `${guidPrefix}-0000-0000-0000-000000000000`,
            { index, category: `group-${index % 25}` },
            `detail-${index % 1000}`,
            -index,
            index * 100_000,
            Math.sin(index),
            index / 11,
            index % 3 === 0,
            timestamp,
            `${Math.floor(index / 60)}:${index % 60}`,
            `${guidPrefix}-1111-1111-1111-111111111111`,
            { index, nested: { active: index % 2 === 0 } },
        ];
    });

    return { name: 'Baseline', columns, rows };
}
