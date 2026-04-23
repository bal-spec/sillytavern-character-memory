# Chunked Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable consolidation on memory sets too large for a single LLM call by adding an auto-activating map-reduce pipeline, while preserving the existing single-call path and preview/apply/undo UX for small sets.

**Architecture:** Pure char-budget chunking + DI-based async orchestrator. `lib.js` gains two pure functions (`estimateConsolidationSize`, `packBlocksIntoChunks`). A new `consolidation.js` module exports `runChunkedConsolidation(memories, deps)` that drives map → reduce, with dependencies (`runLLM`, `logProgress`, `isCancelled`, `parseOutput`) injected — this lets tests use deterministic fakes without mocking SillyTavern globals. `consolidateMemories()` in `index.js` becomes the size-aware dispatcher.

**Tech Stack:** Vanilla JS (ES modules), Vitest, jQuery (existing pattern), SillyTavern extension APIs.

**Spec:** `docs/superpowers/specs/2026-04-23-chunked-consolidation-design.md`

---

## File Structure

**Create:**
- `consolidation.js` — new module: `runChunkedConsolidation(memories, deps)` orchestrator with DI. Async, but contains no SillyTavern-specific imports — pure orchestration logic.
- `test/unit/chunking.test.js` — unit tests for pure chunking helpers.
- `test/unit/chunkedConsolidation.test.js` — orchestrator tests using fake deps.
- `test/integration/chunkedConsolidation.live.test.js` — live-LLM test on a synthetic large-memory fixture.

