import { describe, it, expect } from 'vitest';
import { classifyBlocksForConsolidation } from '../../lib.js';

const block = (chat, bullets = ['a']) => ({ chat, date: '2024-01-01', bullets });

describe('classifyBlocksForConsolidation', () => {
    it('returns empty buckets for empty input', () => {
        expect(classifyBlocksForConsolidation([])).toEqual({ eligible: [], protected: [] });
    });

    it('classifies chat-ID-style labels as eligible', () => {
        const b1 = block('main_chat_abc123');
        const b2 = block('SomeChar-2024-01-15');
        const b3 = block('alphanum_only');
        const { eligible, protected: prot } = classifyBlocksForConsolidation([b1, b2, b3]);
        expect(eligible).toEqual([b1, b2, b3]);
        expect(prot).toEqual([]);
    });

    it('classifies themed labels (with spaces) as protected', () => {
        const b1 = block('First vet visit');
        const b2 = block('Adoption day at the apartment');
        const { eligible, protected: prot } = classifyBlocksForConsolidation([b1, b2]);
        expect(eligible).toEqual([]);
        expect(prot).toEqual([b1, b2]);
    });

    it('classifies labels with punctuation (em dash, apostrophe, period) as protected', () => {
        const b1 = block('Flux—playful');
        const b2 = block("Alex's adventure");
        const b3 = block('Version 1.0 release');
        const { protected: prot } = classifyBlocksForConsolidation([b1, b2, b3]);
        expect(prot).toEqual([b1, b2, b3]);
    });

    it('treats the literal "unknown" placeholder as protected (defensive)', () => {
        const { eligible, protected: prot } = classifyBlocksForConsolidation([block('unknown')]);
        expect(eligible).toEqual([]);
        expect(prot).toEqual([block('unknown')]);
    });

    it('treats empty chat label as protected (defensive)', () => {
        const { protected: prot } = classifyBlocksForConsolidation([block('')]);
        expect(prot.length).toBe(1);
    });

    it('treats block with missing bullets as protected (defensive)', () => {
        const malformed = { chat: 'looks_eligible', date: '2024-01-01' };
        const { protected: prot } = classifyBlocksForConsolidation([malformed]);
        expect(prot).toEqual([malformed]);
    });

    it('splits a mixed set correctly and preserves order within each bucket', () => {
        const e1 = block('chat_a');
        const p1 = block('Theme One');
        const e2 = block('chat_b');
        const p2 = block('Theme Two');
        const e3 = block('chat_c');
        const { eligible, protected: prot } = classifyBlocksForConsolidation([e1, p1, e2, p2, e3]);
        expect(eligible).toEqual([e1, e2, e3]);
        expect(prot).toEqual([p1, p2]);
    });
});
