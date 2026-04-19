import { describe, expect, it } from 'vitest';
import { shouldExtractNow } from '../../lib.js';

describe('shouldExtractNow', () => {
    const base = {
        messagesSinceExtraction: 20,
        interval: 20,
        extractionLag: 0,
        isGenerating: false,
        now: 1_000_000,
        lastExtractionTime: 0,
        cooldownMs: 0,
    };

    it('fires when count >= interval with no lag, no cooldown, not generating', () => {
        expect(shouldExtractNow(base)).toEqual({ fire: true });
    });

    it('waits when count < interval', () => {
        expect(shouldExtractNow({ ...base, messagesSinceExtraction: 10 })).toEqual({
            fire: false,
            reason: 'below-interval',
        });
    });

    it('waits when count < interval + lag', () => {
        expect(shouldExtractNow({ ...base, messagesSinceExtraction: 20, extractionLag: 2 })).toEqual({
            fire: false,
            reason: 'below-interval',
        });
    });

    it('fires when count >= interval + lag', () => {
        expect(shouldExtractNow({ ...base, messagesSinceExtraction: 22, extractionLag: 2 })).toEqual({
            fire: true,
        });
    });

    it('defers when a generation is active, even if threshold met', () => {
        expect(shouldExtractNow({ ...base, isGenerating: true })).toEqual({
            fire: false,
            reason: 'generation-active',
        });
    });

    it('skips when cooldown not elapsed', () => {
        expect(
            shouldExtractNow({ ...base, now: 1_000_000, lastExtractionTime: 999_000, cooldownMs: 60_000 }),
        ).toEqual({ fire: false, reason: 'cooldown', remainingMs: 59_000 });
    });

    it('fires when cooldown elapsed', () => {
        expect(
            shouldExtractNow({ ...base, now: 1_000_000, lastExtractionTime: 900_000, cooldownMs: 60_000 }),
        ).toEqual({ fire: true });
    });

    it('defers over cooldown when both apply (generation-active wins)', () => {
        expect(
            shouldExtractNow({
                ...base,
                isGenerating: true,
                now: 1_000_000,
                lastExtractionTime: 999_000,
                cooldownMs: 60_000,
            }),
        ).toEqual({ fire: false, reason: 'generation-active' });
    });

    it('treats missing extractionLag as 0', () => {
        const { extractionLag, ...rest } = base;
        expect(shouldExtractNow(rest)).toEqual({ fire: true });
    });
});