**Modify:**
- `lib.js` — add `estimateConsolidationSize` and `packBlocksIntoChunks` exports.
- `index.js` — add imports, add module-scoped `consolidationCancelRequested` flag, add new settings defaults, modify `consolidateMemories()` to dispatch, add real-deps wrapper around `runChunkedConsolidation`, add Cancel-button behavior.
- `settings.html` — no changes (Advanced settings UI is built dynamically in `index.js`'s Settings Modal).
- `CHANGELOG.md` — new entry.

---

## Task 1: Add pure chunking helpers to `lib.js`

**Files:**
- Test: `test/unit/chunking.test.js` (create)
- Modify: `lib.js` (append after existing exports)

- [ ] **Step 1: Write failing tests**

Create `test/unit/chunking.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { estimateConsolidationSize, packBlocksIntoChunks } from '../../lib.js';

const block = (bullets, chat = 'c', date = '2024-01-01') => ({ chat, date, bullets });

describe('estimateConsolidationSize', () => {
    it('returns zero for empty memories', () => {
        const r = estimateConsolidationSize([]);
        expect(r.memoriesChars).toBe(0);
        expect(r.promptChars).toBe(0);
        expect(r.outputCharsEstimate).toBe(0);
    });

    it('scales with bullet content and block count', () => {
        const small = estimateConsolidationSize([block(['hello'])]);
        const big = estimateConsolidationSize([
            block(['hello']),
            block(['hello']),
            block(['hello']),
        ]);
        expect(big.memoriesChars).toBeGreaterThan(small.memoriesChars * 2);
    });

    it('includes promptTemplateLength in promptChars', () => {
        const r = estimateConsolidationSize([block(['hi'])], { promptTemplateLength: 1000 });
        expect(r.promptChars).toBeGreaterThanOrEqual(1000);
    });

    it('applies outputRatio to output estimate', () => {
        const r = estimateConsolidationSize([block(['aaaaaaaaaa'])], { outputRatio: 0.25 });
        expect(r.outputCharsEstimate).toBe(Math.round(r.memoriesChars * 0.25));
    });
});

describe('packBlocksIntoChunks', () => {
    it('returns empty array for empty input', () => {
        expect(packBlocksIntoChunks([], 1000)).toEqual([]);
    });

    it('puts small set in a single chunk', () => {
        const blocks = [block(['a']), block(['b']), block(['c'])];
        const chunks = packBlocksIntoChunks(blocks, 10000);
        expect(chunks.length).toBe(1);
        expect(chunks[0].length).toBe(3);
    });

    it('splits large set across multiple chunks preserving order', () => {
        const blocks = Array.from({ length: 20 }, (_, i) => block([`bullet content ${i} padding padding padding`]));
        const chunks = packBlocksIntoChunks(blocks, 200);
        expect(chunks.length).toBeGreaterThan(1);
        const flat = chunks.flat();
        expect(flat.length).toBe(20);
        flat.forEach((b, i) => expect(b.bullets[0]).toContain(`bullet content ${i}`));
    });

    it('places a single oversize block alone without splitting it', () => {
        const huge = block([Array(5000).fill('x').join('')]);
        const small = block(['tiny']);
        const chunks = packBlocksIntoChunks([huge, small], 1000);
        expect(chunks.length).toBe(2);
        expect(chunks[0]).toEqual([huge]);
        expect(chunks[1]).toEqual([small]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chunking.test.js`
Expected: FAIL with "estimateConsolidationSize is not defined" / "packBlocksIntoChunks is not defined".

- [ ] **Step 3: Implement in `lib.js`**

Append to `lib.js`:

```js
/**
 * Estimate the prompt and output size a consolidation call will produce.
 * @param {Array<{chat:string,date:string,bullets:string[]}>} memories
 * @param {{promptTemplateLength?:number, outputRatio?:number}} [opts]
 * @returns {{memoriesChars:number, promptChars:number, outputCharsEstimate:number}}
 */
export function estimateConsolidationSize(memories, opts = {}) {
    const { promptTemplateLength = 0, outputRatio = 0.5 } = opts;
    const memoriesChars = memories.reduce((sum, b) => sum + blockCharCount(b), 0);
    return {
        memoriesChars,
        promptChars: promptTemplateLength + memoriesChars,
        outputCharsEstimate: Math.round(memoriesChars * outputRatio),
    };
}

/**
 * Greedily pack memory blocks into chunks that each stay under a char budget.
 * Preserves block order. A single block larger than the budget is placed
 * in its own chunk (no mid-block splitting).
 * @param {Array<{chat:string,date:string,bullets:string[]}>} memories
 * @param {number} budgetChars
 * @returns {Array<Array<{chat:string,date:string,bullets:string[]}>>}
 */
export function packBlocksIntoChunks(memories, budgetChars) {
    const chunks = [];
    let current = [];
    let currentChars = 0;

    for (const b of memories) {
        const bChars = blockCharCount(b);
        if (current.length === 0) {
            current.push(b);
            currentChars = bChars;
            continue;
        }
        if (currentChars + bChars > budgetChars) {
            chunks.push(current);
            current = [b];
            currentChars = bChars;
        } else {
            current.push(b);
            currentChars += bChars;
        }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function blockCharCount(b) {
    const WRAPPER_OVERHEAD = 30; // <memory ...></memory> + newlines
    const BULLET_OVERHEAD = 3;   // "- " + newline
    return WRAPPER_OVERHEAD + b.bullets.reduce((s, x) => s + x.length + BULLET_OVERHEAD, 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chunking.test.js`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Run full unit suite to check for regressions**

Run: `npm test`
Expected: PASS, full suite green.

- [ ] **Step 6: Commit**

```bash
git add lib.js test/unit/chunking.test.js
git commit -m "feat: add pure chunking helpers for consolidation

Adds estimateConsolidationSize and packBlocksIntoChunks to lib.js as
pure, unit-tested functions. These are the foundation for chunked
consolidation (see docs/superpowers/specs/2026-04-23-chunked-consolidation-design.md)."
```

---

## Task 2: Create `consolidation.js` orchestrator with DI

**Files:**
- Create: `consolidation.js`
- Test: `test/unit/chunkedConsolidation.test.js` (create)

- [ ] **Step 1: Write failing tests**

Create `test/unit/chunkedConsolidation.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runChunkedConsolidation } from '../../consolidation.js';

const b = (n) => ({ chat: `c${n}`, date: '2024-01-01', bullets: [`bullet ${n}`] });

function makeDeps(overrides = {}) {
    return {
        runLLM: vi.fn(async (blocks) => `<memory chat="out">\n- processed ${blocks.length} blocks\n</memory>`),
        logProgress: vi.fn(),
        isCancelled: vi.fn(() => false),
        packChunks: (mems) => [mems.slice(0, 2), mems.slice(2)],
        parseOutput: (text) => [{ chat: 'parsed', date: '', bullets: [text] }],
        maxRetries: 1,
        ...overrides,
    };
}

describe('runChunkedConsolidation', () => {
    it('runs map phase for each chunk then reduces', async () => {
        const deps = makeDeps();
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(deps.runLLM).toHaveBeenCalledTimes(3); // 2 map + 1 reduce
        expect(result).toContain('<memory');
    });

    it('logs progress for start and each chunk', async () => {
        const deps = makeDeps();
        await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        const logs = deps.logProgress.mock.calls.map(c => c[0]).join('\n');
        expect(logs).toContain('starting chunked mode');
        expect(logs).toContain('chunk 1/2');
        expect(logs).toContain('chunk 2/2');
        expect(logs).toContain('reduce');
    });

    it('aborts and returns null when cancel flag is set before next chunk', async () => {
        const calls = { n: 0 };
        const deps = makeDeps({
            isCancelled: () => calls.n++ >= 1,
        });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });

    it('retries a failing chunk once and succeeds', async () => {
        let attempts = 0;
        const runLLM = vi.fn(async () => {
            attempts++;
            if (attempts === 1) throw new Error('network blip');
            return '<memory chat="ok">\n- ok\n</memory>';
        });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).not.toBeNull();
        expect(runLLM.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('aborts with null after second consecutive failure', async () => {
        const runLLM = vi.fn(async () => { throw new Error('persistent fail'); });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });

    it('skips empty chunk output without aborting', async () => {
        let n = 0;
        const runLLM = vi.fn(async () => {
            n++;
            if (n === 1) return '';                    // empty map
            return '<memory chat="ok">\n- ok\n</memory>';
        });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).not.toBeNull();
    });

    it('aborts when reduce pass returns null', async () => {
        let n = 0;
        const runLLM = vi.fn(async () => {
            n++;
            if (n <= 2) return '<memory chat="ok">\n- ok\n</memory>';
            return null; // reduce pass fails
        });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });

    it('aborts when all map outputs are empty', async () => {
        const deps = makeDeps({ runLLM: vi.fn(async () => '') });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chunkedConsolidation.test.js`
Expected: FAIL with "Failed to resolve import '../../consolidation.js'".

- [ ] **Step 3: Create `consolidation.js`**

Create the new file at repo root:

```js
/**
 * Orchestrator for chunked (map-reduce) memory consolidation.
 *
 * Pure orchestration — no SillyTavern or DOM imports. All side-effectful
 * dependencies are injected via `deps`, which keeps this module testable
 * with deterministic fakes.
 */

/**
 * @typedef {{chat:string, date:string, bullets:string[]}} MemoryBlock
 *
 * @typedef {Object} ChunkedDeps
 * @property {(chunk: MemoryBlock[]) => Promise<string|null>} runLLM
 *           Runs one consolidation LLM call. Returns serialized memory text
 *           (the same shape runConsolidationLLM already produces), or null/empty on failure.
 * @property {(msg: string) => void} logProgress
 * @property {() => boolean} isCancelled  Checked between chunks.
 * @property {(memories: MemoryBlock[]) => MemoryBlock[][]} packChunks
 * @property {(text: string) => MemoryBlock[]} parseOutput
 * @property {number} [maxRetries]  Default 1 (one retry per chunk).
 */

/**
 * @param {MemoryBlock[]} memories
 * @param {ChunkedDeps} deps
 * @returns {Promise<string|null>} Serialized memory text, or null on abort/failure.
 */
export async function runChunkedConsolidation(memories, deps) {
    const {
        runLLM,
        logProgress,
        isCancelled,
        packChunks,
        parseOutput,
        maxRetries = 1,
    } = deps;

    const chunks = packChunks(memories);
    logProgress(`Consolidation: starting chunked mode (${chunks.length} chunks)`);

    const mapOutputs = [];
    for (let i = 0; i < chunks.length; i++) {
        if (isCancelled()) {
            logProgress('Consolidation cancelled by user');
            return null;
        }

        logProgress(`Consolidating chunk ${i + 1}/${chunks.length}...`);

        let result = null;
        let lastErr = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                result = await runLLM(chunks[i]);
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt < maxRetries) {
                    logProgress(`Chunk ${i + 1} failed (${err.message}), retrying…`);
                }
            }
        }

        if (lastErr) {
            logProgress(`Chunk ${i + 1} failed after retry: ${lastErr.message}`);
            return null;
        }

        if (!result) {
            logProgress(`Chunk ${i + 1} returned empty result, skipping`);
            continue;
        }

        mapOutputs.push(result);
    }

    if (mapOutputs.length === 0) {
        logProgress('All chunks returned empty; aborting consolidation');
        return null;
    }

    logProgress('Running reduce pass…');
    const combinedBlocks = mapOutputs.flatMap(out => parseOutput(out));
    if (combinedBlocks.length === 0) {
        logProgress('No blocks parsed from map outputs; aborting consolidation');
        return null;
    }

    const reduceResult = await runLLM(combinedBlocks);
    if (!reduceResult) {
        logProgress('Reduce pass returned empty');
        return null;
    }
    return reduceResult;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chunkedConsolidation.test.js`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Run full unit suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add consolidation.js test/unit/chunkedConsolidation.test.js
git commit -m "feat: add chunked consolidation orchestrator (map-reduce)

Introduces consolidation.js with runChunkedConsolidation(memories, deps).
DI-based design keeps the orchestrator pure — dependencies (LLM runner,
progress log, cancel check, chunk packer, output parser) are injected so
tests can use deterministic fakes without touching SillyTavern globals.

Tests cover: map+reduce happy path, progress logging, cancellation
between chunks, retry-once-on-error, abort after repeated failures,
empty chunk skipping, reduce-pass failure."
```

---

## Task 3: Wire dispatcher into `consolidateMemories()` in `index.js`

**Files:**
- Modify: `index.js` (around lines 7086–7140 — the existing `consolidateMemories` function)

- [ ] **Step 1: Read the current dispatch code**

Read `index.js` lines 7086–7140 to confirm the function signature and state before editing.

- [ ] **Step 2: Add imports and settings defaults**

At the top of `index.js`, find the existing import from `./lib.js` and add the new names:

```js
import {
    // ... existing names ...
    estimateConsolidationSize,
    packBlocksIntoChunks,
} from './lib.js';
```

Add a new import near the other imports:

```js
import { runChunkedConsolidation } from './consolidation.js';
```

In the settings-defaults block (search for `consolidationStrategy: 'balanced'` — around line 454), add two new fields:

```js
    consolidationChunkChars: 24000,
    consolidationOutputRatio: 0.5,
```

- [ ] **Step 3: Add module-scoped cancel flag**

Near the existing `let consolidationBackup = null;` (around line 80), add:

```js
let consolidationCancelRequested = false;
```

- [ ] **Step 4: Modify `consolidateMemories()` to dispatch**

Locate this block inside `consolidateMemories()` (around line 7131-7138):

```js
    // Run initial consolidation — returns serialized text, parse to blocks
    let initialResult;
    try {
        initialResult = await runConsolidationLLM(memories, target.name);
    } finally {
        $btn.val('Consolidate').prop('disabled', false);
    }
    if (!initialResult) return;
```

Replace with:

```js
    // Size-aware dispatch: small sets go through the existing single-call path,
    // large sets go through the chunked map-reduce orchestrator.
    const chunkBudget = extension_settings[MODULE_NAME].consolidationChunkChars;
    const outputRatio = extension_settings[MODULE_NAME].consolidationOutputRatio;
    const sizing = estimateConsolidationSize(memories, { outputRatio });
    const useChunked = sizing.memoriesChars > chunkBudget;

    let initialResult;
    consolidationCancelRequested = false;
    try {
        if (useChunked) {
            $btn.val('Cancel');
            initialResult = await runChunkedConsolidation(memories, {
                runLLM: (chunk) => runConsolidationLLM(chunk, target.name),
                logProgress: (msg) => logActivity(msg),
                isCancelled: () => consolidationCancelRequested,
                packChunks: (mems) => packBlocksIntoChunks(mems, chunkBudget),
                parseOutput: (text) => parseMemories(text),
            });
        } else {
            initialResult = await runConsolidationLLM(memories, target.name);
        }
    } finally {
        $btn.val('Consolidate').prop('disabled', false);
        consolidationCancelRequested = false;
    }
    if (!initialResult) return;
```

- [ ] **Step 5: Run unit suite to confirm no regressions from the import changes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Manual smoke test (small memory set)**

In SillyTavern with the extension installed:
1. Open a character with a small memory file (< 20 blocks).
2. Click Consolidate.
3. Expected: behaves identically to before (single-call path), preview shows, Apply/Cancel work.

- [ ] **Step 7: Manual smoke test (large memory set — synthetic)**

1. Open a character, open Troubleshooter → Data Bank, and edit the memory file to duplicate its content 5× (quick way to exceed 24000 chars).
2. Save. Reopen Troubleshooter to confirm new block count.
3. Click Consolidate.
4. Expected in Activity Log (verbose mode on):
   - `"Consolidation: starting chunked mode (N chunks)"`
   - `"Consolidating chunk 1/N..."` … through N
   - `"Running reduce pass…"`
   - preview modal appears
5. Apply and verify the consolidated output is sensible.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat: dispatch consolidation through chunked path above size threshold

consolidateMemories() now estimates memory-set size and routes large sets
through runChunkedConsolidation (map-reduce). Small sets continue through
the existing single-call path with no behavioral change. Adds settings
defaults consolidationChunkChars (24000) and consolidationOutputRatio (0.5)
and module-scoped consolidationCancelRequested flag."
```

---

## Task 4: Add Advanced-settings UI row for chunk size

**Files:**
- Modify: `index.js` (Settings Modal Advanced section builder — search for the HTML that renders Advanced inputs)

- [ ] **Step 1: Locate the Advanced section HTML**

In `index.js`, search for `"Advanced"` or `cm_modal_advanced`. The Settings Modal sections are built dynamically — find the block that contains the existing Response Length / interval / chunk size fields.

- [ ] **Step 2: Add a new row for chunk size**

Add, adjacent to the existing numeric inputs in the Advanced section:

```html
<label for="cm_modal_consolidationChunkChars" class="charMemory_settingsLabel">
    Consolidation chunk size (chars)
    <small class="charMemory_helperText">
        Large memory sets are split into chunks of this size to avoid truncation.
        Lower = more LLM calls but handles smaller output limits.
        Default 24000. Minimum 4000.
    </small>
</label>
<input id="cm_modal_consolidationChunkChars"
       type="number"
       min="4000"
       step="1000"
       class="text_pole charMemory_numInput" />
```

In the corresponding hydrate/wire-up function (where other Advanced inputs are populated on modal open), add:

```js
$('#cm_modal_consolidationChunkChars')
    .val(extension_settings[MODULE_NAME].consolidationChunkChars || 24000)
    .off('input')
    .on('input', function () {
        const raw = Number($(this).val());
        const clamped = Number.isFinite(raw) ? Math.max(4000, Math.floor(raw)) : 24000;
        extension_settings[MODULE_NAME].consolidationChunkChars = clamped;
        saveSettingsDebounced();
    });
```

- [ ] **Step 3: Manual test**

1. Reload SillyTavern.
2. Open Settings Modal → Advanced.
3. Expected: new "Consolidation chunk size (chars)" field shows `24000`.
4. Change it to `8000`; close and reopen the modal.
5. Expected: field shows `8000`; `extension_settings.charMemory.consolidationChunkChars` in dev console shows `8000`.
6. Try entering `100` (below minimum).
7. Expected: clamps up to `4000` on the next input event.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: expose consolidation chunk size in Advanced settings

Adds a numeric input to Settings Modal → Advanced for tuning
consolidationChunkChars. Defaults to 24000, minimum 4000 (below which
the reduce-pass budget becomes too tight to be useful)."
```

---

## Task 5: Add Cancel-button UX during chunked consolidation

**Files:**
- Modify: `index.js` (`#charMemory_consolidateBtn` click handler + dispatcher from Task 3)

- [ ] **Step 1: Locate the consolidate button click handler**

Search `index.js` for `charMemory_consolidateBtn` click bindings. The existing handler invokes `consolidateMemories()`.

- [ ] **Step 2: Wire the dual-role behavior**

Replace the existing consolidate-button click handler with:

```js
$('#charMemory_consolidateBtn').off('click').on('click', () => {
    const $btn = $('#charMemory_consolidateBtn');
    if ($btn.val() === 'Cancel') {
        consolidationCancelRequested = true;
        $btn.val('Cancelling…').prop('disabled', true);
        logActivity('Consolidation cancel requested — waiting for current chunk to finish');
        return;
    }
    consolidateMemories();
});
```

- [ ] **Step 3: Verify Task 3 dispatcher resets the button label in finally**

Re-read the dispatcher block from Task 3. The `finally` block sets `$btn.val('Consolidate').prop('disabled', false)` — this handles both successful completion and mid-chunk cancellation. No further change needed.

- [ ] **Step 4: Manual test — cancellation**

1. Use the large synthetic memory file from Task 3 step 7.
2. Click Consolidate; wait until Activity Log shows `"Consolidating chunk 1/N..."` and `"Consolidating chunk 2/N..."` starting.
3. Click the button (now labeled "Cancel").
4. Expected: button becomes "Cancelling…" disabled; Activity Log shows `"Consolidation cancel requested…"`.
5. After the current chunk finishes, log shows `"Consolidation cancelled by user"`; button returns to "Consolidate" enabled; no preview modal appears.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: Cancel button during chunked consolidation

The consolidate button doubles as Cancel while chunked mode is running.
Cancel sets a flag checked between chunks; the current chunk always
finishes (no mid-fetch abort), then the orchestrator returns null and
UI resets."
```

---

## Task 6: Add live-LLM integration test

**Files:**
- Create: `test/integration/chunkedConsolidation.live.test.js`

- [ ] **Step 1: Write the live test**

```js
import { describe, it, expect } from 'vitest';
import { runChunkedConsolidation } from '../../consolidation.js';
import { parseMemories, packBlocksIntoChunks } from '../../lib.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    it('produces parseable non-truncated output on a large synthetic memory set', async () => {
        // Build ~90-block fixture by duplicating a parsed real fixture.
        const fixtureText = readFileSync(join(__dirname, '..', 'fixtures', 'flux-chat.jsonl'), 'utf-8');
        // Build 90 synthetic blocks of varied content.
        const blocks = Array.from({ length: 90 }, (_, i) => ({
            chat: `chat_${i}`,
            date: '2024-01-01',
            bullets: [
                `Alex and Flux discuss topic ${i}.`,
                `Flux's mood is ${['curious', 'playful', 'sleepy', 'hungry'][i % 4]}.`,
                `They go to ${['the cafe', 'the park', 'the apartment', 'the vet'][i % 4]}.`,
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
        expect(result).toMatch(/<\/memory>\s*$/);             // no truncation
        const parsed = parseMemories(result);
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.length).toBeLessThan(blocks.length);     // actual consolidation
        expect(logs.some(l => l.includes('reduce'))).toBe(true);
    }, 120_000); // long timeout for multi-call flow
});
```

- [ ] **Step 2: Add npm script (if not already running integration/live folder)**

Verify `package.json` has `"test:live": "vitest run test/integration/live"` — it does NOT match new filename. Update:

Read `package.json`. If the `test:live` script is `"vitest run test/integration/live"` (folder) leave it and rename the new file path: create directory `test/integration/live/` and place the file at `test/integration/live/chunkedConsolidation.test.js` instead.

If it's `"vitest run test/integration/live.test.js"` (single file), update to folder glob:

```json
"test:live": "vitest run test/integration/live",
```

Verify with:

Run: `cat package.json | grep test:live`

Expected: one of the above two forms.

- [ ] **Step 3: Run the live test against a local LLM**

Start a local OpenAI-compatible server (LM Studio or llama-cpp-server with e.g. Qwen 2.5 7B Instruct).

Run: `TEST_LLM_URL=http://127.0.0.1:1234/v1 npm run test:live -- chunkedConsolidation`

