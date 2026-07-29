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
import { callTestLLM, TIMEOUT_MS } from './llm-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

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

/** Build the extraction prompt for a slice of the fixture chat. */
function buildExtractionPrompt(from, to) {
    const formatted = formatChatMessages(loadChat(), from, to);
    return substitutePromptTemplate(EXTRACTION_PROMPT, {
        charName: 'Flux the Cat',
        charCard: CHARACTER_CARD,
        existingMemories: '',
        recentMessages: formatted.text,
    });
}

describe('Live LLM: extraction from test chat', () => {
    it('extracts memories from the first 20 messages', async () => {
        const response = await callTestLLM(buildExtractionPrompt(0, 20));
        const blocks = parseMemories(response);

        // Log raw response when parsing fails for debugging
        if (blocks.length === 0) {
            console.log('[live test debug] Raw LLM response (first 500 chars):', response.slice(0, 500));
        }

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
    }, TIMEOUT_MS);

    it('does not parrot character card traits', async () => {
        const response = await callTestLLM(buildExtractionPrompt(0, 20));
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
    }, TIMEOUT_MS);

    it('handles a larger chunk (messages 0-50)', async (ctx) => {
        let response;
        try {
            response = await callTestLLM(buildExtractionPrompt(0, 50));
        } catch (e) {
            // Skip if the model's context window is too small for 50 messages
            if (e.message.includes('context') || e.message.includes('truncate')) {
                ctx.skip();
                return;
            }
            throw e;
        }

        // Should produce valid output or NO_NEW_MEMORIES
        if (response.trim() === 'NO_NEW_MEMORIES') return;

        const blocks = parseMemories(response);
        if (blocks.length === 0) {
            console.log('[live test debug] Raw LLM response (first 500 chars):', response.slice(0, 500));
        }
        expect(blocks.length).toBeGreaterThanOrEqual(1);
    }, TIMEOUT_MS);
});
