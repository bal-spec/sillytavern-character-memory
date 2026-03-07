import { describe, it, expect } from 'vitest';
import {
    parseMemories,
    countMemories,
    serializeMemories,
    mergeMemoryBlocks,
    splitMultiTagBullets,
} from '../../lib.js';

// ─── parseMemories ─────────────────────────────────────────────────────

describe('parseMemories', () => {
    it('parses a standard memory block', () => {
        const input = `<memory chat="main_abc" date="2024-01-15 14:30">
- Likes cats
- Has a red car
</memory>`;
        const result = parseMemories(input);
        expect(result).toEqual([
            { chat: 'main_abc', date: '2024-01-15 14:30', bullets: ['Likes cats', 'Has a red car'] },
        ]);
    });

    it('parses multiple blocks', () => {
        const input = `<memory chat="chat1" date="2024-01-01">
- Fact A
</memory>

<memory chat="chat2" date="2024-02-01">
- Fact B
- Fact C
</memory>`;
        const result = parseMemories(input);
        expect(result).toHaveLength(2);
        expect(result[0].chat).toBe('chat1');
        expect(result[1].bullets).toEqual(['Fact B', 'Fact C']);
    });

    it('excludes blocks with no bullets', () => {
        const input = `<memory chat="empty" date="2024-01-01">
some text without bullet prefix
</memory>`;
        const result = parseMemories(input);
        expect(result).toEqual([]);
    });

    it('handles attributes with special characters', () => {
        const input = `<memory chat="Bob &amp; Alice&quot;s chat" date="2024-01-01">
- Met at a cafe
</memory>`;
        const result = parseMemories(input);
        expect(result[0].chat).toBe('Bob & Alice"s chat');
    });

    it('strips metadata-prefixed bullets', () => {
        const input = `<memory chat="test" date="2024-01-01">
[2024-01-01 | test] - Has a dog named Rex
- Plain bullet
</memory>`;
        const result = parseMemories(input);
        expect(result[0].bullets).toEqual(['Has a dog named Rex', 'Plain bullet']);
    });

    it('is case-insensitive for memory tags', () => {
        const input = `<Memory chat="test" date="2024-01-01">
- Case test
</Memory>`;
        const result = parseMemories(input);
        expect(result).toHaveLength(1);
        expect(result[0].bullets).toEqual(['Case test']);
    });

    it('returns empty array for null/undefined/empty input', () => {
        expect(parseMemories(null)).toEqual([]);
        expect(parseMemories(undefined)).toEqual([]);
        expect(parseMemories('')).toEqual([]);
        expect(parseMemories('   ')).toEqual([]);
    });

    it('skips malformed tags gracefully', () => {
        const input = `<memory chat="good" date="2024-01-01">
- Valid bullet
</memory>
<memory chat="unclosed" date="2024-01-01">
- This block is never closed
Some other text here`;
        const result = parseMemories(input);
        expect(result).toHaveLength(1);
        expect(result[0].chat).toBe('good');
    });

    it('defaults chat to "unknown" when attribute is missing', () => {
        const input = `<memory date="2024-01-01">
- No chat attr
</memory>`;
        const result = parseMemories(input);
        expect(result[0].chat).toBe('unknown');
    });

    it('defaults date to empty string when attribute is missing', () => {
        const input = `<memory chat="test">
- No date attr
</memory>`;
        const result = parseMemories(input);
        expect(result[0].date).toBe('');
    });
});

// ─── countMemories ─────────────────────────────────────────────────────

describe('countMemories', () => {
    it('sums bullets across multiple blocks', () => {
        const blocks = [
            { chat: 'a', date: '', bullets: ['one', 'two'] },
            { chat: 'b', date: '', bullets: ['three'] },
        ];
        expect(countMemories(blocks)).toBe(3);
    });

    it('returns 0 for empty array', () => {
        expect(countMemories([])).toBe(0);
    });
});

// ─── serializeMemories ─────────────────────────────────────────────────

describe('serializeMemories', () => {
    const blocks = [
        { chat: 'main_abc', date: '2024-01-15', bullets: ['Likes cats', 'Has red car'] },
        { chat: 'main_def', date: '2024-02-01', bullets: ['Works at a bakery'] },
    ];

    it('serializes in default block mode', () => {
        const result = serializeMemories(blocks);
        expect(result).toContain('<memory chat="main_abc" date="2024-01-15">');
        expect(result).toContain('- Likes cats\n- Has red car');
        expect(result).toContain('</memory>');
        // Blocks separated by double newline
        expect(result).toContain('</memory>\n\n<memory');
    });

    it('serializes in bullet boundary mode', () => {
        const fmt = { boundary: 'bullet', separator: '\n\n', metadata: false };
        const result = serializeMemories(blocks, fmt);
        // Bullets separated by double newline within block
        expect(result).toContain('- Likes cats\n\n- Has red car');
    });

    it('serializes with metadata prefixes', () => {
        const fmt = { boundary: 'bullet', separator: '\n\n', metadata: true };
        const result = serializeMemories(blocks, fmt);
        expect(result).toContain('[2024-01-15 | main_abc] - Likes cats');
    });

    it('serializes with custom separator', () => {
        const fmt = { boundary: 'custom', separator: '\n---\n', metadata: false };
        const result = serializeMemories(blocks, fmt);
        expect(result).toContain('</memory>\n---\n<memory');
    });

    it('escapes special characters in attributes', () => {
        const special = [{ chat: 'Bob & Alice"s', date: '2024', bullets: ['test'] }];
        const result = serializeMemories(special);
        expect(result).toContain('chat="Bob &amp; Alice&quot;s"');
    });

    it('round-trips through parseMemories', () => {
        const serialized = serializeMemories(blocks);
        const parsed = parseMemories(serialized);
        expect(parsed).toEqual(blocks);
    });

    it('round-trips with metadata through parseMemories', () => {
        const fmt = { boundary: 'bullet', separator: '\n\n', metadata: true };
        const serialized = serializeMemories(blocks, fmt);
        const parsed = parseMemories(serialized);
        // Metadata-prefixed bullets should be stripped back to plain text
        expect(parsed).toEqual(blocks);
    });
});