Expected: PASS. Test should complete in ~30-90 seconds depending on model speed.

- [ ] **Step 4: Commit**

```bash
git add test/integration/live/chunkedConsolidation.test.js package.json
git commit -m "test: add live-LLM test for chunked consolidation

Synthesizes a 90-block memory set and runs full map-reduce against a
local OpenAI-compatible LLM. Asserts no truncation, output is parseable,
and block count is reduced. Skipped by default (npm run test:live)."
```

---

## Task 7: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read current changelog**

Run: `head -40 CHANGELOG.md`
Note the current top-of-file version and format.

- [ ] **Step 2: Add new entry**

Insert at the top of `CHANGELOG.md`, immediately under the title (preserving the existing format):

```markdown
## 2.2.0 — 2026-04-23

### Added
- **Chunked consolidation** — long roleplays with large memory sets no longer truncate on Consolidate. The extension now auto-detects when a memory set is too large for a single LLM call and transparently switches to a map-reduce pipeline: memories are split into char-budgeted chunks, each consolidated independently, then a final reduce pass deduplicates across chunks. Small memory sets continue to use the existing single-call path (no latency change).
- **Advanced setting:** *Consolidation chunk size (chars)*, default 24000. Lower the value for LLMs with tight output limits; raise it for providers that support large responses.
- **Cancel** during chunked consolidation — the Consolidate button doubles as Cancel once chunking is in progress. Click to stop at the next chunk boundary.

### Technical
- New module `consolidation.js` with DI-based `runChunkedConsolidation` orchestrator (pure orchestration, no SillyTavern imports).
- New pure functions in `lib.js`: `estimateConsolidationSize`, `packBlocksIntoChunks`.
- New unit tests (`test/unit/chunking.test.js`, `test/unit/chunkedConsolidation.test.js`) and live-LLM test (`test/integration/live/chunkedConsolidation.test.js`).
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for 2.2.0 (chunked consolidation)"
```

