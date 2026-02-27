import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    formatChatMessages,
    substitutePromptTemplate,
    parseMemories,
    countMemories,
} from '../../lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

const LLM_URL = process.env.TEST_LLM_URL || 'http://127.0.0.1:1234/v1';
const LLM_MODEL = process.env.TEST_LLM_MODEL || '';

function loadChat() {
    const raw = readFileSync(join(fixturesDir, 'flux-chat.jsonl'), 'utf-8');
    return raw.trim().split('\n').slice(1).map(line => JSON.parse(line));
}

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Read the recent chat messages and identify the most significant facts, events, and developments worth remembering long-term.

Character name: {{charName}}

===== CHARACTER CARD (baseline knowledge — do NOT extract anything already described here) =====
{{charCard}}
===== END CHARACTER CARD =====

===== EXISTING MEMORIES (reference only — do NOT repeat these) =====
{{existingMemories}}
===== END EXISTING MEMORIES =====

===== RECENT CHAT MESSAGES (extract ONLY from this section) =====
{{recentMessages}}
===== END RECENT CHAT MESSAGES =====

Extract only NEW facts, events, relationships, or character developments.
Write in past tense, third person. No more than 8 bullet points.
Wrap output in <memory></memory> tags with bullets starting with "- ".
If nothing new, respond with: NO_NEW_MEMORIES`;

const CHARACTER_CARD = `Flux the Cat is a clever, sassy black-and-white cat. He rides a custom Gundam-styled Roomba as his personal transport. He's food-motivated, loves watching birds from the window, and has a dramatic personality.`;

async function callTestLLM(prompt) {
    let model = LLM_MODEL;
    if (!model) {
        const modelsRes = await fetch(`${LLM_URL}/models`);
        const modelsData = await modelsRes.json();
        model = modelsData.data?.[0]?.id;
        if (!model) throw new Error('No models available at ' + LLM_URL);
    }

    const response = await fetch(`${LLM_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are a memory extraction assistant.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 1000,
            temperature: 0.3,
        }),
    });

    if (!response.ok) {
        throw new Error(`LLM error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

describe('Live LLM: extraction from test chat', () => {
    it('extracts memories from the first 20 messages', async () => {
        const chat = loadChat();
        const formatted = formatChatMessages(chat, 0, 20);

        const prompt = substitutePromptTemplate(EXTRACTION_PROMPT, {
            charName: 'Flux the Cat',
            charCard: CHARACTER_CARD,
            existingMemories: '',
            recentMessages: formatted.text,
        });

        const response = await callTestLLM(prompt);
        const blocks = parseMemories(response);

        // Structural assertions
        expect(blocks.length).toBeGreaterThanOrEqual(1);
        const totalBullets = countMemories(blocks);
        expect(totalBullets).toBeGreaterThanOrEqual(1);
        expect(totalBullets).toBeLessThanOrEqual(10);

        // Each block has required attributes
        for (const block of blocks) {
            expect(block.bullets.length).toBeGreaterThan(0);
            for (const bullet of block.bullets) {
                expect(bullet.length).toBeGreaterThan(5);
            }
        }
    }, 60000);

    it('does not parrot character card traits', async () => {
        const chat = loadChat();
        const formatted = formatChatMessages(chat, 0, 20);

        const prompt = substitutePromptTemplate(EXTRACTION_PROMPT, {
            charName: 'Flux the Cat',
            charCard: CHARACTER_CARD,
            existingMemories: '',
            recentMessages: formatted.text,
        });

        const response = await callTestLLM(prompt);
        const blocks = parseMemories(response);
        const allBullets = blocks.flatMap(b => b.bullets).join('\n').toLowerCase();

        // These are card traits that should NOT appear as extracted memories
        const cardTraits = [
            'food-motivated',
            'loves watching birds',
            'dramatic personality',
        ];

        for (const trait of cardTraits) {
            expect(allBullets).not.toContain(trait);
        }
    }, 60000);

    it('handles a larger chunk (messages 0-50)', async () => {
        const chat = loadChat();
        const formatted = formatChatMessages(chat, 0, 50);

        const prompt = substitutePromptTemplate(EXTRACTION_PROMPT, {
            charName: 'Flux the Cat',
            charCard: CHARACTER_CARD,
            existingMemories: '',
            recentMessages: formatted.text,
        });

        const response = await callTestLLM(prompt);

        // Should produce valid output or NO_NEW_MEMORIES
        if (response.trim() === 'NO_NEW_MEMORIES') return;

        const blocks = parseMemories(response);
        expect(blocks.length).toBeGreaterThanOrEqual(1);
    }, 120000);
});
