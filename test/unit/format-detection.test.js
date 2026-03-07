import { describe, it, expect } from 'vitest';
import { detectFileFormat, convertHeuristic, migrateMemoriesIfNeeded, parseMemories } from '../../lib.js';

// ─── detectFileFormat ──────────────────────────────────────────────────

describe('detectFileFormat', () => {
    it('detects memory_tags format', () => {
        expect(detectFileFormat('<memory chat="x" date="y">\n- bullet\n</memory>')).toBe('memory_tags');
    });

    it('detects memory_headings (legacy) format', () => {
        expect(detectFileFormat('## Memory 1\n- bullet\n## Memory 2\n- bullet')).toBe('memory_headings');
    });

    it('detects bullet list format', () => {
        const bullets = '- one\n- two\n- three\n- four\n- five';
        expect(detectFileFormat(bullets)).toBe('bullets');
    });

    it('detects asterisk bullets as bullets format', () => {
        const bullets = '* one\n* two\n* three\n* four\n* five';
        expect(detectFileFormat(bullets)).toBe('bullets');
    });

    it('detects numbered list format', () => {
        const numbered = '1. First\n2. Second\n3. Third\n4. Fourth';
        expect(detectFileFormat(numbered)).toBe('numbered');
    });

    it('detects numbered list with parentheses', () => {
        const numbered = '1) First\n2) Second\n3) Third\n4) Fourth';
        expect(detectFileFormat(numbered)).toBe('numbered');
    });

    it('detects markdown_headings format', () => {
        const md = '# Section One\nSome text\n## Section Two\nMore text';
        expect(detectFileFormat(md)).toBe('markdown_headings');
    });

    it('returns freeform for plain prose', () => {
        expect(detectFileFormat('This is just some regular text without any special formatting.')).toBe('freeform');
    });

    it('returns freeform for null/undefined/empty', () => {
        expect(detectFileFormat(null)).toBe('freeform');
        expect(detectFileFormat(undefined)).toBe('freeform');
        expect(detectFileFormat('')).toBe('freeform');
        expect(detectFileFormat('   ')).toBe('freeform');
    });

    it('prefers memory_tags over other formats', () => {
        // Content has both <memory> tags and bullet lines
        const mixed = '<memory chat="x" date="y">\n- bullet\n</memory>\n- extra bullet';
        expect(detectFileFormat(mixed)).toBe('memory_tags');
    });
});

// ─── convertHeuristic ──────────────────────────────────────────────────

describe('convertHeuristic', () => {
    it('returns existing blocks for memory_tags format with warning', () => {
        const content = '<memory chat="x" date="2024-01-01">\n- fact\n</memory>';
        const result = convertHeuristic(content, 'memory_tags');
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].bullets).toEqual(['fact']);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/already/i);
    });

    it('converts bullet lists to a single memory block', () => {
        const content = '- Apple\n- Banana\n- Cherry';
        const result = convertHeuristic(content, 'bullets');
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].chat).toBe('imported');
        expect(result.blocks[0].bullets).toEqual(['Apple', 'Banana', 'Cherry']);
    });

    it('converts numbered lists to a single memory block', () => {
        const content = '1. First\n2. Second\n3. Third';
        const result = convertHeuristic(content, 'numbered');
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].bullets).toEqual(['First', 'Second', 'Third']);
    });

    it('converts markdown headings to separate blocks per heading', () => {
        const content = '# Background\n- Born in NYC\n# Personality\n- Cheerful';
        const result = convertHeuristic(content, 'markdown_headings');
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0].chat).toBe('Background');
        expect(result.blocks[0].bullets).toEqual(['Born in NYC']);
        expect(result.blocks[1].chat).toBe('Personality');
        expect(result.blocks[1].bullets).toEqual(['Cheerful']);
    });

    it('converts freeform text by splitting on sentences', () => {
        const content = 'She likes cats. He has a dog. They live together.';
        const result = convertHeuristic(content, 'freeform');
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].bullets).toEqual([
            'She likes cats.',
            'He has a dog.',
            'They live together.',
        ]);
        expect(result.warnings[0]).toMatch(/freeform/i);
    });

    it('handles empty freeform content', () => {
        const result = convertHeuristic('', 'freeform');
        expect(result.blocks).toEqual([]);
        // Empty string for freeform doesn't match sentences
    });

    it('handles memory_headings via migration', () => {
        const content = '## Memory 1\n- Old fact one\n- Old fact two\n## Memory 2\n- Another fact';
        const result = convertHeuristic(content, 'memory_headings');
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0].bullets).toEqual(['Old fact one', 'Old fact two']);
        expect(result.blocks[1].bullets).toEqual(['Another fact']);
    });

    it('includes plain text lines under markdown headings as bullets', () => {
        const content = '# Section\nPlain text line\nAnother plain line';
        const result = convertHeuristic(content, 'markdown_headings');
        expect(result.blocks[0].bullets).toContain('Plain text line');
        expect(result.blocks[0].bullets).toContain('Another plain line');
    });
});

// ─── migrateMemoriesIfNeeded ───────────────────────────────────────────

describe('migrateMemoriesIfNeeded', () => {
    it('returns content unchanged if already in <memory> format', () => {
        const content = '<memory chat="x" date="y">\n- fact\n</memory>';
        expect(migrateMemoriesIfNeeded(content)).toBe(content);
    });

    it('returns null/empty unchanged', () => {
        expect(migrateMemoriesIfNeeded(null)).toBe(null);
        expect(migrateMemoriesIfNeeded('')).toBe('');
        expect(migrateMemoriesIfNeeded('  ')).toBe('  ');
    });

    it('converts old ## Memory N format', () => {
        const content = '## Memory 1\n- Old fact\n## Memory 2\n- Another fact';
        const result = migrateMemoriesIfNeeded(content);
        expect(result).toContain('<memory');
        expect(result).toContain('</memory>');
        const parsed = parseMemories(result);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].bullets).toEqual(['Old fact']);
        expect(parsed[1].bullets).toEqual(['Another fact']);
    });

    it('extracts _Extracted: ..._ timestamps from old format', () => {
        const content = '## Memory 1\n_Extracted: 2023-06-15 10:00_\n- Fact with date';
        const result = migrateMemoriesIfNeeded(content);
        const parsed = parseMemories(result);
        expect(parsed[0].date).toBe('2023-06-15 10:00');
    });

    it('wraps flat text as a single memory block', () => {
        const content = 'Just some plain text without any formatting.';
        const result = migrateMemoriesIfNeeded(content);
        expect(result).toContain('<memory');
        const parsed = parseMemories(result);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].bullets).toEqual(['Just some plain text without any formatting.']);
    });

    it('wraps flat bullet list as a single block', () => {
        const content = '- Fact one\n- Fact two\n- Fact three';
        const result = migrateMemoriesIfNeeded(content);
        const parsed = parseMemories(result);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].bullets).toEqual(['Fact one', 'Fact two', 'Fact three']);
    });
});
