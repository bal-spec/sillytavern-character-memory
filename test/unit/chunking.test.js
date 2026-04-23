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

    it('scales linearly with identical block count (3 copies = 3× one)', () => {
        const small = estimateConsolidationSize([block(['hello'])]);
        const big = estimateConsolidationSize([
            block(['hello']),
            block(['hello']),
            block(['hello']),
        ]);
        expect(big.memoriesChars).toBe(small.memoriesChars * 3);
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
        flat.forEach((b, i) => expect(b).toBe(blocks[i]));
    });

    it('places a single oversize block alone without splitting it', () => {
        const huge = block([Array(5000).fill('x').join('')]);
        const small = block(['tiny']);
        const chunks = packBlocksIntoChunks([huge, small], 1000);
        expect(chunks.length).toBe(2);
        expect(chunks[0]).toEqual([huge]);
        expect(chunks[1]).toEqual([small]);
    });

    it('keeps a block that fits exactly at the budget in the current chunk', () => {
        // Construct a first block whose blockCharCount is well under the budget,
        // plus a second block that exactly fills the remaining headroom. Both
        // should end up in the same chunk (boundary-inclusive packing).
        const budget = 100;
        // blockCharCount = 30 (wrapper) + bullets: each bullet contributes len(text) + 3
        // First block: one bullet of 17 chars → 30 + 17 + 3 = 50 chars
        // Second block: one bullet of 17 chars → 30 + 17 + 3 = 50 chars
        // Total = 100, exactly at budget → should fit in same chunk.
        const bullet = 'x'.repeat(17);
        const a = block([bullet]);
        const b = block([bullet]);
        const chunks = packBlocksIntoChunks([a, b], budget);
        expect(chunks.length).toBe(1);
        expect(chunks[0].length).toBe(2);
    });
});
