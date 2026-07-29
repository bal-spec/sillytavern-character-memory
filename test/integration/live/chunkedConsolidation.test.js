import { describe, it, expect } from 'vitest';
import { runChunkedConsolidation } from '../../../consolidation.js';
import { parseMemories, packBlocksIntoChunks } from '../../../lib.js';
import { callTestLLM, TIMEOUT_MS } from '../llm-client.js';

const SYSTEM = 'You are a memory consolidation assistant.';

function buildPrompt(blocks) {
    const memoriesText = blocks.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(x => `- ${x}`).join('\n')}`).join('\n\n');
    // "bulleted contents" alone is under-specified: parseMemories only recognises lines
    // starting with "- ", so a model that reaches for "*" or numbered items produces
    // well-formed <memory> tags wrapping zero usable bullets, and every chunk gets
    // dropped as "no parseable blocks". The real consolidation prompts in index.js spell
    // the format out; mirror that here so this test measures the orchestrator rather than
    // the model's choice of bullet character.
    return `Consolidate these memories into themed groups.

Output ONLY <memory chat="Theme"></memory> blocks. Inside each block, use a markdown bulleted list with lines starting with "- ". No headers, no commentary, no extra text.

${memoriesText}`;
}

describe('runChunkedConsolidation (live LLM)', () => {
    it('produces parseable non-truncated output on a ~90-block synthetic set', async () => {
        // Synthesize ~90 memory blocks with varied content, then pack them against a
        // budget small enough to actually split them.
        //
        // This previously packed against 24000 chars in the belief that ~90 blocks
        // "comfortably exceeds" it. They don't: the set is ~6.7k chars, so it packed
        // into a single chunk and the map-reduce fan-out this test exists to cover
        // never ran. CHUNK_BUDGET is sized off the real total so it stays split even
        // if the fixture is edited later.
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

        const totalChars = blocks.reduce((n, b) => n + b.bullets.join('').length, 0);
        const CHUNK_BUDGET = Math.floor(totalChars / 3);

        const logs = [];
        const result = await runChunkedConsolidation(blocks, {
            runLLM: async (chunk) => callTestLLM(buildPrompt(chunk), { system: SYSTEM }),
            logProgress: (msg) => logs.push(msg),
            isCancelled: () => false,
            packChunks: (mems) => packBlocksIntoChunks(mems, CHUNK_BUDGET),
            parseOutput: (text) => parseMemories(text),
            // Above the default 1. Now that this genuinely splits into several chunks it
            // makes 6+ sequential calls to a network provider, and any single transient
            // failure (a 503, a slow reduce) aborts the whole run. Retrying is the
            // orchestrator's own documented behaviour, so leaning on it here exercises
            // that path rather than papering over anything.
            maxRetries: 3,
        });

        // Guard the premise: if this ever collapses to one chunk again, the map-reduce
        // path silently stops being covered and every assertion below still passes.
        const chunkCount = Number(logs[0]?.match(/\((\d+) chunks\)/)?.[1] ?? 0);
        expect(chunkCount).toBeGreaterThan(1);

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
        if (parsed.length === 0) {
            // Tags present but nothing parsed — almost always bullet style. parseMemories
            // only recognises "- " lines, so a model that answers with "* " or numbered
            // items yields well-formed tags wrapping zero usable bullets.
            console.log('[live test debug] result parsed to 0 blocks; first 600 chars:\n' + result.slice(0, 600));
        }
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.length).toBeLessThan(blocks.length);        // actual consolidation
        expect(logs.some(l => /chunked mode/.test(l))).toBe(true);
        expect(logs.some(l => /reduce/.test(l))).toBe(true);
        // Map-reduce over ~90 blocks issues several sequential calls, so the suite
        // budget is a multiple of the per-request one rather than equal to it.
    }, TIMEOUT_MS * 4);
});
