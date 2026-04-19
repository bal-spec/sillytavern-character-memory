# Issue #16: Extraction Lag + Mobile UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two user-facing improvements from GitHub issue #16: (A) extraction lag + generation-gating so automatic extraction never races the primary LLM on single-GPU local-inference setups, and (B) mobile/Android UX fixes so the sidebar drawers and memory editor work correctly in Chrome on Android.

**Architecture:**
- Part A extracts the extraction-trigger decision into a pure function `shouldExtractNow()` in `lib.js` (testable), adds an `extractionLag` setting, tracks ST's `GENERATION_STARTED` / `GENERATION_ENDED` / `GENERATION_STOPPED` events to gate extraction, and defers to idle windows when a generation is active.
- Part B fixes three root causes on mobile: (1) browser auto-zoom when focusing inputs with `font-size < 16px`, (2) fixed-position drawer close buttons that fall behind ST's sidebar on narrow viewports, (3) drawer geometry computed from `getBoundingClientRect()` that doesn't update on `visualViewport` resize (pinch-zoom).

**Tech Stack:** Vanilla JS (ES modules), jQuery, Vitest, SillyTavern extension API (`eventSource`, `event_types`, `extension_settings`).

---

## File Map

| File | Change |
|------|--------|
| `lib.js` | Add pure `shouldExtractNow()` function |
| `test/unit/extraction-gate.test.js` | New — unit tests for `shouldExtractNow()` |
| `index.js` | Import `shouldExtractNow`, add lag setting default, track `isGenerating`, gate `onCharacterMessageRendered`, retry on `GENERATION_ENDED`, add lag UI control to Settings Modal, default-close drawers on narrow viewports, recompute drawer top on `visualViewport` resize |
| `style.css` | Add `@media (max-width: 768px)` rules: `font-size: 16px` on memory editor textareas/inputs, `touch-action: manipulation` on drawer close buttons, verify drawer `z-index` beats ST sidebar |
| `settings.html` | No change (all new UI lives in Settings Modal) |
| `README.md` | Document the new `extractionLag` setting under Extraction Tuning |
| `CHANGELOG.md` | Entry for the new version |

---

## Part A — Extraction Lag + Generation Gate

### Task 1: Pure `shouldExtractNow()` in `lib.js`

**Files:**
- Modify: `lib.js` (add new export)
- Test: `test/unit/extraction-gate.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/extraction-gate.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- extraction-gate`
Expected: FAIL with `shouldExtractNow is not a function` or `not exported`.

- [ ] **Step 3: Implement `shouldExtractNow` in `lib.js`**

Add at the end of `lib.js` (before any trailing export barrels if present; otherwise at the bottom):

```javascript
/**
 * Decide whether automatic extraction should fire right now.
 * Pure function — caller supplies all state, including `now` for deterministic tests.
 *
 * Order of checks (first matching wins):
 *   1. below-interval       — haven't accumulated enough new messages yet
 *   2. generation-active    — a primary-LLM generation is in flight; defer to idle
 *   3. cooldown             — not enough time has elapsed since the last extraction
 *   4. fire                 — all gates pass
 *
 * @param {object} state
 * @param {number} state.messagesSinceExtraction - Messages seen since last extraction.
 * @param {number} state.interval - Configured extraction interval (messages).
 * @param {number} [state.extractionLag=0] - Additional messages to wait past the interval.
 * @param {boolean} state.isGenerating - True if a primary-LLM generation is currently running.
 * @param {number} state.now - Current timestamp (ms).
 * @param {number} state.lastExtractionTime - Timestamp of the last successful extraction (ms).
 * @param {number} state.cooldownMs - Minimum ms between extractions (0 disables).
 * @returns {{fire: true} | {fire: false, reason: string, remainingMs?: number}}
 */
export function shouldExtractNow({
    messagesSinceExtraction,
    interval,
    extractionLag = 0,
    isGenerating,
    now,
    lastExtractionTime,
    cooldownMs,
}) {
    if (messagesSinceExtraction < interval + extractionLag) {
        return { fire: false, reason: 'below-interval' };
    }
    if (isGenerating) {
        return { fire: false, reason: 'generation-active' };
    }
    if (cooldownMs > 0) {
        const elapsed = now - lastExtractionTime;
        if (elapsed < cooldownMs) {
            return { fire: false, reason: 'cooldown', remainingMs: cooldownMs - elapsed };
        }
    }
    return { fire: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- extraction-gate`
Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib.js test/unit/extraction-gate.test.js
git commit -m "feat(extraction): add pure shouldExtractNow decision function with lag + generation gate"
```

---

### Task 2: Add `extractionLag` setting default

**Files:**
- Modify: `index.js:1562` (defaultSettings block — exact line may shift; locate the object literal containing `interval: 20`)

- [ ] **Step 1: Locate the defaults object**

Run: `grep -n "interval: 20" index.js`
Expected: one line around `index.js:1562`. The surrounding object is the `defaultSettings`.

- [ ] **Step 2: Add the new field**

Find:

```javascript
    interval: 20,
