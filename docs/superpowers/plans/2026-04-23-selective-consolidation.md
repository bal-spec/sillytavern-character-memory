# Selective Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent lossy re-compression of previously-consolidated memory blocks by adding a pre-LLM filter stage that classifies blocks as protected or eligible, consolidates only the eligible subset, and reassembles the final file with protected blocks preserved verbatim.

**Architecture:** One new pure function in `lib.js` for classification. One new modal helper and one new filter stage wired into the existing `consolidateMemories()` in `index.js`. Visual marking of protected blocks in the existing preview editor via a new CSS class plus an optional `protectedSet` parameter on `renderConsolidatedCards`. No changes to `consolidation.js`, chunking helpers, the LLM prompt, or the orchestrator.

**Tech Stack:** Vanilla JS (ES modules), Vitest, jQuery (for DOM), SillyTavern popup + toastr APIs.

**Spec:** `docs/superpowers/specs/2026-04-23-selective-consolidation-design.md`

---

## File Structure

**Create:**
- `test/unit/classification.test.js` — unit tests for the classifier.

**Modify:**
- `lib.js` — export new `classifyBlocksForConsolidation`.
- `index.js` — import the classifier; add `showBlockSelectionModal()` helper; add filter stage inside `consolidateMemories()`; extend `renderConsolidatedCards()` with an optional `protectedSet` parameter.
- `style.css` — add `.charMemory_protectedBlock` styling and `.charMemory_protectedBadge`.
- `CHANGELOG.md` — new bullet in existing `## 2.2.0` → `### New Features`.

---

## Task 1: Add `classifyBlocksForConsolidation` to `lib.js`

**Files:**
- Test: `test/unit/classification.test.js` (create)
- Modify: `lib.js` (append after existing exports)

- [ ] **Step 1: Write failing tests**

Create `test/unit/classification.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- classification.test.js`
Expected: FAIL with "classifyBlocksForConsolidation is not defined".

- [ ] **Step 3: Implement in `lib.js`**

Append to `lib.js`:

```js
/**
 * Classify memory blocks into "eligible" (candidates for re-consolidation) and
 * "protected" (preserved verbatim). A block is protected when its chat label
 * fails the URL-safe ID pattern — which is the convention for extraction chat
 * IDs — OR when the block is structurally malformed or uses the "unknown"
 * placeholder. Order is preserved within each bucket.
 * @param {Array<{chat:string,date:string,bullets:string[]}>} memories
 * @returns {{ eligible: Array, protected: Array }}
 */
export function classifyBlocksForConsolidation(memories) {
    const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
    const eligible = [];
    const protectedBlocks = [];
    for (const b of memories) {
        const hasBullets = Array.isArray(b?.bullets);
        const chatLabel = typeof b?.chat === 'string' ? b.chat : '';
        const isIdLike = chatLabel !== '' && chatLabel !== 'unknown' && ID_PATTERN.test(chatLabel);
        if (hasBullets && isIdLike) {
            eligible.push(b);
        } else {
            protectedBlocks.push(b);
        }
    }
    return { eligible, protected: protectedBlocks };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- classification.test.js`
Expected: PASS, 8 tests green.

- [ ] **Step 5: Run full unit suite**

Run: `npm test`
Expected: PASS, 173 tests total (was 165 + 8 new).

- [ ] **Step 6: Commit**

```bash
git add lib.js test/unit/classification.test.js
git commit -m "feat: add classifyBlocksForConsolidation pure function

Partitions memory blocks into 'eligible' (chat-ID-style labels) and
'protected' (themed labels from previous consolidations, 'unknown'
placeholders, or malformed blocks). Pure and unit-tested. Foundation
for selective consolidation (see docs/superpowers/specs/2026-04-23-selective-consolidation-design.md)."
```

---

## Task 2: Extend `renderConsolidatedCards` to mark protected blocks

**Files:**
- Modify: `index.js` (function at line 7034; callers at lines 743, 865, 6324, 6336, 6846, 6858, 7117, 7367, 7587)
- Modify: `style.css` (add new classes)

