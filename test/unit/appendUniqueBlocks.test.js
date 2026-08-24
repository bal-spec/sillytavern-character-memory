import { describe, it, expect } from 'vitest';
import { appendUniqueBlocks } from '../../lib.js';

const block = (chat, date, bullets) => ({ chat, date, bullets });

describe('appendUniqueBlocks', () => {
    it('appends source blocks after the destination blocks', () => {
        const dest = [block('chatA', '2024-01-01', ['Existing'])];
        const src = [block('chatB', '2024-02-01', ['Incoming'])];

        const { blocks, added, skipped } = appendUniqueBlocks(dest, src);

        expect(blocks).toEqual([
            block('chatA', '2024-01-01', ['Existing']),
            block('chatB', '2024-02-01', ['Incoming']),
        ]);
        expect(added).toBe(1);
        expect(skipped).toBe(0);
    });

    it('copies the whole source into an empty destination', () => {
        const src = [block('chatA', '2024-01-01', ['One']), block('chatA', '2024-01-02', ['Two'])];

        const { blocks, added, skipped } = appendUniqueBlocks([], src);

        expect(blocks).toEqual(src);
        expect(added).toBe(2);
        expect(skipped).toBe(0);
    });

    it('skips blocks already present — copying the same file twice is a no-op', () => {
        const dest = [block('chatA', '2024-01-01', ['One']), block('chatA', '2024-01-02', ['Two'])];

        const { blocks, added, skipped } = appendUniqueBlocks(dest, dest);

        expect(blocks).toEqual(dest);
        expect(added).toBe(0);
        expect(skipped).toBe(2);
    });

    it('tops up a destination that holds only part of the source', () => {
        const shared = block('chatA', '2024-01-01', ['One']);
        const dest = [shared];
        const src = [shared, block('chatA', '2024-01-02', ['Two'])];

        const { blocks, added, skipped } = appendUniqueBlocks(dest, src);

        expect(blocks).toHaveLength(2);
        expect(added).toBe(1);
        expect(skipped).toBe(1);
    });

    it('keeps blocks that share chat and date but differ in bullets', () => {
        const dest = [block('chatA', '2024-01-01', ['One'])];
        const src = [block('chatA', '2024-01-01', ['Something else'])];

        const { blocks, added } = appendUniqueBlocks(dest, src);

        expect(blocks).toHaveLength(2);
        expect(added).toBe(1);
    });

    it('treats bullet order as significant', () => {
        const dest = [block('chatA', '2024-01-01', ['One', 'Two'])];
        const src = [block('chatA', '2024-01-01', ['Two', 'One'])];

        const { added } = appendUniqueBlocks(dest, src);

        expect(added).toBe(1);
    });

    it('de-duplicates repeats within the source itself', () => {
        const src = [block('chatA', '2024-01-01', ['One']), block('chatA', '2024-01-01', ['One'])];

        const { blocks, added, skipped } = appendUniqueBlocks([], src);

        expect(blocks).toHaveLength(1);
        expect(added).toBe(1);
        expect(skipped).toBe(1);
    });

    it('does not mutate either input', () => {
        const dest = [block('chatA', '2024-01-01', ['One'])];
        const src = [block('chatB', '2024-02-01', ['Two'])];

        const { blocks } = appendUniqueBlocks(dest, src);
        blocks[0].bullets.push('Mutated');
        blocks[1].bullets.push('Mutated');

        expect(dest[0].bullets).toEqual(['One']);
        expect(src[0].bullets).toEqual(['Two']);
    });

    it('handles null/undefined inputs', () => {
        expect(appendUniqueBlocks(null, null)).toEqual({ blocks: [], added: 0, skipped: 0 });
        expect(appendUniqueBlocks(undefined, [block('c', 'd', ['x'])]).added).toBe(1);
        expect(appendUniqueBlocks([block('c', 'd', ['x'])], undefined).blocks).toHaveLength(1);
    });
});
