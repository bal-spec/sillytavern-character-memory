import { describe, it, expect } from 'vitest';
import { countMatchesInBlocks, replaceInBlocks, cloneMemoryBlocks } from '../../lib.js';
import { createMemoryEditor } from '../../editor.js';

const sampleBlocks = [
    { chat: 'Cafe visit', date: '2026-01-15 14:30', bullets: ['Alex ordered coffee', 'Discussed the weather'] },
    { chat: 'Park walk', date: '2026-01-16 10:00', bullets: ['Alex and Flux walked in the park', 'Flux chased a squirrel'] },
];

describe('countMatchesInBlocks', () => {
    it('counts case-insensitive matches across bullets', () => {
        expect(countMatchesInBlocks(sampleBlocks, 'alex')).toBe(2);
    });

    it('counts case-sensitive matches', () => {
        expect(countMatchesInBlocks(sampleBlocks, 'alex', true)).toBe(0);
        expect(countMatchesInBlocks(sampleBlocks, 'Alex', true)).toBe(2);
    });

    it('counts matches in chat labels', () => {
        expect(countMatchesInBlocks(sampleBlocks, 'Park')).toBe(2); // chat label + bullet
    });

    it('returns 0 for empty find string', () => {
        expect(countMatchesInBlocks(sampleBlocks, '')).toBe(0);
    });

    it('returns 0 when no matches', () => {
        expect(countMatchesInBlocks(sampleBlocks, 'nonexistent')).toBe(0);
    });

    it('counts multiple matches within a single bullet', () => {
        const blocks = [{ chat: 'Test', date: '', bullets: ['the cat and the dog and the bird'] }];
        expect(countMatchesInBlocks(blocks, 'the')).toBe(3);
    });

    it('handles special regex characters in find string', () => {
        const blocks = [{ chat: 'Test', date: '', bullets: ['[Alex — coffee]', 'price is $5.00'] }];
        expect(countMatchesInBlocks(blocks, '[Alex')).toBe(1);
        expect(countMatchesInBlocks(blocks, '$5.00')).toBe(1);
        expect(countMatchesInBlocks(blocks, '(none)')).toBe(0);
    });
});

describe('replaceInBlocks', () => {
    it('replaces all occurrences case-insensitively', () => {
        const blocks = cloneMemoryBlocks(sampleBlocks);
        const count = replaceInBlocks(blocks, 'alex', 'Bob');
        expect(count).toBe(2);
        expect(blocks[0].bullets[0]).toBe('Bob ordered coffee');
        expect(blocks[1].bullets[0]).toBe('Bob and Flux walked in the park');
    });

    it('replaces case-sensitively when requested', () => {
        const blocks = cloneMemoryBlocks(sampleBlocks);
        const count = replaceInBlocks(blocks, 'alex', 'Bob', true);
        expect(count).toBe(0); // 'alex' lowercase doesn't exist
    });

    it('replaces in chat labels', () => {
        const blocks = cloneMemoryBlocks(sampleBlocks);
        const count = replaceInBlocks(blocks, 'Cafe', 'Restaurant');
        expect(count).toBe(1);
        expect(blocks[0].chat).toBe('Restaurant visit');
    });

    it('returns 0 for empty find string', () => {
        const blocks = cloneMemoryBlocks(sampleBlocks);
        const count = replaceInBlocks(blocks, '', 'anything');
        expect(count).toBe(0);
    });

    it('returns 0 when no matches', () => {
        const blocks = cloneMemoryBlocks(sampleBlocks);
        const count = replaceInBlocks(blocks, 'nonexistent', 'replacement');
        expect(count).toBe(0);
    });

    it('handles special regex characters safely', () => {
        const blocks = [{ chat: 'Test', date: '', bullets: ['[Alex — coffee] is good'] }];
        const count = replaceInBlocks(blocks, '[Alex — coffee]', '[Bob — tea]');
        expect(count).toBe(1);
        expect(blocks[0].bullets[0]).toBe('[Bob — tea] is good');
    });

    it('handles replacement string with dollar signs', () => {
        const blocks = [{ chat: 'Test', date: '', bullets: ['price is 5 euros'] }];
        const count = replaceInBlocks(blocks, '5 euros', '$5.00');
        expect(count).toBe(1);
        expect(blocks[0].bullets[0]).toBe('price is $5.00');
    });

    it('treats $& in replacement as literal text, not special pattern', () => {
        const blocks = [{ chat: 'Test', date: '', bullets: ['hello world'] }];
        const count = replaceInBlocks(blocks, 'hello', '$&-goodbye');
        expect(count).toBe(1);
        expect(blocks[0].bullets[0]).toBe('$&-goodbye world');
    });
});

describe('createMemoryEditor find/replace', () => {
    it('countMatches delegates to countMatchesInBlocks', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        expect(editor.countMatches('alex')).toBe(2);
        expect(editor.countMatches('alex', true)).toBe(0);
    });

    it('findAndReplaceAll replaces and returns count', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        const result = editor.findAndReplaceAll('Alex', 'Bob');
        expect(result.replacements).toBe(2);
        expect(editor.getBlocks()[0].bullets[0]).toBe('Bob ordered coffee');
    });

    it('findAndReplaceAll is undoable', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.findAndReplaceAll('Alex', 'Bob');
        expect(editor.getBlocks()[0].bullets[0]).toBe('Bob ordered coffee');
        expect(editor.canUndo()).toBe(true);
        editor.undo();
        expect(editor.getBlocks()[0].bullets[0]).toBe('Alex ordered coffee');
    });

    it('findAndReplaceAll with no matches still pushes undo', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        const result = editor.findAndReplaceAll('nonexistent', 'replacement');
        expect(result.replacements).toBe(0);
        expect(editor.canUndo()).toBe(true);
    });
});
