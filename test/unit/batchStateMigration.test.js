import { describe, it, expect } from 'vitest';
import { remapBatchStateKeys } from '../../lib.js';

const CHARS = [
    { name: 'Seraphina', avatar: 'Seraphina.png' },
    { name: 'Flux', avatar: 'Flux.png' },
];

describe('remapBatchStateKeys', () => {
    it('re-keys a name-keyed record to the matching avatar', () => {
        const { batchState, moved } = remapBatchStateKeys(
            { 'Seraphina:chat-1': { lastExtractedIndex: 42 } }, CHARS);
        expect(batchState).toEqual({ 'Seraphina.png:chat-1': { lastExtractedIndex: 42 } });
        expect(moved).toBe(1);
    });

    it('preserves the record value verbatim', () => {
        const value = { lastExtractedIndex: 7, totalMemories: 3 };
        const { batchState } = remapBatchStateKeys({ 'Flux:my chat': value }, CHARS);
        expect(batchState['Flux.png:my chat']).toEqual(value);
    });

    it('is idempotent — a second pass leaves avatar-keyed records untouched', () => {
        const once = remapBatchStateKeys({ 'Seraphina:chat-1': { lastExtractedIndex: 42 } }, CHARS);
        const twice = remapBatchStateKeys(once.batchState, CHARS);
        expect(twice.batchState).toEqual(once.batchState);
        expect(twice.moved).toBe(0);
    });

    it('leaves ambiguous records untouched when two cards share a display name', () => {
        const dupes = [
            { name: 'Alice', avatar: 'alice-v1.png' },
            { name: 'Alice', avatar: 'alice-v2.png' },
        ];
        const { batchState, moved, ambiguous, ambiguousKeys } = remapBatchStateKeys(
            { 'Alice:chat-1': { lastExtractedIndex: 5 } }, dupes);
        // Assigning this to either card is exactly the corruption the re-key prevents.
        expect(batchState).toEqual({ 'Alice:chat-1': { lastExtractedIndex: 5 } });
        expect(moved).toBe(0);
        expect(ambiguous).toBe(1);
        expect(ambiguousKeys).toEqual(['Alice:chat-1']);
    });
});

