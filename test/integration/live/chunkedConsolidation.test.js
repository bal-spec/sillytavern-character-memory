import { describe, it, expect } from 'vitest';
import { runChunkedConsolidation } from '../../../consolidation.js';
import { parseMemories, packBlocksIntoChunks } from '../../../lib.js';

const LLM_URL   = process.env.TEST_LLM_URL   || 'http://127.0.0.1:1234/v1';
const LLM_MODEL = process.env.TEST_LLM_MODEL || '';
const LLM_KEY   = process.env.TEST_LLM_KEY   || '';

async function callLocalLLM(prompt, maxTokens = 4000) {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}),
        },
        body: JSON.stringify({
            model: LLM_MODEL || undefined,
            messages: [
                { role: 'system', content: 'You are a memory consolidation assistant.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: maxTokens,
            temperature: 0.3,
        }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
}

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
            runLLM: async (chunk) => {
                const prompt = buildPrompt(chunk);
                return callLocalLLM(prompt, 4000);
            },
            logProgress: (msg) => logs.push(msg),
            isCancelled: () => false,
            packChunks: (mems) => packBlocksIntoChunks(mems, 24000),
            parseOutput: (text) => parseMemories(text),
        });

        expect(result).not.toBeNull();
        expect(result).toContain('<memory');
        expect(result).toMatch(/<\/memory>\s*$/);                // no truncation
        const parsed = parseMemories(result);
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.length).toBeLessThan(blocks.length);        // actual consolidation
        expect(logs.some(l => /chunked mode/.test(l))).toBe(true);
        expect(logs.some(l => /reduce/.test(l))).toBe(true);
    }, 180_000); // 3 min — multi-call flow on slow providers
});