The existing signature is `renderConsolidatedCards(blocks, editingSet, highlightPattern = null)`. We add an optional fourth parameter `protectedIndices = new Set()`. All existing call sites still work without modification because the default is an empty set.

- [ ] **Step 1: Add CSS for protected blocks**

Append to `style.css`:

```css
/* Selective consolidation: blocks preserved verbatim during consolidation */
.charMemory_card.charMemory_protectedBlock {
    opacity: 0.7;
    background: rgba(128, 128, 128, 0.08);
    border-left: 3px solid var(--SmartThemeQuoteColor, #888);
}

.charMemory_protectedBadge {
    display: inline-block;
    font-size: 0.75em;
    font-weight: normal;
    padding: 1px 6px;
    margin-left: 8px;
    background: rgba(128, 128, 128, 0.15);
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 3px;
    color: var(--SmartThemeBodyColor, inherit);
    vertical-align: middle;
}
```

- [ ] **Step 2: Update `renderConsolidatedCards` signature and rendering**

In `index.js` at the function definition on line 7034, replace:

```js
function renderConsolidatedCards(blocks, editingSet, highlightPattern = null) {
    return blocks.map((b, bi) => {
        const isEditing = editingSet.has(bi);
        const themeLabel = `${bi + 1}. ${b.chat}`;
```

With:

```js
function renderConsolidatedCards(blocks, editingSet, highlightPattern = null, protectedIndices = new Set()) {
    return blocks.map((b, bi) => {
        const isEditing = editingSet.has(bi);
        const isProtected = protectedIndices.has(bi);
        const themeLabel = `${bi + 1}. ${b.chat}`;
```

Then, further down in the same function, find the read-only card return (currently around line 7061):

```js
            return `<div class="charMemory_card charMemory_editorCard" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <strong>${headerHtml}</strong>
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Edit block" data-i18n="[title]Edit block"><i class="fa-solid fa-pencil"></i></button>
                    </span>
                </div>
                <ul>${bullets}</ul>
            </div>`;
```

Replace with:

```js
            const cardClass = `charMemory_card charMemory_editorCard${isProtected ? ' charMemory_protectedBlock' : ''}`;
            const badge = isProtected
                ? `<span class="charMemory_protectedBadge" data-i18n="Protected — unchanged">Protected — unchanged</span>`
                : '';
            return `<div class="${cardClass}" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <strong>${headerHtml}</strong>${badge}
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Edit block" data-i18n="[title]Edit block"><i class="fa-solid fa-pencil"></i></button>
                    </span>
                </div>
                <ul>${bullets}</ul>
            </div>`;
```

No changes to the editing-mode branch — protected blocks are only visually marked in read-only mode. If a user clicks Edit on a protected block, they can still edit it (no special handling needed — the badge just disappears when the card enters edit mode, which is acceptable).

- [ ] **Step 3: Verify existing call sites still work**