- [ ] **Step 4: Bump version (optional — release step, coordinate with the user before cutting)**

Do not run this automatically. When ready to release:

```bash
# User-driven, not automated:
# 1. Bump "version" in manifest.json to 2.2.0
# 2. git add manifest.json
# 3. git commit -m "chore: release v2.2.0"
# 4. git tag v2.2.0
# 5. git push --tags origin master
```

---

## Self-Review Notes

Scanned the plan against the spec:

**Spec coverage:**
- ✅ Pure functions in lib.js → Task 1
- ✅ DI orchestrator → Task 2
- ✅ Size-aware dispatcher → Task 3
- ✅ Settings fields with defaults → Task 3 (defaults) + Task 4 (UI)
- ✅ Cancel button UX → Task 5
- ✅ Error handling (retry-once, empty-skip, reduce-fail, cancel) → Task 2 tests + Task 3 wiring
- ✅ Progress logging → Task 2 tests + Task 3 wiring
- ✅ Unit tests → Tasks 1–2
- ✅ Live LLM test → Task 6
- ✅ Rollout / CHANGELOG → Task 7
- ⚠ Mocked-callLLM integration test (spec § Testing): the DI design means Task 2's unit tests ARE this — the orchestrator is tested with fake `runLLM` deps, which is the same thing as "mocked callLLM integration" in effect. Not a gap.

**Type consistency:**
- `runLLM` in DI returns `Promise<string | null>` throughout (matches `runConsolidationLLM`'s contract).
- `parseOutput` returns `MemoryBlock[]` (matches `parseMemories`).
- `packChunks` returns `MemoryBlock[][]` (matches `packBlocksIntoChunks`).
- `MemoryBlock` shape `{ chat, date, bullets }` consistent with existing `parseMemories` output.

**Placeholder scan:** none — every step has complete code or an explicit command.
