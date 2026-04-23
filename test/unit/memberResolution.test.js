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
});