// ─── mergeMemoryBlocks ─────────────────────────────────────────────────

describe('mergeMemoryBlocks', () => {
    it('merges blocks with same chat ID', () => {
        const blocks = [
            { chat: 'main', date: '2024-01-01', bullets: ['A'] },
            { chat: 'main', date: '2024-01-02', bullets: ['B'] },
        ];
        const result = mergeMemoryBlocks(blocks);
        expect(result).toHaveLength(1);
        expect(result[0].bullets).toEqual(['A', 'B']);
        // Keeps date from first occurrence
        expect(result[0].date).toBe('2024-01-01');
    });

    it('keeps blocks with different chat IDs separate', () => {
        const blocks = [
            { chat: 'chat1', date: '2024-01-01', bullets: ['A'] },
            { chat: 'chat2', date: '2024-01-02', bullets: ['B'] },
        ];
        const result = mergeMemoryBlocks(blocks);
        expect(result).toHaveLength(2);
    });

    it('preserves order of first occurrence', () => {
        const blocks = [
            { chat: 'first', date: '', bullets: ['1'] },
            { chat: 'second', date: '', bullets: ['2'] },
            { chat: 'first', date: '', bullets: ['3'] },
        ];
        const result = mergeMemoryBlocks(blocks);
        expect(result[0].chat).toBe('first');
        expect(result[0].bullets).toEqual(['1', '3']);
        expect(result[1].chat).toBe('second');
    });

    it('does not mutate input blocks', () => {
        const blocks = [
            { chat: 'main', date: '', bullets: ['A'] },
            { chat: 'main', date: '', bullets: ['B'] },
        ];
        const originalBullets = [...blocks[0].bullets];
        mergeMemoryBlocks(blocks);
        expect(blocks[0].bullets).toEqual(originalBullets);
    });
});

// ─── splitMultiTagBullets ───────────────────────────────────────────────

describe('splitMultiTagBullets', () => {
    it('returns original array when no topic tags', () => {
        const bullets = ['Flux ate salmon', 'Alex went to work'];
        expect(splitMultiTagBullets(bullets)).toEqual([bullets]);
    });

    it('returns original array when one topic tag', () => {
        const bullets = ['[Alex, Flux — adoption day]', 'Flux ate salmon', 'Alex assembled a cat tree'];
        expect(splitMultiTagBullets(bullets)).toEqual([bullets]);
    });

    it('splits at multiple em-dash topic tags', () => {
        const bullets = [
            '[Alex, Flux — morning routine]', 'Flux woke Alex', 'Alex fed Flux',
            '[Alex, Flux — evening bonding]', 'They watched TV',
            '[Alex, Mike — game night]', 'Mike visited', 'Flux hissed at Mike',
        ];
        expect(splitMultiTagBullets(bullets)).toEqual([
            ['[Alex, Flux — morning routine]', 'Flux woke Alex', 'Alex fed Flux'],
            ['[Alex, Flux — evening bonding]', 'They watched TV'],
            ['[Alex, Mike — game night]', 'Mike visited', 'Flux hissed at Mike'],
        ]);
    });

    it('handles bullets before first topic tag', () => {
        const bullets = [
            'Some orphan bullet',
            '[Alex, Flux — morning]', 'Flux ate',
            '[Alex, Flux — evening]', 'Flux slept',
        ];
        expect(splitMultiTagBullets(bullets)).toEqual([
            ['Some orphan bullet', '[Alex, Flux — morning]', 'Flux ate'],
            ['[Alex, Flux — evening]', 'Flux slept'],
        ]);
    });

    it('handles en-dash and hyphen topic tags', () => {
        const bullets = [
            '[Alex, Flux – morning routine]', 'Flux ate',
            '[Alex, Flux - evening bonding]', 'Flux slept',
        ];
        expect(splitMultiTagBullets(bullets)).toEqual([
            ['[Alex, Flux – morning routine]', 'Flux ate'],
            ['[Alex, Flux - evening bonding]', 'Flux slept'],
        ]);
    });

    it('does not false-positive on hyphenated names without spaces', () => {
        const bullets = ['[Alex-Bob]', 'Something happened'];
        expect(splitMultiTagBullets(bullets)).toEqual([bullets]);
    });

    it('returns empty array wrapper for empty input', () => {
        expect(splitMultiTagBullets([])).toEqual([[]]);
    });
});