```

Replace with:

```javascript
    interval: 20,
    extractionLag: 0,
```

- [ ] **Step 3: Verify no other defaults need touching**

Run: `grep -n "extractionLag" index.js`
Expected: exactly one match (the line you just added).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(extraction): add extractionLag setting default"
```

---

### Task 3: Track `isGenerating` via ST events

**Files:**
- Modify: `index.js` — add module-level state, add event listeners in `setupListeners()` area around line 8987

- [ ] **Step 1: Locate the event-registration block**

Run: `grep -n "CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered" index.js`
Expected: one line around `index.js:8987`. That block is where we add new listeners.

- [ ] **Step 2: Add module-level generation state**

Near the top of `index.js`, alongside other module state (search for `let lastExtractionTime` — add below it):

```javascript
let isGenerating = false;
let pendingExtraction = false;
```

- [ ] **Step 3: Add the event listeners**

In the same block as `eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered)`, add:

```javascript
    eventSource.on(event_types.GENERATION_STARTED, () => {
        isGenerating = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        isGenerating = false;
        if (pendingExtraction) {
            pendingExtraction = false;
            logActivity('Running deferred extraction now that generation ended');
            extractMemories({ force: false });
        }
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        isGenerating = false;
        // Don't auto-run deferred extraction after user abort — they may want to edit and retry.
        pendingExtraction = false;
    });
```

- [ ] **Step 4: Verify**

Run: `grep -n "GENERATION_STARTED\|GENERATION_ENDED\|GENERATION_STOPPED" index.js`
Expected: three matches, all inside the event registration block.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(extraction): track primary-LLM generation state via ST events"
```

---

### Task 4: Wire the gate into `onCharacterMessageRendered`

**Files:**
- Modify: `index.js:3139-3166` (`onCharacterMessageRendered` function)

- [ ] **Step 1: Add the import at the top of `index.js`**

Find the existing `lib.js` import (`grep -n "from './lib.js'" index.js`) and add `shouldExtractNow` to it. Example — if the existing line is:

```javascript
import { parseMemoryBlocks, stripNonDiegetic, formatChatMessages } from './lib.js';
```

Replace with:

```javascript
import { parseMemoryBlocks, shouldExtractNow, stripNonDiegetic, formatChatMessages } from './lib.js';
```

(Keep whatever names were already imported — just add `shouldExtractNow` alphabetically.)

- [ ] **Step 2: Replace the extraction decision block**

Find in `index.js:3153-3166`:

```javascript
    const count = chat_metadata[MODULE_NAME].messagesSinceExtraction;
    const interval = extension_settings[MODULE_NAME].interval;

    if (count >= interval) {
        const cooldownMs = (extension_settings[MODULE_NAME].minCooldownMinutes || 0) * 60000;
        const elapsed = Date.now() - lastExtractionTime;
        if (cooldownMs > 0 && elapsed < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
            logActivity(`Extraction skipped: cooldown active (${remaining}m remaining)`, 'warning');
            return;
        }
        extractMemories({ force: false });
    }
}
```

Replace with:

```javascript
    const count = chat_metadata[MODULE_NAME].messagesSinceExtraction;
    const settings = extension_settings[MODULE_NAME];
    const decision = shouldExtractNow({
        messagesSinceExtraction: count,
        interval: settings.interval,
        extractionLag: settings.extractionLag || 0,
        isGenerating,
        now: Date.now(),
        lastExtractionTime,
        cooldownMs: (settings.minCooldownMinutes || 0) * 60000,
    });

    if (decision.fire) {
        extractMemories({ force: false });
        return;
    }

    if (decision.reason === 'generation-active') {
        if (!pendingExtraction) {
            pendingExtraction = true;
            logActivity('Extraction deferred: primary LLM is generating — will run when it ends');
        }
        return;
    }

    if (decision.reason === 'cooldown') {
        const remainingMin = Math.ceil(decision.remainingMs / 60000);
        logActivity(`Extraction skipped: cooldown active (${remainingMin}m remaining)`, 'warning');
        return;
    }
    // reason === 'below-interval' — silent, this is the common case on every message
}
```

- [ ] **Step 3: Run the unit tests to confirm nothing else broke**

Run: `npm test`
Expected: all unit tests PASS (including the new `extraction-gate.test.js` from Task 1).

- [ ] **Step 4: Run snapshot tests**

Run: `npm run test:snapshot`
Expected: all PASS — the extraction pipeline itself didn't change, only the dispatch conditions.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(extraction): gate automatic extraction on generation state and apply lag"
```