Run: `npm test`
Expected: PASS, 173 tests (no test regressions since `renderConsolidatedCards` isn't unit-tested — we rely on build cleanliness).

Run: `node --check index.js 2>&1 | head -5`
Expected: No output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add index.js style.css
git commit -m "feat: visual marking for protected blocks in consolidation preview

Adds an optional protectedIndices parameter to renderConsolidatedCards.
Blocks whose index is in the set get a dimmed card, a colored left
border, and a 'Protected — unchanged' badge. All existing call sites
continue to work unchanged (default is an empty set)."
```

---

## Task 3: Add `showBlockSelectionModal` helper

**Files:**
- Modify: `index.js` (new function; place near other modal builders — search for `showBatchPopup` or similar)

- [ ] **Step 1: Find a location to add the new helper**

Run: `grep -n "^async function showBatchPopup\|^function showBlockSelectionModal\|^async function showBlockSelectionModal" /Users/davidsayed/repos/sillytavern-character-memory/index.js | head`
Use the location of `showBatchPopup` (or a similar sibling modal builder) as a placement hint. Add the new helper adjacent to it.

- [ ] **Step 2: Add the helper**

Insert this function into `index.js`, above `async function consolidateMemories()` (around line 7280):

```js
/**
 * Show a modal letting the user pick which memory blocks to consolidate.
 * Returns a Set<number> of block indices to use as the eligible set, or
 * null if the user cancelled.
 * @param {Array<{chat:string,date:string,bullets:string[]}>} allBlocks
 * @param {Set<number>} initialEligible Indices to pre-check.
 * @param {string} charName
 * @returns {Promise<Set<number>|null>}
 */
async function showBlockSelectionModal(allBlocks, initialEligible, charName) {
    const rows = allBlocks.map((b, i) => {
        const firstBullet = (b.bullets && b.bullets[0]) ? b.bullets[0] : '';
        const truncated = firstBullet.length > 120 ? firstBullet.slice(0, 117) + '…' : firstBullet;
        const checked = initialEligible.has(i) ? 'checked' : '';
        const badgeClass = initialEligible.has(i) ? 'charMemory_eligibleBadge' : 'charMemory_protectedBadge';
        const badgeText = initialEligible.has(i) ? t`Will consolidate` : t`Protected`;
        return `<div class="charMemory_blockPickerRow" data-index="${i}">
            <label class="checkbox_label">
                <input type="checkbox" class="charMemory_blockPickerCheck" data-index="${i}" ${checked} />
                <span class="charMemory_blockPickerLabel"><strong>${escapeHtml(b.chat)}</strong> <span class="${badgeClass}">${badgeText}</span></span>
            </label>
            <div class="charMemory_blockPickerPreview">${escapeHtml(truncated)}</div>
        </div>`;
    }).join('');

    const html = `<div class="charMemory_blockPicker">
        <p>${t`Select which blocks of ${escapeHtml(charName)}'s memories to consolidate. Unchecked blocks are preserved verbatim.`}</p>
        <div class="charMemory_blockPickerActions">
            <button type="button" class="menu_button" id="charMemory_blockPickerAll" data-i18n="Select all">Select all</button>
            <button type="button" class="menu_button" id="charMemory_blockPickerNone" data-i18n="Select none">Select none</button>
            <span class="charMemory_blockPickerCount" id="charMemory_blockPickerCount"></span>
        </div>
        <div class="charMemory_blockPickerList">${rows}</div>
    </div>`;

    // Wire master checkboxes + live count once the popup is in the DOM
    const updateCount = () => {
        const checked = $('.charMemory_blockPickerCheck:checked').length;
        $('#charMemory_blockPickerCount').text(t`${checked} of ${allBlocks.length} selected`);
    };
    $(document).on('change.blockPicker', '.charMemory_blockPickerCheck', updateCount);
    $(document).on('click.blockPicker', '#charMemory_blockPickerAll', () => {
        $('.charMemory_blockPickerCheck').prop('checked', true);
        updateCount();
    });
    $(document).on('click.blockPicker', '#charMemory_blockPickerNone', () => {
        $('.charMemory_blockPickerCheck').prop('checked', false);
        updateCount();
    });

    // Schedule the initial count update after the popup renders
    setTimeout(updateCount, 0);

    const ok = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: t`Run consolidation`,
        cancelButton: t`Cancel`,
    });

    // Read selection before teardown
    let result = null;
    if (ok) {
        result = new Set();
        $('.charMemory_blockPickerCheck:checked').each(function () {
            result.add(Number($(this).data('index')));
        });
    }

    // Teardown
    $(document).off('change.blockPicker');
    $(document).off('click.blockPicker');

    return result;
}
```

- [ ] **Step 3: Add supporting CSS**

Append to `style.css`:

```css
/* Block selection modal (selective consolidation override UI) */
.charMemory_blockPicker { display: flex; flex-direction: column; gap: 8px; }
.charMemory_blockPickerActions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.charMemory_blockPickerCount { margin-left: auto; font-size: 0.9em; opacity: 0.8; }
.charMemory_blockPickerList { max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(128, 128, 128, 0.3); padding: 8px; border-radius: 4px; }
.charMemory_blockPickerRow { padding: 4px 6px; border-radius: 4px; }
.charMemory_blockPickerRow:nth-child(even) { background: rgba(128, 128, 128, 0.05); }
.charMemory_blockPickerLabel { margin-left: 4px; }
.charMemory_blockPickerPreview { font-size: 0.85em; opacity: 0.75; margin-left: 24px; margin-top: 2px; }
.charMemory_eligibleBadge {
    display: inline-block;
    font-size: 0.75em;
    padding: 1px 6px;
    margin-left: 6px;
    background: rgba(80, 200, 80, 0.15);
    border: 1px solid rgba(80, 200, 80, 0.3);
    border-radius: 3px;
    vertical-align: middle;
}
```

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: PASS 173/173.

- [ ] **Step 5: Syntax sanity-check**

Run: `node --check index.js 2>&1 | head -3`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add index.js style.css
git commit -m "feat: add showBlockSelectionModal for selective consolidation override

Modal lists every memory block with a checkbox pre-set by the
heuristic classifier. Select-all / select-none masters, live count in
footer, and a Cancel path that returns null. Purely presentational —
wired in the next task."
```

---

## Task 4: Wire the filter stage into `consolidateMemories()`

**Files:**
- Modify: `index.js` (import block; `consolidateMemories` function at line 7281)

- [ ] **Step 1: Add import**

Find the existing lib.js import block in `index.js` (ends at around line 55):

```js
    ...
    estimateConsolidationSize,
    packBlocksIntoChunks,
} from './lib.js';
```

Add `classifyBlocksForConsolidation` to the list:

```js
    ...
    estimateConsolidationSize,
    packBlocksIntoChunks,
    classifyBlocksForConsolidation,
} from './lib.js';
```

- [ ] **Step 2: Insert the filter stage in `consolidateMemories()`**

Locate this exact block around line 7312-7320 of `index.js`:

```js
    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info(t`Not enough memories to consolidate.`, 'CharMemory');
        return;
    }

    const beforeCount = countMemories(memories);
    logActivity(`Consolidation started for ${target.name}: ${beforeCount} memories in ${memories.length} blocks`);
