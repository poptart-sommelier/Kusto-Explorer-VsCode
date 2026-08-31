import { describe, expect, it } from 'vitest';
import {
    calculateAutoFitWidth,
    clampColumnWidth,
    continuationActionLabel,
    continuationProgressMessage,
    displayCellText,
} from '../../renderers/kustoResultRenderer.js';

describe('kusto result renderer helpers', () => {
    it('labels cell creation with the active result scope', () => {
        expect(continuationActionLabel(false, false)).toBe('Create cell from all results');
        expect(continuationActionLabel(false, true)).toBe('Create cell from filtered results');
        expect(continuationActionLabel(true, true)).toBe('Create cell from selection');
    });

    it('reports progress for the active result scope', () => {
        expect(continuationProgressMessage(false, false)).toBe('Creating snapshot from all results...');
        expect(continuationProgressMessage(false, true)).toBe('Creating snapshot from filtered results...');
        expect(continuationProgressMessage(true, true)).toBe('Creating snapshot from selection...');
    });

    it('allows manual widths well beyond the former 600 pixel limit', () => {
        expect(clampColumnWidth(20)).toBe(70);
        expect(clampColumnWidth(25_000)).toBe(25_000);
        expect(clampColumnWidth(2_000_000)).toBe(1_000_000);
    });

    it('fits a column to the widest value in loaded pages', () => {
        const pages = [{
            rows: [
                { values: ['short'] },
                { values: ['the widest loaded value'] },
            ],
        }];

        expect(calculateAutoFitWidth(
            { name: 'Name', type: 'string' },
            0,
            pages,
            value => value.length * 10,
        )).toBe(250);
    });

    it('measures headings with their rendered font', () => {
        expect(calculateAutoFitWidth(
            { name: 'Wide heading', type: 'string' },
            0,
            [],
            value => value.length * 5,
            value => value.length * 12,
        )).toBe(186);
    });

    it('uses the same text for sizing and rendering complex values', () => {
        expect(displayCellText(null)).toBe('(null)');
        expect(displayCellText({ nested: true })).toBe('{"nested":true}');
    });
});