describe('remapBatchStateKeys — disambiguation by chat ownership', () => {
    const DUPES = [
        { name: 'Alice', avatar: 'alice-v1.png' },
        { name: 'Alice', avatar: 'alice-v2.png' },
    ];

    it('resolves an ambiguous record to the card that actually owns the chat', () => {
        const { batchState, moved, ambiguous, disambiguated } = remapBatchStateKeys(
            { 'Alice:chat-1': { lastExtractedIndex: 5 } }, DUPES,
            { 'alice-v1.png': ['chat-1'], 'alice-v2.png': ['chat-9'] });
        expect(batchState).toEqual({ 'alice-v1.png:chat-1': { lastExtractedIndex: 5 } });
        expect(moved).toBe(1);
        expect(disambiguated).toBe(1);
        expect(ambiguous).toBe(0);
    });

    it('stays ambiguous when both candidates own a chat by that name', () => {
        const { batchState, ambiguous, disambiguated } = remapBatchStateKeys(
            { 'Alice:chat-1': { lastExtractedIndex: 5 } }, DUPES,
            { 'alice-v1.png': ['chat-1'], 'alice-v2.png': ['chat-1'] });
        expect(batchState).toEqual({ 'Alice:chat-1': { lastExtractedIndex: 5 } });
        expect(ambiguous).toBe(1);
        expect(disambiguated).toBe(0);
    });

    it('stays ambiguous when neither candidate claims the chat', () => {
        const { batchState, ambiguous } = remapBatchStateKeys(
            { 'Alice:chat-1': { lastExtractedIndex: 5 } }, DUPES,
            { 'alice-v1.png': ['other'], 'alice-v2.png': ['another'] });
        expect(batchState).toEqual({ 'Alice:chat-1': { lastExtractedIndex: 5 } });
        expect(ambiguous).toBe(1);
    });

    it('ignores a claim from a card that does not share the contested name', () => {
        const roster = [...DUPES, { name: 'Bob', avatar: 'bob.png' }];
        const { batchState, ambiguous } = remapBatchStateKeys(
            { 'Alice:chat-1': { lastExtractedIndex: 5 } }, roster,
            { 'bob.png': ['chat-1'] });
        expect(batchState).toEqual({ 'Alice:chat-1': { lastExtractedIndex: 5 } });
        expect(ambiguous).toBe(1);
    });

    it('handles a real-world roster: two Susans, plus already-avatar-keyed records', () => {
        // Reduced from an actual user profile that hit this. Two cards named "Susan",
        // Laura's records already avatar-keyed, and chat names containing " - " and "@".
        const roster = [
            { name: 'Laura', avatar: 'Laura.png' },
            { name: 'Susan', avatar: 'Susan.png' },
            { name: 'Susan', avatar: 'Susan1.png' },
        ];
        const state = {
            'Susan:Susan - 2026-01-03@10h30m04s': { lastExtractedIndex: 10 },
            'Susan:Susan - 2026-02-04@08h11m44s715ms': { lastExtractedIndex: 20 },
            'Laura.png:Laura - 2025-11-27@22h40m24s': { lastExtractedIndex: 30 },
        };
        const chatOwners = {
            'Susan.png': ['Susan - 2026-01-03@10h30m04s'],
            'Susan1.png': ['Susan - 2026-02-04@08h11m44s715ms'],
            'Laura.png': ['Laura - 2025-11-27@22h40m24s'],
        };
        const { batchState, moved, ambiguous, disambiguated } = remapBatchStateKeys(state, roster, chatOwners);
        expect(batchState).toEqual({
            'Susan.png:Susan - 2026-01-03@10h30m04s': { lastExtractedIndex: 10 },
            'Susan1.png:Susan - 2026-02-04@08h11m44s715ms': { lastExtractedIndex: 20 },
            'Laura.png:Laura - 2025-11-27@22h40m24s': { lastExtractedIndex: 30 },
        });
        expect(moved).toBe(2);
        expect(disambiguated).toBe(2);
        expect(ambiguous).toBe(0);
    });

    it('is backward compatible — omitting chatOwners behaves as before', () => {
        const { ambiguous, disambiguated } = remapBatchStateKeys(
            { 'Alice:chat-1': { lastExtractedIndex: 5 } }, DUPES);
        expect(ambiguous).toBe(1);
        expect(disambiguated).toBe(0);
    });

    it('leaves records for characters that are no longer present untouched', () => {
        const { batchState, moved, unmatched } = remapBatchStateKeys(
            { 'DeletedChar:chat-1': { lastExtractedIndex: 5 } }, CHARS);
        expect(batchState).toEqual({ 'DeletedChar:chat-1': { lastExtractedIndex: 5 } });
        expect(moved).toBe(0);
        expect(unmatched).toBe(1);
    });

    it('handles a character name containing a colon via longest-match', () => {
        const chars = [
            { name: 'Doc', avatar: 'doc.png' },
            { name: 'Doc: The Sequel', avatar: 'doc-sequel.png' },
        ];
        const { batchState } = remapBatchStateKeys(
            { 'Doc: The Sequel:chat-9': { lastExtractedIndex: 1 } }, chars);
        // Shortest match would have produced 'doc.png: The Sequel:chat-9'.
        expect(batchState).toEqual({ 'doc-sequel.png:chat-9': { lastExtractedIndex: 1 } });
    });

    it('preserves a chat name containing a colon', () => {
        const { batchState } = remapBatchStateKeys(
            { 'Flux:2024-01-01 12:30:00': { lastExtractedIndex: 2 } }, CHARS);
        expect(batchState).toEqual({ 'Flux.png:2024-01-01 12:30:00': { lastExtractedIndex: 2 } });
    });

    it('migrates a mixed set and reports each category', () => {
        const { batchState, moved, ambiguous, unmatched } = remapBatchStateKeys({
            'Seraphina:a': { lastExtractedIndex: 1 },
            'Flux.png:b': { lastExtractedIndex: 2 },
            'Ghost:c': { lastExtractedIndex: 3 },
        }, CHARS);
        expect(batchState).toEqual({
            'Seraphina.png:a': { lastExtractedIndex: 1 },
            'Flux.png:b': { lastExtractedIndex: 2 },
            'Ghost:c': { lastExtractedIndex: 3 },
        });
        expect(moved).toBe(1);
        expect(ambiguous).toBe(0);
        expect(unmatched).toBe(1);
    });

    it('never drops a record', () => {
        const input = {
            'Seraphina:a': 1, 'Ghost:b': 2, 'Flux.png:c': 3,
        };
        const { batchState } = remapBatchStateKeys(input, CHARS);
        expect(Object.keys(batchState)).toHaveLength(Object.keys(input).length);
    });

    it('tolerates empty and malformed input', () => {
        expect(remapBatchStateKeys({}, CHARS).batchState).toEqual({});
        expect(remapBatchStateKeys(null, CHARS).batchState).toEqual({});
        expect(remapBatchStateKeys(undefined, undefined).batchState).toEqual({});
        expect(remapBatchStateKeys({ 'X:y': 1 }, []).batchState).toEqual({ 'X:y': 1 });
    });

    it('ignores roster entries missing a name or avatar', () => {
        const messy = [{ avatar: 'no-name.png' }, { name: 'NoAvatar' }, ...CHARS];
        const { batchState, moved } = remapBatchStateKeys({ 'Seraphina:a': 1 }, messy);
        expect(batchState).toEqual({ 'Seraphina.png:a': 1 });
        expect(moved).toBe(1);
    });
});