```

Replace with:

```js
    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info(t`Not enough memories to consolidate.`, 'CharMemory');
        return;
    }

    // Classify blocks: protected blocks stay verbatim; eligible blocks go to the LLM.
    // Classification is heuristic — the user can override via the "Change selection…" modal.
    const { eligible: initialEligible, protected: initialProtected } = classifyBlocksForConsolidation(memories);

    // Build eligibleIndices (Set<number>) tracking positions in the original `memories` list.
    // We mutate this set if the user overrides, then derive eligible/protected from it again.
    let eligibleIndices = new Set();
    memories.forEach((b, i) => {
        if (initialEligible.includes(b)) eligibleIndices.add(i);
    });

    // If any blocks are protected, show a confirm popup with an override option.
    if (initialProtected.length > 0) {
        const protectedCount = initialProtected.length;
        const eligibleCount = initialEligible.length;
        const summary = t`Protecting ${protectedCount} blocks from prior consolidations. Consolidating ${eligibleCount} new blocks.<br><br>Click <strong>Change selection…</strong> to adjust which blocks are protected, or <strong>Proceed</strong> to continue.`;
        let openedModal = false;
        const popup = callGenericPopup(summary, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Proceed`,
            cancelButton: t`Change selection…`,
        });
        const proceed = await popup;
        if (!proceed) {
            // User clicked "Change selection…" — open the picker modal.
            openedModal = true;
            const picked = await showBlockSelectionModal(memories, eligibleIndices, target.name);
            if (picked === null) {
                // Cancelled out of the picker — abort the whole consolidation.
                logActivity('Consolidation cancelled — no changes made.');
                return;
            }
            eligibleIndices = picked;
        }
    }

    // Derive eligible and protected from the (possibly-overridden) eligibleIndices.
    const eligible = memories.filter((_, i) => eligibleIndices.has(i));
    const protectedBlocks = memories.filter((_, i) => !eligibleIndices.has(i));

    if (eligible.length < 2) {
        if (eligible.length === 0) {
            toastr.info(t`All memories appear to be already consolidated — nothing new to do.`, 'CharMemory');
        } else {
            toastr.info(t`Only 1 new block since last consolidation — not enough to consolidate (minimum 2).`, 'CharMemory');
        }
        return;
    }

    const beforeCount = countMemories(eligible);
    logActivity(`Consolidation started for ${target.name}: ${beforeCount} eligible memories in ${eligible.length} blocks (${protectedBlocks.length} protected)`);
```

- [ ] **Step 3: Replace the `memories` parameter passed to the LLM with `eligible`**

Immediately below the block you just inserted, the existing code reads:

```js
    // Route large memory sets through the chunked map-reduce orchestrator.
    const chunkBudget = extension_settings[MODULE_NAME].consolidationChunkChars;
    const outputRatio = extension_settings[MODULE_NAME].consolidationOutputRatio;
    const sizing = estimateConsolidationSize(memories, { outputRatio });
    // sizing.outputCharsEstimate is reserved for future per-chunk pressure checks.
    const useChunked = sizing.memoriesChars > chunkBudget;

    let initialResult;
    consolidationCancelRequested = false;
    try {
        if (useChunked) {
            // Re-enable so the user can click Cancel (Task 5 wires the click handler).
            $btn.val(t`Cancel`).prop('disabled', false);
            initialResult = await runChunkedConsolidation(memories, {
                // runConsolidationLLM catches LLM errors and returns null, so the
                // orchestrator's retry-on-throw path will not fire for transient
                // failures. Failed chunks are skipped. Follow-up to propagate
                // retriable errors is tracked separately.
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
        $btn.val(t`Consolidate`).prop('disabled', false);
    }
```

Change the four uses of `memories` in this block to `eligible`:

```js
    // Route large memory sets through the chunked map-reduce orchestrator.
    const chunkBudget = extension_settings[MODULE_NAME].consolidationChunkChars;
    const outputRatio = extension_settings[MODULE_NAME].consolidationOutputRatio;
    const sizing = estimateConsolidationSize(eligible, { outputRatio });
    // sizing.outputCharsEstimate is reserved for future per-chunk pressure checks.
    const useChunked = sizing.memoriesChars > chunkBudget;

    let initialResult;
    consolidationCancelRequested = false;
    try {
        if (useChunked) {
            // Re-enable so the user can click Cancel (Task 5 wires the click handler).
            $btn.val(t`Cancel`).prop('disabled', false);
            initialResult = await runChunkedConsolidation(eligible, {
                // runConsolidationLLM catches LLM errors and returns null, so the
                // orchestrator's retry-on-throw path will not fire for transient
                // failures. Failed chunks are skipped. Follow-up to propagate
                // retriable errors is tracked separately.
                runLLM: (chunk) => runConsolidationLLM(chunk, target.name),
                logProgress: (msg) => logActivity(msg),
                isCancelled: () => consolidationCancelRequested,
                packChunks: (mems) => packBlocksIntoChunks(mems, chunkBudget),
                parseOutput: (text) => parseMemories(text),
            });
        } else {
            initialResult = await runConsolidationLLM(eligible, target.name);
        }
    } finally {
        $btn.val(t`Consolidate`).prop('disabled', false);
    }
```

- [ ] **Step 4: Assemble final blocks and feed the preview editor with `protectedSet`**

The current code after the LLM call reads (around line 7357):

```js
    if (!initialResult) return;

    const editor = createMemoryEditor({ blocks: parseMemories(initialResult) });
    const rerunBackups = []; // separate stack for re-run undo
    let consolFindPattern = null;

    // Re-render the editor pane from editor state
    const refreshEditor = (highlightPattern) => {
        if (highlightPattern !== undefined) consolFindPattern = highlightPattern;
        const blocks = editor.getBlocks();
        const editing = editor.getEditingSet();
        $('#charMemory_editorPane').html(renderConsolidatedCards(blocks, editing, consolFindPattern));
        $('#charMemory_afterCount').text(countMemories(blocks));
        $('#charMemory_editorAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
    };
```

Replace with:

```js
    if (!initialResult) return;

    // Assemble finalBlocks = protected + newly consolidated. Protected blocks retain
    // their original order; newly consolidated output is appended. Indices 0..N-1
    // (where N = protectedBlocks.length) are the protected ones for visual marking.
    const newlyConsolidatedBlocks = parseMemories(initialResult);
    const assembledBlocks = [...protectedBlocks, ...newlyConsolidatedBlocks];
    const protectedPreviewIndices = new Set(protectedBlocks.map((_, i) => i));

    const editor = createMemoryEditor({ blocks: assembledBlocks });
    const rerunBackups = []; // separate stack for re-run undo
    let consolFindPattern = null;

    // Re-render the editor pane from editor state.
    // Protected-block indices are computed from the current block list by matching
    // against the original protectedBlocks array (by identity). If the user edits
    // or deletes protected blocks inside the preview, their "protected" visual
    // marking naturally follows — we derive indices from the current list each refresh.
    const refreshEditor = (highlightPattern) => {
        if (highlightPattern !== undefined) consolFindPattern = highlightPattern;
        const blocks = editor.getBlocks();
        const editing = editor.getEditingSet();
        const currentProtectedIndices = new Set();
        blocks.forEach((b, i) => {
            if (protectedBlocks.includes(b)) currentProtectedIndices.add(i);
        });
        $('#charMemory_editorPane').html(renderConsolidatedCards(blocks, editing, consolFindPattern, currentProtectedIndices));
        $('#charMemory_afterCount').text(countMemories(blocks));
        $('#charMemory_editorAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
    };
```

Also update the initial render inside `buildConsolidationDialog` (the dialog HTML template) — open the file and find where `renderConsolidatedCards(consolidatedBlocks, editingSet)` is called inside a template literal. It's around line 7117.

Replace the template literal line:

```js
                <div class="charMemory_consolidationContent" id="charMemory_editorPane">${renderConsolidatedCards(consolidatedBlocks, editingSet)}</div>
```

with:

```js
                <div class="charMemory_consolidationContent" id="charMemory_editorPane">${renderConsolidatedCards(consolidatedBlocks, editingSet, null, protectedPreviewIndices || new Set())}</div>
```

Then find where `buildConsolidationDialog` is called (around line 7375):

```js
    const dialogHtml = buildConsolidationDialog(memories, beforeCount, initBlocks, initEditing);
```

Change this call to pass `protectedPreviewIndices`:

```js
    const dialogHtml = buildConsolidationDialog(eligible, beforeCount, initBlocks, initEditing, protectedPreviewIndices);
```

And update the `buildConsolidationDialog` function signature to accept the new parameter. Find the function (around line 7074):

```js
function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedBlocks, editingSet) {
```

Change to:

```js
function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedBlocks, editingSet, protectedPreviewIndices = new Set()) {
```

- [ ] **Step 5: Run unit suite to check for regressions from the imports**

Run: `npm test`
Expected: PASS, 173/173.

Run: `node --check index.js 2>&1 | head -3`
Expected: no output (syntax clean).

- [ ] **Step 6: Manual smoke test — no protected blocks**

1. In SillyTavern, pick a character with a fresh memory file (all extraction blocks, chat labels look like IDs).
2. Click Consolidate.
3. Expected: NO confirm popup appears. LLM runs directly on all blocks (same as before this task).
4. Preview opens; no blocks show the protected badge.
5. Apply; verify file is updated.

- [ ] **Step 7: Manual smoke test — some protected blocks**

1. Pick a character with mixed extraction + previously-consolidated blocks (or manually edit the memory file in the Data Bank to add one block with `chat="A previous theme"`).
2. Click Consolidate.
3. Expected: confirm popup shows "Protecting N blocks from prior consolidations. Consolidating M new blocks."
4. Click Proceed.
5. LLM runs on the M eligible blocks only.
6. Preview opens showing N protected blocks (dimmed, with "Protected — unchanged" badge) followed by the newly consolidated ones.
7. Apply; verify file has the protected blocks preserved verbatim plus the new consolidated content.

- [ ] **Step 8: Manual smoke test — override path**

1. Same setup as Step 7.
2. Click Consolidate → confirm popup appears.
3. Click "Change selection…".
4. Expected: block-picker modal opens showing all blocks with checkboxes. Heuristic-eligible blocks are checked; heuristic-protected ones are unchecked.
5. Uncheck one of the eligible blocks and check one of the protected ones.
6. Click "Run consolidation".
7. Expected: LLM runs on the new eligible set; preview reflects the override.
8. Click Cancel in the picker instead of Run → whole consolidation aborts.

- [ ] **Step 9: Commit**

```bash
git add index.js
git commit -m "feat: wire selective consolidation filter stage into consolidateMemories

Classifies blocks as eligible/protected via chat-attribute heuristic.
If any blocks are classified protected, a confirm popup offers Proceed
or 'Change selection…'. The LLM only consolidates the eligible subset;
protected blocks are preserved verbatim and reassembled at the front
of the final file. Preview editor visually distinguishes protected
blocks via the existing protectedIndices rendering."
```

---

## Task 5: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find the existing chunked-consolidation bullet**

Open `CHANGELOG.md`. The `## 2.2.0` → `### New Features` list has a recent bullet:

```markdown
- **Chunked consolidation for very long chats**: ...
```

- [ ] **Step 2: Insert a new bullet immediately after it**

After the closing backtick/period of the "Chunked consolidation…" bullet, add the following verbatim:

```markdown
- **Selective consolidation protects previously-consolidated memories**: Repeated consolidations no longer degrade older content. The extension now auto-detects which blocks came from prior consolidations (themed chat labels like *First vet visit*) vs. original extractions (chat IDs like `main_chat_abc123`), and only re-consolidates the new extraction blocks — prior summaries are preserved verbatim. A confirm popup shows the split before each run; click **Change selection…** to open a per-block picker for full override control. Addresses long-roleplay feedback where multiple consolidations were producing "rewrites of rewrites."
```

- [ ] **Step 3: Verify**

Run: `grep -c "Selective consolidation" CHANGELOG.md`
Expected: 1.

Run: `grep -c "^## 2.2.0" CHANGELOG.md`
Expected: 1 (no duplicate heading).

Run: `npm test`
Expected: PASS 173/173.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for selective consolidation in 2.2.0"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ Pure classifier function → Task 1
- ✅ Filter stage in consolidateMemories → Task 4
- ✅ Confirm popup with Proceed/Change-selection → Task 4 Step 2
- ✅ Block selection modal → Task 3
- ✅ Assembled final blocks [protected, ...new] → Task 4 Step 4
- ✅ Preview editor marks protected blocks visually → Task 2 + Task 4 Step 4
- ✅ Edge cases (zero eligible, one eligible, cancel) → Task 4 Step 2
- ✅ Unit tests for classifier → Task 1
- ✅ CHANGELOG → Task 5

**Type consistency:**
- `classifyBlocksForConsolidation` returns `{ eligible: Array, protected: Array }` — consistent across Task 1 (impl + tests) and Task 4 (consumer).
- `protectedIndices` / `protectedPreviewIndices` are `Set<number>` throughout Tasks 2 and 4.
- `renderConsolidatedCards(blocks, editingSet, highlightPattern, protectedIndices)` — 4-arg signature consistent across Task 2 (definition) and Task 4 (callers).

**Placeholder scan:** none — every step has complete code.

**Out-of-scope reminders (not in this plan):**
- No persistent `protected="true"` block attribute.
- No changes to `consolidation.js`, `lib.js` chunking helpers, or the LLM prompt.
- No live LLM test — the live test from chunked consolidation covers the orchestrator path; selective consolidation's logic is entirely covered by the classifier unit tests plus manual smoke tests.
