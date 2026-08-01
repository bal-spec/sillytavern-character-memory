import { describe, it, expect } from 'vitest';
import { shouldSkipStaleMetadataReset } from '../../lib.js';

describe('shouldSkipStaleMetadataReset', () => {
    it('returns false for 1:1 chats (always complete)', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: false, unresolvedCount: 0, totalActive: 0 })).toBe(false);
        expect(shouldSkipStaleMetadataReset({ isGroup: false, unresolvedCount: 5, totalActive: 10 })).toBe(false);
    });

    it('returns false for group chats with no unresolved members', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 0, totalActive: 5 })).toBe(false);
    });

    it('returns true for group chats with some unresolved members', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 2, totalActive: 10 })).toBe(true);
    });

    it('returns true for group chats with all members unresolved', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 10, totalActive: 10 })).toBe(true);
    });

    it('returns true defensively for group chats with zero active members', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 0, totalActive: 0 })).toBe(true);
    });

    describe('branch/checkpoint under per-chat storage', () => {
        const base = { isGroup: false, unresolvedCount: 0, totalActive: 0 };

        it('skips the reset on a branch when per-chat storage is on', () => {
            // The branch has a new chat ID, so it never has a per-chat memory file of its
            // own — "no memories" is expected, and resetting would force a full re-extract.
            expect(shouldSkipStaleMetadataReset({ ...base, isBranch: true, perChat: true })).toBe(true);
        });

        it('still resets on a branch when per-chat storage is off', () => {
            // The shared file is found regardless of chat ID, so an empty result really
            // does mean stale metadata.
            expect(shouldSkipStaleMetadataReset({ ...base, isBranch: true, perChat: false })).toBe(false);
        });

        it('still resets in a normal chat when per-chat storage is on', () => {
            expect(shouldSkipStaleMetadataReset({ ...base, isBranch: false, perChat: true })).toBe(false);
        });

        it('skips the reset on a group branch under per-chat storage', () => {
            expect(shouldSkipStaleMetadataReset({
                isGroup: true, unresolvedCount: 0, totalActive: 5, isBranch: true, perChat: true,
            })).toBe(true);
        });

        it('defaults isBranch/perChat to false when omitted (existing callers unaffected)', () => {
            expect(shouldSkipStaleMetadataReset({ isGroup: false, unresolvedCount: 0, totalActive: 0 })).toBe(false);
            expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 1, totalActive: 3 })).toBe(true);
        });
    });
});
