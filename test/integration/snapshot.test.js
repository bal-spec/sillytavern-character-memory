import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    stripNonDiegetic,
    formatChatMessages,
    substitutePromptTemplate,
    parseMemories,
    serializeMemories,
} from '../../lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

function loadChat() {
    const raw = readFileSync(join(fixturesDir, 'flux-chat.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    // First line is metadata, rest are messages
    return lines.slice(1).map(line => JSON.parse(line));
}

function loadSampleResponse() {
    return readFileSync(join(fixturesDir, 'sample-llm-response.txt'), 'utf-8');
}

describe('Snapshot: stripNonDiegetic on real messages', () => {
    it('strips non-diegetic content without destroying message text', () => {
        const chat = loadChat();
        // Process first 10 messages and snapshot
        const results = chat.slice(0, 10).map(msg => ({
            name: msg.name,
            original_length: msg.mes.length,
            stripped: stripNonDiegetic(msg.mes).trim(),
        }));
        expect(results).toMatchSnapshot();
    });
});

describe('Snapshot: formatChatMessages', () => {
    it('processes first 20 messages', () => {
        const chat = loadChat();
        const result = formatChatMessages(chat, 0, 20);
        expect(result.messageCount).toBeGreaterThan(0);
        expect(result.text).toMatchSnapshot();
    });

    it('processes messages 20-50', () => {
        const chat = loadChat();
        const result = formatChatMessages(chat, 20, 50);
        expect(result.messageCount).toBeGreaterThan(0);
        expect(result.text).toMatchSnapshot();
    });

    it('handles the full 1000-message chat without error', () => {
        const chat = loadChat();
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.messageCount).toBeGreaterThan(900); // some may be filtered
        expect(result.text.length).toBeGreaterThan(10000);
    });
});

describe('Snapshot: substitutePromptTemplate', () => {
    it('builds a complete extraction prompt', () => {
        const chat = loadChat();
        const formatted = formatChatMessages(chat, 0, 20);

        const defaultPrompt = `You are a memory extraction assistant.
Character name: {{charName}}
===== CHARACTER CARD =====
{{charCard}}
===== EXISTING MEMORIES =====
{{existingMemories}}
===== RECENT CHAT MESSAGES =====
{{recentMessages}}
===== END =====
Extract memories:`;

        const result = substitutePromptTemplate(defaultPrompt, {
            charName: 'Flux the Cat',
            charCard: 'Flux is a clever black-and-white cat who rides a Gundam Roomba.',
            existingMemories: '',
            recentMessages: formatted.text,
        });

        expect(result).toContain('Flux the Cat');
        expect(result).toContain('Gundam Roomba');
        expect(result).not.toContain('{{charName}}');
        expect(result).not.toContain('{{recentMessages}}');
        expect(result).toMatchSnapshot();
    });
});

describe('Snapshot: parseMemories round-trip', () => {
    it('parse then serialize then parse produces identical blocks', () => {
        const response = loadSampleResponse();
        const blocks = parseMemories(response);
        expect(blocks.length).toBeGreaterThan(0);

        const reserialized = serializeMemories(blocks);
        const reparsed = parseMemories(reserialized);

        expect(reparsed).toEqual(blocks);
    });
});
