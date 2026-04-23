import { describe, it, expect } from 'vitest';
import { estimateConsolidationSize, packBlocksIntoChunks } from '../../lib.js';

const block = (bullets, chat = 'c', date = '2024-01-01') => ({ chat, date, bullets });

describe('estimateConsolidationSize', () => {
    it('returns zero for empty memories', () => {
        const r = estimateConsolidationSize([]);
        expect(r.memoriesChars).toBe(0);
        expect(r.promptChars).toBe(0);
        expect(r.outputCharsEstimate).toBe(0);
    });

    it('scales with bullet content and block count', () => {
        const small = estimateConsolidationSize([block(['hello'])]);
        const big = estimateConsolidationSize([
            block(['hello']),
            block(['hello']),
            block(['hello']),
        ]);
        expect(big.memoriesChars).toBeGreaterThan(small.memoriesChars * 2);
    });

    it('includes promptTemplateLength in promptChars', () => {
        const r = estimateConsolidationSize([block(['hi'])], { promptTemplateLength: 1000 });
        expect(r.promptChars).toBeGreaterThanOrEqual(1000);
    });

    it('applies outputRatio to output estimate', () => {
        const r = estimateConsolidationSize([block(['aaaaaaaaaa'])], { outputRatio: 0.25 });
        expect(r.outputCharsEstimate).toBe(Math.round(r.memoriesChars * 0.25));
    });
});

describe('packBlocksIntoChunks', () => {
    it('returns empty array for empty input', () => {
        expect(packBlocksIntoChunks([], 1000)).toEqual([]);
    });

    it('puts small set in a single chunk', () => {
        const blocks = [block(['a']), block(['b']), block(['c'])];
        const chunks = packBlocksIntoChunks(blocks, 10000);
        expect(chunks.length).toBe(1);
        expect(chunks[0].length).toBe(3);
    });

    it('splits large set across multiple chunks preserving order', () => {
        const blocks = Array.from({ length: 20 }, (_, i) => block([`bullet content ${i} padding padding padding`]));
        const chunks = packBlocksIntoChunks(blocks, 200);
        expect(chunks.length).toBeGreaterThan(1);
        const flat = chunks.flat();
        expect(flat.length).toBe(20);
        flat.forEach((b, i) => expect(b.bullets[0]).toContain(`bullet content ${i}`));
    });

    it('places a single oversize block alone without splitting it', () => {
        const huge = block([Array(5000).fill('x').join('')]);
        const small = block(['tiny']);
        const chunks = packBlocksIntoChunks([huge, small], 1000);
        expect(chunks.length).toBe(2);
        expect(chunks[0]).toEqual([huge]);
        expect(chunks[1]).toEqual([small]);
    });
});
