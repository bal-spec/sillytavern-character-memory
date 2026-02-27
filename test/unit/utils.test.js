import { describe, it, expect } from 'vitest';
import { truncateText, reindexEditingSet, stripNonDiegetic, formatChatMessages } from '../../lib.js';

// ─── truncateText ──────────────────────────────────────────────────────

describe('truncateText', () => {
    it('returns short text unchanged', () => {
        expect(truncateText('Hello', 100)).toBe('Hello');
    });

    it('returns null/empty/undefined as-is', () => {
        expect(truncateText(null, 100)).toBe(null);
        expect(truncateText('', 100)).toBe('');
        expect(truncateText(undefined, 100)).toBe(undefined);
    });

    it('truncates long text and adds suffix', () => {
        const text = 'A'.repeat(200);
        const result = truncateText(text, 100);
        expect(result.length).toBeLessThan(200);
        expect(result).toContain('[...truncated]');
    });

    it('breaks at newline boundary when possible', () => {
        // 60% through is char 60, so a newline at position 70 (>50% of 100) should be used
        const text = 'A'.repeat(70) + '\n' + 'B'.repeat(80);
        const result = truncateText(text, 100);
        expect(result).toBe('A'.repeat(70) + '\n[...truncated]');
    });

    it('does not break at newline if too early in the string', () => {
        // Newline at position 10 (<50% of 100) — should not be used as break point
        const text = 'A'.repeat(10) + '\n' + 'B'.repeat(200);
        const result = truncateText(text, 100);
        // Should truncate at maxChars, not at the early newline
        expect(result).toBe('A'.repeat(10) + '\n' + 'B'.repeat(89) + '\n[...truncated]');
    });

    it('returns text unchanged when exactly at limit', () => {
        const text = 'A'.repeat(100);
        expect(truncateText(text, 100)).toBe(text);
    });
});

// ─── reindexEditingSet ─────────────────────────────────────────────────

describe('reindexEditingSet', () => {
    it('removes the deleted index and shifts higher indices down', () => {
        const set = new Set([0, 2, 4]);
        reindexEditingSet(set, 2);
        expect(set).toEqual(new Set([0, 3]));
    });

    it('leaves indices below removed index unchanged', () => {
        const set = new Set([0, 1]);
        reindexEditingSet(set, 5);
        expect(set).toEqual(new Set([0, 1]));
    });

    it('handles empty set', () => {
        const set = new Set();
        reindexEditingSet(set, 3);
        expect(set.size).toBe(0);
    });

    it('handles removing the only index', () => {
        const set = new Set([3]);
        reindexEditingSet(set, 3);
        expect(set.size).toBe(0);
    });

    it('shifts multiple indices above removal point', () => {
        const set = new Set([1, 3, 5, 7]);
        reindexEditingSet(set, 2);
        expect(set).toEqual(new Set([1, 2, 4, 6]));
    });
});

// ─── stripNonDiegetic ────────────────────────────────────────────────

describe('stripNonDiegetic', () => {
    it('removes markdown code blocks', () => {
        const input = 'Before ```const x = 1;\nconsole.log(x);``` After';
        expect(stripNonDiegetic(input)).toBe('Before  After');
    });

    it('removes details sections', () => {
        const input = 'Before <details><summary>Hidden</summary>Secret content</details> After';
        expect(stripNonDiegetic(input)).toBe('Before  After');
    });

    it('removes markdown tables', () => {
        const input = 'Before\n| Col1 | Col2 |\n| --- | --- |\n| A | B |\nAfter';
        expect(stripNonDiegetic(input)).toBe('Before\n\nAfter');
    });

    it('removes HTML tags', () => {
        const input = 'Hello <b>world</b> and <img src="x" /> done';
        expect(stripNonDiegetic(input)).toBe('Hello world and  done');
    });

    it('collapses 3+ newlines to 2', () => {
        const input = 'Line 1\n\n\n\nLine 2';
        expect(stripNonDiegetic(input)).toBe('Line 1\n\nLine 2');
    });

    it('handles combined non-diegetic content', () => {
        const input = '*She smiles* ```image: portrait``` and shows a table\n| x | y |\n| 1 | 2 |\nthen continues';
        const result = stripNonDiegetic(input);
        expect(result).not.toContain('```');
        expect(result).not.toContain('| x |');
        expect(result).toContain('*She smiles*');
        expect(result).toContain('then continues');
    });

    it('returns empty string for all-non-diegetic input', () => {
        const input = '```only code here```';
        expect(stripNonDiegetic(input).trim()).toBe('');
    });
});

// ─── formatChatMessages ─────────────────────────────────────────────

describe('formatChatMessages', () => {
    const makeMsg = (name, mes, overrides = {}) => ({
        name, mes, is_user: false, is_system: false, ...overrides,
    });

    it('formats messages as "Name: text"', () => {
        const chat = [
            makeMsg('Alice', 'Hello there'),
            makeMsg('Bob', 'Hi Alice'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).toBe('Alice: Hello there\n\nBob: Hi Alice');
    });

    it('skips empty messages', () => {
        const chat = [
            makeMsg('Alice', 'Hello'),
            makeMsg('Bob', ''),
            makeMsg('Alice', 'Still here'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).toBe('Alice: Hello\n\nAlice: Still here');
        expect(result.messageCount).toBe(2);
    });

    it('skips system-only messages (no name, no user)', () => {
        const chat = [
            makeMsg('Alice', 'Hello'),
            makeMsg(null, 'System narrator text', { is_system: true }),
            makeMsg('Bob', 'Hi'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).not.toContain('System narrator');
    });

    it('keeps system messages that have a name', () => {
        const chat = [
            makeMsg('Extension', 'Some extension text', { is_system: true }),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).toContain('Extension: Some extension text');
    });

    it('strips non-diegetic content from messages', () => {
        const chat = [
            makeMsg('Alice', 'She smiled ```image prompt here``` and waved'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).not.toContain('```');
        expect(result.text).toContain('She smiled');
    });

    it('respects startIndex and endIndex', () => {
        const chat = [
            makeMsg('A', 'msg0'),
            makeMsg('B', 'msg1'),
            makeMsg('C', 'msg2'),
            makeMsg('D', 'msg3'),
        ];
        const result = formatChatMessages(chat, 1, 3);
        expect(result.text).toBe('B: msg1\n\nC: msg2');
        expect(result.startIndex).toBe(1);
        expect(result.endIndex).toBe(2);
    });

    it('returns empty for out-of-range indices', () => {
        const chat = [makeMsg('A', 'msg')];
        const result = formatChatMessages(chat, 5, 10);
        expect(result.text).toBe('');
    });
});
