import { describe, it, expect } from 'vitest';
import { createMemoryEditor } from '../../editor.js';

describe('createMemoryEditor', () => {
    const sampleBlocks = [
        { chat: 'Test', date: '2026-01-01 14:00', bullets: ['- [A, B — test]', '- Fact one', '- Fact two'] },
        { chat: 'Other', date: '2026-01-02 10:00', bullets: ['- [C — other]', '- Something'] },
    ];

    it('initializes with provided blocks', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        expect(editor.getBlocks()).toHaveLength(2);
        expect(editor.getBlocks()[0].chat).toBe('Test');
    });

    it('getBlocks returns a deep clone, not a reference', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        const blocks = editor.getBlocks();
        blocks[0].bullets.push('- New');
        expect(editor.getBlocks()[0].bullets).toHaveLength(3);
    });

    it('deleteBullet removes the specified bullet', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.deleteBullet(0, 1);
        expect(editor.getBlocks()[0].bullets).toEqual(['- [A, B — test]', '- Fact two']);
    });

    it('deleteBlock removes the specified block', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.deleteBlock(0);
        expect(editor.getBlocks()).toHaveLength(1);
        expect(editor.getBlocks()[0].chat).toBe('Other');
    });

    it('addBullet appends to the specified block', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.addBullet(0);
        const bullets = editor.getBlocks()[0].bullets;
        expect(bullets[bullets.length - 1]).toBe('');
    });

    it('addBlock appends a new empty block', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.addBlock();
        const blocks = editor.getBlocks();
        expect(blocks).toHaveLength(3);
        expect(blocks[2].bullets).toEqual(['']);
    });

    it('addBlock uses provided timestamp', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.addBlock('2026-03-01 12:00');
        expect(editor.getBlocks()[2].date).toBe('2026-03-01 12:00');
    });

    it('updateBullet changes the text', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.updateBullet(0, 1, '- Updated fact');
        expect(editor.getBlocks()[0].bullets[1]).toBe('- Updated fact');
    });

    it('updateTheme changes the chat label', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.updateTheme(0, 'New Label');
        expect(editor.getBlocks()[0].chat).toBe('New Label');
    });

    it('undo restores previous state', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.deleteBlock(0);
        expect(editor.getBlocks()).toHaveLength(1);
        editor.undo();
        expect(editor.getBlocks()).toHaveLength(2);
    });

    it('undo returns false when no history', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        expect(editor.undo()).toBe(false);
    });

    it('canUndo reflects version stack state', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        expect(editor.canUndo()).toBe(false);
        editor.deleteBlock(0);
        expect(editor.canUndo()).toBe(true);
    });

    it('replaceAll swaps all blocks and clears undo history', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.deleteBlock(0);
        const newBlocks = [{ chat: 'Fresh', date: '2026-06-01 08:00', bullets: ['- New'] }];
        editor.replaceAll(newBlocks);
        expect(editor.getBlocks()).toHaveLength(1);
        expect(editor.getBlocks()[0].chat).toBe('Fresh');
        expect(editor.canUndo()).toBe(false);
    });

    it('deleteBullet auto-removes block when last bullet deleted', () => {
        const editor = createMemoryEditor({ blocks: [
            { chat: 'Solo', date: '2026-01-01 10:00', bullets: ['- Only one'] },
            { chat: 'Other', date: '2026-01-02 10:00', bullets: ['- Keep'] },
        ] });
        editor.deleteBullet(0, 0);
        expect(editor.getBlocks()).toHaveLength(1);
        expect(editor.getBlocks()[0].chat).toBe('Other');
    });

    it('getEditingSet returns a copy, not a reference', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        editor.toggleEdit(0);
        const set = editor.getEditingSet();
        set.delete(0);
        expect(editor.isEditing(0)).toBe(true);
    });

    it('toggleEdit tracks which blocks are in edit mode', () => {
        const editor = createMemoryEditor({ blocks: sampleBlocks });
        expect(editor.isEditing(0)).toBe(false);
        editor.toggleEdit(0);
        expect(editor.isEditing(0)).toBe(true);
        editor.toggleEdit(0);
        expect(editor.isEditing(0)).toBe(false);
    });
});
