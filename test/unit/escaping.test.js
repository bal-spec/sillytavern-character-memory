import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeAttr, unescapeAttr } from '../../lib.js';

// ─── escapeHtml ────────────────────────────────────────────────────────

describe('escapeHtml', () => {
    it('escapes all five dangerous characters', () => {
        expect(escapeHtml('&')).toBe('&amp;');
        expect(escapeHtml('<')).toBe('&lt;');
        expect(escapeHtml('>')).toBe('&gt;');
        expect(escapeHtml('"')).toBe('&quot;');
        expect(escapeHtml("'")).toBe('&#39;');
    });

    it('escapes a string with mixed dangerous characters', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe(
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
        );
    });

    it('leaves safe strings unchanged', () => {
        expect(escapeHtml('Hello world')).toBe('Hello world');
    });

    it('coerces numbers to string', () => {
        expect(escapeHtml(42)).toBe('42');
    });

    it('handles empty string', () => {
        expect(escapeHtml('')).toBe('');
    });

    it('does not double-escape already-escaped input', () => {
        // This is expected behavior — escapeHtml escapes & in &amp; to &amp;amp;
        // This confirms the function is a single-pass escaper, not idempotent
        const once = escapeHtml('&');
        const twice = escapeHtml(once);
        expect(once).toBe('&amp;');
        expect(twice).toBe('&amp;amp;');
    });
});

// ─── escapeAttr / unescapeAttr ─────────────────────────────────────────

describe('escapeAttr', () => {
    it('escapes ampersands and double quotes', () => {
        expect(escapeAttr('Tom & Jerry')).toBe('Tom &amp; Jerry');
        expect(escapeAttr('She said "hi"')).toBe('She said &quot;hi&quot;');
    });

    it('escapes < and > so a theme label cannot break the <memory> tag it is embedded in', () => {
        expect(escapeAttr('Trust > Betrayal')).toBe('Trust &gt; Betrayal');
        expect(escapeAttr('A < B')).toBe('A &lt; B');
    });

    it('handles combined special characters', () => {
        expect(escapeAttr('A & "B"')).toBe('A &amp; &quot;B&quot;');
    });

    it('leaves safe strings unchanged', () => {
        expect(escapeAttr('hello')).toBe('hello');
    });

    it('coerces numbers to string', () => {
        expect(escapeAttr(123)).toBe('123');
    });
});

describe('unescapeAttr', () => {
    it('unescapes &amp; and &quot;', () => {
        expect(unescapeAttr('Tom &amp; Jerry')).toBe('Tom & Jerry');
        expect(unescapeAttr('She said &quot;hi&quot;')).toBe('She said "hi"');
    });

    it('unescapes &lt; and &gt;', () => {
        expect(unescapeAttr('Trust &gt; Betrayal')).toBe('Trust > Betrayal');
        expect(unescapeAttr('A &lt; B')).toBe('A < B');
    });

    it('round-trips with escapeAttr', () => {
        const original = 'Bob & Alice "together"';
        expect(unescapeAttr(escapeAttr(original))).toBe(original);
    });

    it('round-trips a theme label containing > without corrupting it', () => {
        const original = 'Meeting > Argument';
        expect(unescapeAttr(escapeAttr(original))).toBe(original);
    });

    it('handles strings with no escaped sequences', () => {
        expect(unescapeAttr('plain text')).toBe('plain text');
    });
});