---

### Task 5: Add the lag control to the Settings Modal

**Files:**
- Modify: `index.js` around line 3940 (the interval slider in `showSettingsModal()`)

- [ ] **Step 1: Locate the interval slider**

Run: `grep -n "cm_modal_interval" index.js`
Expected: multiple hits around `index.js:3940, 3943, 4420`.

- [ ] **Step 2: Add the lag slider right after the interval slider**

Find the HTML fragment for the interval slider (around `index.js:3938-3944`). It looks like:

```javascript
        <div class="charMemory_modalField">
            <label for="cm_modal_interval">${t`Extraction interval`}</label>
            <input class="neo-range-slider" type="range" id="cm_modal_interval" min="3" max="100" step="1" value="${s.interval}" />
            <input class="neo-range-input" type="number" min="3" max="100" step="1"
                   data-for="cm_modal_interval" id="cm_modal_intervalCounter" value="${s.interval}" />
        </div>
```

Immediately after this `</div>`, insert:

```javascript
        <div class="charMemory_modalField">
            <label for="cm_modal_extractionLag">${t`Extraction lag (messages)`}</label>
            <div class="charMemory_modalHint">${t`Wait this many additional messages past the interval before extracting. Useful for local LLMs — extraction then runs while you read, not while you wait for the next reply.`}</div>
            <input class="neo-range-slider" type="range" id="cm_modal_extractionLag" min="0" max="20" step="1" value="${s.extractionLag || 0}" />
            <input class="neo-range-input" type="number" min="0" max="20" step="1"
                   data-for="cm_modal_extractionLag" id="cm_modal_extractionLagCounter" value="${s.extractionLag || 0}" />
        </div>
```

- [ ] **Step 3: Wire up the slider handler**

Find the `sliderHandler('cm_modal_interval', ...)` call at `index.js:4420` and add, on the next line:

```javascript
    sliderHandler('cm_modal_extractionLag', 'cm_modal_extractionLagCounter', 'extractionLag', null, null);
```

