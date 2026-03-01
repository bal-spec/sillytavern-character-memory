import { cloneMemoryBlocks, getTimestamp, reindexEditingSet } from './lib.js';

/**
 * Create a memory block editor with state management and undo.
 * Pure state logic — no DOM. Callers handle rendering and event binding.
 *
 * @param {object} options
 * @param {Array<{chat: string, date: string, bullets: string[]}>} options.blocks - Initial blocks
 * @returns {object} Editor API
 */
export function createMemoryEditor({ blocks }) {
    let editorBlocks = cloneMemoryBlocks(blocks);
    const versionStack = [];
    const editingSet = new Set();

    function saveVersion() {
        versionStack.push(cloneMemoryBlocks(editorBlocks));
    }

    return {
        getBlocks() {
            return cloneMemoryBlocks(editorBlocks);
        },

        deleteBullet(blockIndex, bulletIndex) {
            if (!editorBlocks[blockIndex]) return;
            saveVersion();
            editorBlocks[blockIndex].bullets.splice(bulletIndex, 1);
            if (editorBlocks[blockIndex].bullets.length === 0) {
                editorBlocks.splice(blockIndex, 1);
                reindexEditingSet(editingSet, blockIndex);
            }
        },

        deleteBlock(blockIndex) {
            if (!editorBlocks[blockIndex]) return;
            saveVersion();
            editorBlocks.splice(blockIndex, 1);
            reindexEditingSet(editingSet, blockIndex);
        },

        addBullet(blockIndex) {
            if (!editorBlocks[blockIndex]) return;
            saveVersion();
            editorBlocks[blockIndex].bullets.push('');
            editingSet.add(blockIndex);
        },

        addBlock(timestamp) {
            saveVersion();
            editorBlocks.push({
                chat: 'New Group',
                date: timestamp || getTimestamp(),
                bullets: [''],
            });
            editingSet.add(editorBlocks.length - 1);
        },

        updateBullet(blockIndex, bulletIndex, text) {
            if (!editorBlocks[blockIndex]) return;
            editorBlocks[blockIndex].bullets[bulletIndex] = text;
        },

        updateTheme(blockIndex, label) {
            if (!editorBlocks[blockIndex]) return;
            editorBlocks[blockIndex].chat = label;
        },

        undo() {
            if (versionStack.length === 0) return false;
            editorBlocks = versionStack.pop();
            return true;
        },

        canUndo() {
            return versionStack.length > 0;
        },

        replaceAll(newBlocks) {
            editorBlocks = cloneMemoryBlocks(newBlocks);
            versionStack.length = 0;
            editingSet.clear();
        },

        toggleEdit(blockIndex) {
            if (editingSet.has(blockIndex)) {
                editingSet.delete(blockIndex);
            } else {
                editingSet.add(blockIndex);
            }
        },

        isEditing(blockIndex) {
            return editingSet.has(blockIndex);
        },

        getEditingSet() {
            return new Set(editingSet);
        },
    };
}
