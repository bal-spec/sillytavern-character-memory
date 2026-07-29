import { describe, it, expect } from 'vitest';
import { runChunkedConsolidation } from '../../../consolidation.js';
import { parseMemories, packBlocksIntoChunks } from '../../../lib.js';
import { callTestLLM, TIMEOUT_MS } from '../llm-client.js';

const SYSTEM = 'You are a memory consolidation assistant.';

function buildPrompt(blocks) {
    const memoriesText = blocks.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(x => `- ${x}`).join('\n')}`).join('\n\n');
    return `Consolidate these memories. Output ONLY <memory chat="Theme"></memory> blocks with bulleted contents. No commentary.

${memoriesText}`;
}

describe('runChunkedConsolidation (live LLM)', () => {
    it('produces parseable non-truncated output on a ~90-block synthetic set', async () => {
        // Synthesize ~90 memory blocks with varied content. Each block has a few
        // short bullets so the full set comfortably exceeds the 24000-char chunk
        // budget, forcing the orchestrator to run multi-chunk map-reduce.
        const moods = ['curious', 'playful', 'sleepy', 'hungry'];
        const places = ['the cafe', 'the park', 'the apartment', 'the vet'];
        const blocks = Array.from({ length: 90 }, (_, i) => ({
            chat: `chat_${i}`,
            date: '2024-01-01',
            bullets: [
                `Alex and Flux discuss topic ${i}.`,
                `Flux's mood is ${moods[i % moods.length]}.`,
                `They go to ${places[i % places.length]}.`,
            ],
        }));

        const logs = [];
        const result = await runChunkedConsolidation(blocks, {
            runLLM: async (chunk) => callTestLLM(buildPrompt(chunk), { system: SYSTEM }),
            logProgress: (msg) => logs.push(msg),
            isCancelled: () => false,
            packChunks: (mems) => packBlocksIntoChunks(mems, 24000),
            parseOutput: (text) => parseMemories(text),
        });

        // runChunkedConsolidation has several distinct null paths (chunk failed after
        // retries, all chunks empty, no parseable blocks, reduce failed/empty). Its
        // progress log is the only thing that distinguishes them, so surface it rather
        // than leaving a bare "expected null not to be null".
        if (result === null) {
            console.log('[live test debug] orchestrator log:\n  ' + logs.join('\n  '));
        }

        expect(result).not.toBeNull();
        expect(result).toContain('<memory');

        // Truncation check: every opening tag has a matching close, and the text does
        // not end mid-tag. Deliberately NOT `/<\/memory>\s*$/` — that also fails when a
        // model appends chatter after the last block ("Wait, I should check whether...",
        // which reasoning models leak into content routinely). Trailing prose is not
        // truncation, and parseMemories ignores anything outside the tags anyway, so
        // asserting on it makes the test fail on benign verbosity rather than the
        // budget-exhaustion cut-off it exists to catch.
        const opens = (result.match(/<memory\b/gi) || []).length;
        const closes = (result.match(/<\/memory>/gi) || []).length;
        expect(closes).toBe(opens);
        expect(result).not.toMatch(/<memory\b[^>]*$/i);

        const parsed = parseMemories(result);
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.length).toBeLessThan(blocks.length);        // actual consolidation
        expect(logs.some(l => /chunked mode/.test(l))).toBe(true);
        expect(logs.some(l => /reduce/.test(l))).toBe(true);
        // Map-reduce over ~90 blocks issues several sequential calls, so the suite
        // budget is a multiple of the per-request one rather than equal to it.
    }, TIMEOUT_MS * 4);
});