(The two trailing `null`s mean "no sidebar element to mirror into" — the sidebar doesn't expose this setting.)

- [ ] **Step 4: Manual smoke-test the modal**

1. Open SillyTavern (`cd /Users/davidsayed/repos/SillyTavern && node server.js`), go to `http://127.0.0.1:8000`.
2. Open the Character Memory sidebar → Settings button → Extraction section.
3. Confirm the new "Extraction lag (messages)" field appears below "Extraction interval".
4. Drag the slider to 3 and close the modal. Re-open — value persisted.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(ui): expose extractionLag setting in Settings Modal"
```

---

### Task 6: Document the lag setting

**Files:**
- Modify: `README.md` (Extraction Tuning section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find the tuning section in the README**

Run: `grep -n "Extraction interval\|Chunk size\|Cooldown" README.md`
Expected: identifies the "Extraction Tuning" section where `interval`, `chunkSize`, and `cooldownMinutes` are documented.

- [ ] **Step 2: Add an entry for the new setting**

Add after the "Extraction interval" entry:

```markdown
- **Extraction lag** (default `0`): Extra messages to wait past the interval before extracting. Most useful on single-GPU local-inference setups where running extraction at the same time as the next reply creates a noticeable stall. A lag of `2` means extraction of message N runs only once message N+2 has been rendered, naturally interleaving with idle time. When the primary LLM is actively generating, extraction is automatically deferred until the generation ends — this happens regardless of the lag setting, but lag gives you extra margin.
```

- [ ] **Step 3: Add a CHANGELOG entry**

At the top of `CHANGELOG.md`, under a new unreleased-version heading, add bullets:

```markdown
### Added
- **Extraction lag setting**: configure how many messages past the interval before automatic extraction fires. Useful for single-GPU local-inference setups.
- **Generation-aware extraction**: automatic extraction now defers until the primary LLM finishes generating, then runs during the idle window before the user's next message. Prevents extraction and reply from contending for the same model.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document extractionLag setting and generation-aware deferral"
```

---

## Part B — Mobile UX Fixes

### Task 7: Prevent input auto-zoom on mobile

**Files:**
- Modify: `style.css` (append a media query at the end of the file)

- [ ] **Step 1: Identify the memory-editor input selectors**

Run: `grep -n "charMemory_editor\|cm_ts_fileEditor\|charMemory_memoryTextarea" style.css`
Expected: confirms the class names used for memory-editing textareas and inputs.

- [ ] **Step 2: Append mobile media query**

At the bottom of `style.css`, add:

```css
/* ===== Mobile fixes (issue #16) ===== */
@media (max-width: 768px) {
    /* Browsers (iOS/Android) auto-zoom on focus when font-size < 16px. Lock editor
       inputs to 16px so the viewport stays put when the user taps a memory to edit. */
    .charMemory_settings input[type="text"],
    .charMemory_settings input[type="number"],
    .charMemory_settings textarea,
    .charMemory_modal input[type="text"],
    .charMemory_modal input[type="number"],
    .charMemory_modal textarea,
    .charMemory_injectionDrawer input,
    .charMemory_injectionDrawer textarea,
    .charMemory_logDrawer input,
    .charMemory_logDrawer textarea,
    .charMemory_memoryEditor input,
    .charMemory_memoryEditor textarea {
        font-size: 16px;
    }

    /* Drawer close buttons: increase hit target and disable double-tap zoom delay. */
    .charMemory_drawerClose,
    .charMemory_modalClose {
        min-width: 44px;
        min-height: 44px;
        touch-action: manipulation;
    }

    /* Drawers should cover more of the viewport on narrow screens so the close
       button isn't pushed behind ST's own sidebar. */
    .charMemory_injectionDrawer,
    .charMemory_logDrawer {
        width: 90vw;
        max-width: 90vw;
        z-index: 1050; /* beat ST's sidebar which sits at 1000-1002 */
    }
}
```

- [ ] **Step 3: Smoke-test in Chrome device emulation**

1. Start SillyTavern.
2. Open DevTools → Toggle device toolbar → select **Pixel 7** (or any narrow device).
3. Open the Character Memory sidebar, open the Data Bank file editor.
4. Tap a memory bullet to edit. Confirm the viewport does NOT zoom when the textarea gains focus.
5. Open the Log Drawer, tap its X. Confirm the drawer closes cleanly and no stale ST sidebar stays open behind it.

- [ ] **Step 4: Commit**

```bash
git add style.css
git commit -m "fix(mobile): prevent input auto-zoom and fix drawer close hit targets on narrow viewports"
```

---

### Task 8: Recompute drawer geometry on viewport resize

**Files:**
- Modify: `index.js:8205-8231` (`toggleLogDrawer`)
- Modify: similar block for `toggleInjectionDrawer` — find via `grep -n "toggleInjectionDrawer\|charMemory_injectionDrawer'\).css" index.js`

- [ ] **Step 1: Extract the top-offset computation into a helper**

Near the other helper functions in `index.js`, add:

```javascript
/**
 * Compute a top offset that keeps a drawer below ST's top bar and track viewport
 * changes (pinch-zoom on mobile) so the offset stays correct.
 * @param {JQuery<HTMLElement>} $drawer - The drawer element.
 */
function positionDrawerBelowTopBar($drawer) {
    const apply = () => {
        const topBar = document.getElementById('top-settings-holder');
        const topOffset = topBar ? topBar.getBoundingClientRect().bottom : 0;
        $drawer.css({ top: topOffset + 'px', height: `calc(100vh - ${topOffset}px)` });
    };
    apply();

    // Re-apply on visualViewport resize (pinch-zoom, on-screen keyboard showing).
    // Guard against duplicate listeners — we only want one active per drawer.
    const key = `_charMemoryDrawerVvHandler_${$drawer.attr('id') || 'anon'}`;
    if (window.visualViewport && !window[key]) {
        window[key] = apply;
        window.visualViewport.addEventListener('resize', apply);
    }
}
```

- [ ] **Step 2: Use the helper in `toggleLogDrawer`**

In `index.js:8218-8223`, replace:

```javascript
    if (shouldOpen) {
        const topBar = document.getElementById('top-settings-holder');
        if (topBar) {
            const topOffset = topBar.getBoundingClientRect().bottom;
            $drawer.css({ top: topOffset + 'px', height: `calc(100vh - ${topOffset}px)` });
        }
```

with:

```javascript
    if (shouldOpen) {
        positionDrawerBelowTopBar($drawer);
```

- [ ] **Step 3: Find and update the injection drawer too**

Run: `grep -n "charMemory_injectionDrawer\|toggleInjectionDrawer" index.js | head -20`

Locate the corresponding `$drawer.css({ top:` block in the injection drawer's toggle function (the same pattern) and replace it with a call to `positionDrawerBelowTopBar($drawer)`.

- [ ] **Step 4: Default drawers closed on narrow viewports**

Find where `injectionDrawerOpen` is read at startup (`grep -n "injectionDrawerOpen" index.js`). Add a width guard before restoring the open state. For example, if the code is:

```javascript
    if (extension_settings[MODULE_NAME].injectionDrawerOpen) {
        toggleInjectionDrawer(true);
    }
```

Replace with:

```javascript
    const isNarrow = window.matchMedia('(max-width: 768px)').matches;
    if (extension_settings[MODULE_NAME].injectionDrawerOpen && !isNarrow) {
        toggleInjectionDrawer(true);
    }
```

- [ ] **Step 5: Smoke-test zoom behaviour**

1. Chrome DevTools → Pixel 7 emulation.
2. Open the Log Drawer.
3. Use DevTools' "Toggle throttling → Zoom out" OR pinch-zoom on a real Android device.
4. Confirm the drawer's X button remains tappable and visible.
5. Tap X — drawer closes cleanly.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "fix(mobile): recompute drawer geometry on visualViewport resize and default-close on narrow viewports"
```

---

### Task 9: Manual device-test checklist

**Files:**
- Modify: none (testing only)

- [ ] **Step 1: Real-device test on Android Chrome**

If a physical Android device is available (or ask the reporter on issue #16 to retest beta), perform:

1. Open SillyTavern in Chrome, navigate to a chat.
2. Open Character Memory sidebar.
3. Open the Settings Modal — all form fields usable, no auto-zoom on focus.
4. Open the Log Drawer — X button closes cleanly.
5. Open the Injection Viewer — X button closes cleanly.
6. Pinch-zoom out, then tap X — still closes.
7. Open Data Bank file editor, tap a memory bullet — no auto-zoom when focusing the textarea.
8. Report back via the GitHub issue with screenshots if any of the above still misbehave.

- [ ] **Step 2: Desktop regression check**

1. Firefox + Chrome on desktop, normal viewport.
2. Log Drawer, Injection Drawer, Settings Modal all open/close normally.
3. Confirm no visible style regressions — `@media (max-width: 768px)` should not fire on desktop.

- [ ] **Step 3: Log the test results**

Comment on the PR body or the issue with what was tested and on which devices. No code commit for this task.

---

## Part C — Ship It

### Task 10: Version bump and release

**Files:**
- Modify: `manifest.json` (bump `version`)
- Modify: `CHANGELOG.md` (finalize the heading)

- [ ] **Step 1: Bump version**

In `manifest.json`, bump `version` by patch or minor depending on semver preference. Since this adds a user-visible setting (`extractionLag`) and a behavior change (generation-gating), **minor bump** is appropriate: `2.1.10` → `2.2.0`.

- [ ] **Step 2: Finalize CHANGELOG heading**

Replace the working "unreleased" heading added in Task 6 with the versioned heading and today's date (use the current date from the terminal):

```markdown
## [2.2.0] - YYYY-MM-DD
```

- [ ] **Step 3: Verify the full test suite passes**

Run: `npm test && npm run test:snapshot`
Expected: all pass.

- [ ] **Step 4: Commit and tag**

```bash
git add manifest.json CHANGELOG.md
git commit -m "chore: release v2.2.0 — extraction lag + mobile UX fixes"
```

- [ ] **Step 5: Merge and respond to the issue**

Open a PR from `beta` → `master`, or direct-merge per project convention (see `CLAUDE.md` for repo-specific merge rules). Post a reply on issue #16 summarizing which items shipped, which were deferred (items 3 and 4), and ask the reporter to retest on Android.

---

## Self-Review Notes

**Spec coverage check (vs. issue #16):**
- Item 1 (message/time delay): covered by Tasks 1–6.
- Item 2 (manual `lastExtractedIndex`): **not in this plan** — deferred per the review discussion; will be a separate smaller PR.
- Item 3 (draggable memories): **not in this plan** — deferred; needs its own design doc.
- Item 4 (manual vectorize button): **declined** per reporter's acceptance.
- Item 5 (mobile UX): covered by Tasks 7–9.

**Scope boundary:** Items 2 and 3 are intentionally excluded from this plan. The reporter's highest priorities are 1 and 5, and bundling them gives a focused release.

**Risk callouts for the implementer:**
- Task 3's `GENERATION_ENDED` listener MUST clear `pendingExtraction` before calling `extractMemories`, otherwise a second deferred extraction could pile up mid-run.
- Task 7's `font-size: 16px` applies only ≤768px — desktop typography is untouched.
- Task 8's `visualViewport` is unsupported on some very old Android browsers; the `if (window.visualViewport)` guard makes this a progressive enhancement.
