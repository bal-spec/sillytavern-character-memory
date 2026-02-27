# Automated Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automated snapshot and live-LLM integration tests for CharMemory's extraction pipeline.

**Architecture:** Extract 3 pure functions from `index.js` into `lib.js` (stripNonDiegetic, formatChatMessages, substitutePromptTemplate), then build snapshot tests using a 1000-message JSONL fixture and live LLM tests against an OpenAI-compatible endpoint.

**Tech Stack:** Vitest (already installed), Node.js ESM, JSONL fixture data, OpenAI-compatible API for live tests.

---

### Task 1: Extract `stripNonDiegetic()` into `lib.js`

**Files:**
- Modify: `lib.js` (add function at end, before closing)
- Modify: `index.js:2031-2036` (replace inline regexes with function call)
- Test: `test/unit/utils.test.js` (add tests)

**Step 1: Write the failing test**

Add to `test/unit/utils.test.js`:

```js
import { stripNonDiegetic } from '../../lib.js';

describe('stripNonDiegetic', () => {
    it('removes markdown code blocks', () => {
        const input = 'Before ```const x = 1;\nconsole.log(x);``` After';
        expect(stripNonDiegetic(input)).toBe('Before  After');
    });

    it('removes <details> sections', () => {
        const input = 'Before <details><summary>Hidden</summary>Secret content</details> After';
        expect(stripNonDiegetic(input)).toBe('Before  After');
    });

    it('removes markdown tables', () => {
        const input = 'Before\n| Col1 | Col2 |\n| --- | --- |\n| A | B |\nAfter';
        expect(stripNonDiegetic(input)).toBe('Before\n\nAfter');
    });

    it('removes HTML tags', () => {
        const input = 'Hello <b>world</b> and <img src="x" /> done';
        expect(stripNonDiegetic(input)).toBe('Hello world and  done');
    });

    it('collapses 3+ newlines to 2', () => {
        const input = 'Line 1\n\n\n\nLine 2';
        expect(stripNonDiegetic(input)).toBe('Line 1\n\nLine 2');
    });

    it('handles combined non-diegetic content', () => {
        const input = '*She smiles* ```image: portrait``` and shows a table\n| x | y |\n| 1 | 2 |\nthen continues';
        const result = stripNonDiegetic(input);
        expect(result).not.toContain('```');
        expect(result).not.toContain('| x |');
        expect(result).toContain('*She smiles*');
        expect(result).toContain('then continues');
    });

    it('returns empty string for all-non-diegetic input', () => {
        const input = '```only code here```';
        expect(stripNonDiegetic(input).trim()).toBe('');
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `stripNonDiegetic` is not exported from `lib.js`

**Step 3: Write the implementation**

Add to `lib.js` before the final empty line:

```js
// --- Non-diegetic content stripping ---

/**
 * Strip non-diegetic content from a message: code blocks, details sections,
 * markdown tables, HTML tags, and excessive newlines.
 * @param {string} text Raw message text.
 * @returns {string} Cleaned text.
 */
export function stripNonDiegetic(text) {
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<details[\s\S]*?<\/details>/gi, '')
        .replace(/\|[^\n]*\|(?:\n\|[^\n]*\|)*/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n');
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests PASS (existing 71 + new 7)

**Step 5: Update `index.js` to use `stripNonDiegetic`**

In `index.js`, the `collectRecentMessages` function (around line 2003) has inline stripping at lines 2031-2036. Note that `index.js` does NOT import from `lib.js` (it has its own copies of these functions). Add a local `stripNonDiegetic` function near the other utility functions in `index.js` with the same implementation, OR replace the 5 inline regex lines with a local helper. The simplest approach: replace the 5 regex lines (2031-2036) with a call to a new local function.

Find in `index.js` `collectRecentMessages` (around line 2031):
```js
        let text = msg.mes;
        text = text.replace(/```[\s\S]*?```/g, '');                    // code blocks (image prompts)
        text = text.replace(/<details[\s\S]*?<\/details>/gi, '');      // collapsed details sections
        text = text.replace(/\|[^\n]*\|(?:\n\|[^\n]*\|)*/g, '');       // markdown tables
        text = text.replace(/<[^>]*>/g, '');                           // HTML tags
        text = text.replace(/\n{3,}/g, '\n\n').trim();                 // collapse whitespace
```

Replace with:
```js
        let text = stripNonDiegetic(msg.mes).trim();
```

And add `stripNonDiegetic` as a local function in `index.js` (near line 500, after other utility functions) with the same body as lib.js. This keeps index.js self-contained (it doesn't import from lib.js at runtime since SillyTavern loads index.js as an extension).

**Step 6: Run existing tests to verify no regression**

Run: `npm test`
Expected: All PASS

**Step 7: Commit**

```
git add lib.js index.js test/unit/utils.test.js
git commit -m "refactor: extract stripNonDiegetic into lib.js with tests"
```

---

### Task 2: Extract `formatChatMessages()` into `lib.js`

**Files:**
- Modify: `lib.js` (add function)
- Modify: `index.js` (refactor `collectRecentMessages` to delegate)
- Test: `test/unit/utils.test.js` (add tests)

**Step 1: Write the failing test**

Add to `test/unit/utils.test.js`:

```js
import { formatChatMessages } from '../../lib.js';

describe('formatChatMessages', () => {
    const makeMsg = (name, mes, overrides = {}) => ({
        name, mes, is_user: false, is_system: false, ...overrides,
    });

    it('formats messages as "Name: text"', () => {
        const chat = [
            makeMsg('Alice', 'Hello there'),
            makeMsg('Bob', 'Hi Alice'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).toBe('Alice: Hello there\n\nBob: Hi Alice');
    });

    it('skips empty messages', () => {
        const chat = [
            makeMsg('Alice', 'Hello'),
            makeMsg('Bob', ''),
            makeMsg('Alice', 'Still here'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).toBe('Alice: Hello\n\nAlice: Still here');
        expect(result.messageCount).toBe(2);
    });

    it('skips system-only messages (no name, no user)', () => {
        const chat = [
            makeMsg('Alice', 'Hello'),
            makeMsg(null, 'System narrator text', { is_system: true }),
            makeMsg('Bob', 'Hi'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).not.toContain('System narrator');
    });

    it('keeps system messages that have a name', () => {
        const chat = [
            makeMsg('Extension', 'Some extension text', { is_system: true }),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).toContain('Extension: Some extension text');
    });

    it('strips non-diegetic content from messages', () => {
        const chat = [
            makeMsg('Alice', 'She smiled ```image prompt here``` and waved'),
        ];
        const result = formatChatMessages(chat, 0, chat.length);
        expect(result.text).not.toContain('```');
        expect(result.text).toContain('She smiled');
    });

    it('respects startIndex and endIndex', () => {
        const chat = [
            makeMsg('A', 'msg0'),
            makeMsg('B', 'msg1'),
            makeMsg('C', 'msg2'),
            makeMsg('D', 'msg3'),
        ];
        const result = formatChatMessages(chat, 1, 3);
        expect(result.text).toBe('B: msg1\n\nC: msg2');
        expect(result.startIndex).toBe(1);
        expect(result.endIndex).toBe(2);
    });

    it('returns empty for out-of-range indices', () => {
        const chat = [makeMsg('A', 'msg')];
        const result = formatChatMessages(chat, 5, 10);
        expect(result.text).toBe('');
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `formatChatMessages` is not exported

**Step 3: Write the implementation**

Add to `lib.js`:

```js
/**
 * Format chat messages for extraction prompt. Filters out empty/system-only
 * messages, strips non-diegetic content, returns "Name: text" format.
 * @param {Array<{name: string, mes: string, is_user?: boolean, is_system?: boolean}>} chatArray
 * @param {number} startIndex Start index (inclusive) in chatArray.
 * @param {number} endIndex End index (exclusive) in chatArray.
 * @returns {{ text: string, startIndex: number, endIndex: number, messageCount: number }}
 */
export function formatChatMessages(chatArray, startIndex, endIndex) {
    if (!chatArray || chatArray.length === 0) return { text: '', startIndex: -1, endIndex: -1, messageCount: 0 };

    const safeStart = Math.max(0, startIndex);
    const safeEnd = Math.min(chatArray.length, endIndex);
    if (safeStart >= safeEnd) return { text: '', startIndex: -1, endIndex: -1, messageCount: 0 };

    const slice = chatArray.slice(safeStart, safeEnd);
    const lines = [];

    for (const msg of slice) {
        if (!msg.mes) continue;
        if (msg.is_system && !msg.is_user && !msg.name) continue;
        const text = stripNonDiegetic(msg.mes).trim();
        if (!text) continue;
        lines.push(`${msg.name}: ${text}`);
    }

    return {
        text: lines.join('\n\n'),
        startIndex: safeStart,
        endIndex: safeEnd - 1,
        messageCount: lines.length,
    };
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: All PASS

**Step 5: Update `index.js` `collectRecentMessages` to delegate**

Replace the loop body in `collectRecentMessages` with a call to a local copy of `formatChatMessages`. The function still reads `getContext()`, `chat_metadata`, `extension_settings` to determine startIndex/endIndex/maxMessages, then passes the chat array to `formatChatMessages`.

**Step 6: Commit**

```
git add lib.js index.js test/unit/utils.test.js
git commit -m "refactor: extract formatChatMessages into lib.js with tests"
```

---

### Task 3: Extract `substitutePromptTemplate()` into `lib.js`

**Files:**
- Modify: `lib.js` (add function)
- Modify: `index.js` (refactor `buildExtractionPrompt` to delegate)
- Test: `test/unit/utils.test.js` (add tests)

**Step 1: Write the failing test**

```js
import { substitutePromptTemplate } from '../../lib.js';

describe('substitutePromptTemplate', () => {
    const template = 'Name: {{charName}}\nCard: {{charCard}}\nMemories: {{existingMemories}}\nMessages: {{recentMessages}}';

    it('substitutes all template variables', () => {
        const result = substitutePromptTemplate(template, {
            charName: 'Flux',
            charCard: 'A cat',
            existingMemories: '- Likes fish',
            recentMessages: 'Alex: Hello\n\nFlux: Meow',
        });
        expect(result).toBe('Name: Flux\nCard: A cat\nMemories: - Likes fish\nMessages: Alex: Hello\n\nFlux: Meow');
    });

    it('replaces multiple occurrences of the same variable', () => {
        const t = '{{charName}} says hi. {{charName}} waves.';
        const result = substitutePromptTemplate(t, { charName: 'Flux' });
        expect(result).toBe('Flux says hi. Flux waves.');
    });

    it('substitutes {{participants}} when provided', () => {
        const t = 'Participants: {{participants}}';
        const result = substitutePromptTemplate(t, { participants: 'Alice, Bob' });
        expect(result).toBe('Participants: Alice, Bob');
    });

    it('leaves unmatched variables as-is', () => {
        const t = '{{charName}} and {{unknownVar}}';
        const result = substitutePromptTemplate(t, { charName: 'Flux' });
        expect(result).toContain('{{unknownVar}}');
    });

    it('uses "(none yet)" default for missing existingMemories', () => {
        const result = substitutePromptTemplate(template, {
            charName: 'Flux', charCard: 'A cat', recentMessages: 'hi',
        });
        expect(result).toContain('(none yet)');
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Write the implementation**

Add to `lib.js`:

```js
/**
 * Substitute CharMemory template variables in a prompt string.
 * @param {string} template Prompt template with {{variable}} placeholders.
 * @param {Object} vars Variable values to substitute.
 * @param {string} [vars.charName]
 * @param {string} [vars.charCard]
 * @param {string} [vars.existingMemories]
 * @param {string} [vars.recentMessages]
 * @param {string} [vars.participants]
 * @returns {string} Prompt with variables replaced.
 */
export function substitutePromptTemplate(template, vars) {
    let result = template;
    if (vars.charName != null) result = result.replace(/\{\{charName\}\}/g, vars.charName);
    if (vars.charCard != null) result = result.replace(/\{\{charCard\}\}/g, vars.charCard);
    result = result.replace(/\{\{existingMemories\}\}/g, vars.existingMemories || '(none yet)');
    if (vars.recentMessages != null) result = result.replace(/\{\{recentMessages\}\}/g, vars.recentMessages);
    if (vars.participants != null) result = result.replace(/\{\{participants\}\}/g, vars.participants);
    return result;
}
```

**Step 4: Run tests, commit**

Run: `npm test` — all PASS

```
git add lib.js index.js test/unit/utils.test.js
git commit -m "refactor: extract substitutePromptTemplate into lib.js with tests"
```

---

### Task 4: Set up test fixture

**Files:**
- Create: `test/fixtures/flux-chat.jsonl` (copy from external repo)
- Create: `test/fixtures/sample-llm-response.txt` (hand-crafted fixture)

**Step 1: Copy the test chat JSONL**

```bash
mkdir -p test/fixtures
cp /Users/davidsayed/repos/st-test-chatlog/output/2026-01-15@08h00m00s.jsonl test/fixtures/flux-chat.jsonl
```

**Step 2: Create a sample LLM response fixture**

Create `test/fixtures/sample-llm-response.txt` with a realistic extraction response:

```
<memory chat="main_abc123" date="2026-01-15 10:00">
- Alex adopted Flux the Cat from a pet store and brought him to his penthouse apartment
- Flux immediately bonded with his custom Gundam-styled Roomba, using it as personal transport
- Alex works in marketing and had a video conference with his boss Mr. Henderson on Flux's first day
- Flux's first meal was premium salmon pate, which triggered his first purr in the new home
</memory>
```

**Step 3: Commit**

```
git add test/fixtures/
git commit -m "test: add chat fixture and sample LLM response"
```

---

### Task 5: Snapshot integration tests

**Files:**
- Create: `test/integration/snapshot.test.js`

**Step 1: Write snapshot tests**

```js
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
    it('parse → serialize → parse produces identical blocks', () => {
        const response = loadSampleResponse();
        const blocks = parseMemories(response);
        expect(blocks.length).toBeGreaterThan(0);

        const reserialized = serializeMemories(blocks);
        const reparsed = parseMemories(reserialized);

        expect(reparsed).toEqual(blocks);
    });
});
```

**Step 2: Run snapshot tests and generate initial snapshots**

Run: `npm run test:snapshot -- --update`
Expected: PASS, creates `__snapshots__/snapshot.test.js.snap`

**Step 3: Run again without --update to verify snapshots match**

Run: `npm run test:snapshot`
Expected: All PASS

**Step 4: Commit**

```
git add test/integration/ test/integration/__snapshots__/
git commit -m "test: add snapshot integration tests for extraction pipeline"
```

---

### Task 6: Live LLM integration tests

**Files:**
- Create: `test/integration/live.test.js`

**Step 1: Write live tests**

```js
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

// Read the actual default extraction prompt from index.js is not possible
// since it depends on ST imports, so we use a simplified version for testing.
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
    // Discover model if not specified
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
        expect(totalBullets).toBeLessThanOrEqual(10); // prompt says max 8, allow some slack

        // Each block has required attributes
        for (const block of blocks) {
            expect(block.bullets.length).toBeGreaterThan(0);
            for (const bullet of block.bullets) {
                expect(bullet.length).toBeGreaterThan(5);
            }
        }
    }, 60000); // 60s timeout for LLM call

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
    }, 120000); // 2min timeout for larger context
});
```

**Step 2: Run live tests (requires running LLM server)**

Run: `TEST_LLM_URL=http://127.0.0.1:1234/v1 npm run test:live`
Expected: PASS (with LM Studio or other local server running)

**Step 3: Commit**

```
git add test/integration/live.test.js
git commit -m "test: add live LLM integration tests for extraction"
```

---

### Task 7: Final verification and cleanup

**Step 1: Run all test suites**

```bash
npm test                    # unit tests (should still pass)
npm run test:snapshot       # snapshot tests
TEST_LLM_URL=http://127.0.0.1:1234/v1 npm run test:live  # live tests
```

**Step 2: Verify test count**

Expected:
- Unit: 71 existing + ~20 new = ~91 tests
- Snapshot: ~5 tests
- Live: ~3 tests

**Step 3: Final commit**

```
git add -A
git commit -m "test: complete automated testing setup for extraction pipeline"
```
