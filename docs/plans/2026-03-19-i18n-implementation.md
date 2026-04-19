# i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internationalization support using SillyTavern's native i18n system so the extension's UI can be translated into any language ST supports.

**Architecture:** Use ST's two existing mechanisms — `data-i18n` HTML attributes (auto-translated by ST's MutationObserver) for static/dynamic HTML, and the `t` tagged template literal for JS runtime strings (toastr, `.text()`, popups). Register locale files via `manifest.json`'s `i18n` field. No custom i18n infrastructure. Create `locales/zh-tw.json` as the first translation, sourced from PR #12.

**Tech Stack:** SillyTavern i18n module (`scripts/i18n.js`), ES module imports, JSON locale files.

---

## Scoping Notes

- **`logActivity()` strings are excluded** — they're developer-facing (verbose mode off by default), high in count (73), and would bloat the locale file with low-value strings. Can be added later if users request it.
- **Pluralization** — English inline plural ternaries (`memor${n===1?'y':'ies'}`) are refactored to use two separate `t`-tagged strings, allowing each language to handle its plural forms independently.
- **`data-i18n` on dynamic HTML** — ST's MutationObserver auto-translates elements with `data-i18n` when they're added to the DOM, so modals built as HTML strings in JS get translated for free. This avoids wrapping every label with `t`. Additionally, `renderExtensionTemplateAsync()` (used to load `settings.html`) calls `applyLocale()` on the template HTML before inserting it into the DOM, so `settings.html` translations happen at load time (not just via the observer).
- **Static vs dynamic `<option>` elements** — Most `<select>` options in the Settings Modal are built dynamically in JS (e.g., provider list from `PROVIDER_PRESETS`, model dropdowns). `data-i18n` attributes must be added in the JS string that builds the `<option>`, not just in static HTML. The MutationObserver will translate them when the `<select>` is injected.
- **Testing** — Unit tests import from `lib.js` (pure functions, no i18n). Integration tests that touch `index.js` run in a browser context where ST's i18n module is loaded. No test changes needed for this feature. Verification is done by checking the extension loads without errors and toastr strings display correctly.

---

### Task 1: Infrastructure — manifest.json, import `t`, create locale scaffold

**Files:**
- Modify: `manifest.json`
- Modify: `index.js:1-54` (imports)
- Create: `locales/zh-tw.json` (empty scaffold)

- [ ] **Step 1: Add `i18n` field to manifest.json**

```json
{
    "display_name": "CharMemory",
    "loading_order": 100,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "bal-spec",
    "version": "2.1.9",
    "homePage": "",
    "auto_update": false,
    "i18n": {
        "zh-tw": "locales/zh-tw.json"
    }
}
```

ST's extension loader (`extensions.js:718`) reads this field, fetches the locale file for the user's active language, and calls `addLocaleData()` to merge it into the global locale data. This happens before the extension's JS runs.

- [ ] **Step 2: Import `t` in index.js**

Add to the existing imports at the top of `index.js` (after line 36, with the other ST imports):

```js
import { t } from '../../../i18n.js';
```

Note: The path is `../../../i18n.js` (3 levels up from `third-party/CharMemory/`), matching the pattern used by other imports like `from '../../../popup.js'`.

- [ ] **Step 3: Create empty locale scaffold**

Create `locales/zh-tw.json` with an empty object:

```json
{}
```

This will be populated in Task 5 after all translatable strings are instrumented.

- [ ] **Step 4: Verify extension loads without errors**

Start SillyTavern, open the browser console, verify:
- No import errors for `i18n.js`
- Extension loads and renders normally
- Console shows no warnings about locale loading

- [ ] **Step 5: Commit**

```bash
git add manifest.json index.js locales/zh-tw.json
git commit -m "feat(i18n): add infrastructure — manifest i18n field, import t, locale scaffold"
```

---

### Task 2: `settings.html` — add `data-i18n` attributes to static HTML

**Files:**
- Modify: `settings.html`

All 35 user-facing strings in `settings.html` need `data-i18n` attributes. The MutationObserver handles translation automatically — no JS changes needed.

**`data-i18n` syntax reference:**
- Text content: `data-i18n="English text"` — replaces `element.textContent`
- Attribute: `data-i18n="[attr]English text"` — replaces `element.getAttribute(attr)`
- Multiple: `data-i18n="[value]Text;[title]Other text"` — semicolon-delimited

- [ ] **Step 1: Add `data-i18n` to header icons (tooltips)**

```html
<span id="charMemory_openWizard" class="charMemory_headerGear" title="Setup Wizard" data-i18n="[title]Setup Wizard">
<span id="charMemory_openTroubleshooter" class="charMemory_headerGear" title="Troubleshooter" data-i18n="[title]Troubleshooter">
<span id="charMemory_openSettingsModal" class="charMemory_headerGear" title="Open Settings" data-i18n="[title]Open Settings">
<span id="charMemory_toggleInjectionBtn" class="charMemory_headerGear" title="Toggle Injection Viewer" data-i18n="[title]Toggle Injection Viewer">
```

- [ ] **Step 2: Add `data-i18n` to nudge banner**

```html
<span data-i18n="Something needs attention">Something needs attention</span>
<input type="button" id="charMemory_nudgeFix" class="menu_button" value="View" data-i18n="[value]View" />
```

- [ ] **Step 3: Add `data-i18n` to stats bar items (tooltips + default text)**

```html
<div class="charMemory_statItem" title="The Data Bank file where memories are stored for this character" data-i18n="[title]The Data Bank file where memories are stored for this character">
    <span id="charMemory_statFile" data-i18n="No character">No character</span>
</div>
<div class="charMemory_statItem" title="Total number of individual memory bullets stored" data-i18n="[title]Total number of individual memory bullets stored">
    <span id="charMemory_statCount">0 memories</span>
</div>
<div class="charMemory_statItem" title="New messages since last extraction / auto-extraction threshold" data-i18n="[title]New messages since last extraction / auto-extraction threshold">
</div>
<div class="charMemory_statItem" title="Time remaining before the next auto-extraction is allowed" data-i18n="[title]Time remaining before the next auto-extraction is allowed">
    <span id="charMemory_statCooldown" data-i18n="Ready">Ready</span>
</div>
<div class="charMemory_statItem charMemory_statHealth" id="charMemory_statHealth"
     title="Injection health — click for details" data-i18n="[title]Injection health — click for details">
</div>
```

Note: `charMemory_statCount` and `charMemory_statProgress` are NOT given `data-i18n` because their text is set dynamically in JS (Task 3 handles those). `charMemory_statFile` default text "No character" IS set here since it's the initial value; JS will override it with character names at runtime.

- [ ] **Step 4: Add `data-i18n` to primary controls**

```html
<input type="button" id="charMemory_extractNow" class="menu_button" value="Extract Now"
       title="Extract memories from unprocessed messages. If all messages have been processed, use 'Reset Extraction State' first to re-read from the beginning."
       data-i18n="[value]Extract Now;[title]Extract memories from unprocessed messages. If all messages have been processed, use 'Reset Extraction State' first to re-read from the beginning." />

<button id="charMemory_autoExtractPill" class="charMemory_autoPill"
        title="Toggle automatic extraction — when on, memories are extracted automatically after a set number of new messages"
        data-i18n="[title]Toggle automatic extraction — when on, memories are extracted automatically after a set number of new messages">
    <i class="fa-solid fa-arrows-rotate fa-xs"></i> <span data-i18n="Auto">Auto</span>
</button>

<input type="button" id="charMemory_manageMemories" class="menu_button" value="View / Edit"
       title="Browse, edit, and delete individual stored memories"
       data-i18n="[value]View / Edit;[title]Browse, edit, and delete individual stored memories" />
```

Note: The "Auto" text inside the pill button needs its own `<span>` wrapper with `data-i18n` since the button also contains an `<i>` icon element. `data-i18n` replaces `textContent`, which would wipe out the icon if applied to the button itself.

- [ ] **Step 5: Add `data-i18n` to tool launcher section**

```html
<small class="charMemory_sectionLabel" data-i18n="Data Bank Tools">Data Bank Tools</small>

<input type="button" id="charMemory_filesPopover" class="menu_button" value="Data Bank"
       title="Browse and manage Data Bank files for this character"
       data-i18n="[value]Data Bank;[title]Browse and manage Data Bank files for this character" />

<input type="button" id="charMemory_consolidateBtn" class="menu_button" value="Consolidate"
       title="Use the LLM to merge duplicate and related memories"
       data-i18n="[value]Consolidate;[title]Use the LLM to merge duplicate and related memories" />

<input type="button" id="charMemory_batchBtn" class="menu_button" value="Batch"
       title="Run extraction on multiple chats at once"
       data-i18n="[value]Batch;[title]Run extraction on multiple chats at once" />

<input type="button" id="charMemory_formatBtn" class="menu_button" value="Reformat"
       title="Reformat memory file structure for better retrieval"
       data-i18n="[value]Reformat;[title]Reformat memory file structure for better retrieval" />
```

- [ ] **Step 6: Add `data-i18n` to activity and diagnostics sections**

```html
<small class="charMemory_sectionLabel" data-i18n="Activity">Activity</small>
<div class="charMemory_diagEmpty charMemory_miniLogEmpty" data-i18n="No activity yet.">No activity yet.</div>
<a id="charMemory_viewFullLog" class="charMemory_link" data-i18n="View full log →">View full log &rarr;</a>

<small class="charMemory_sectionLabel" data-i18n="Diagnostics">Diagnostics</small>
<div class="charMemory_diagEmpty" data-i18n="No diagnostics yet.">No diagnostics yet.</div>
<a id="charMemory_viewDiagDetails" class="charMemory_link" data-i18n="View details →">View details &rarr;</a>
```

Note on arrow entities: The `data-i18n` key should use the literal `→` character (not `&rarr;`), because `data-i18n` keys are matched against the locale JSON which uses plain text. The HTML entity in the element's content is fine — ST's MutationObserver replaces `textContent`, which doesn't interpret entities anyway.

- [ ] **Step 7: Verify in browser**

Open SillyTavern, open the extension panel. All text should render identically to before (English fallback). Check the console for no i18n-related warnings.

- [ ] **Step 8: Commit**

```bash
git add settings.html
git commit -m "feat(i18n): add data-i18n attributes to settings.html"
```

---

### Task 3: `index.js` — wrap toastr and popup strings with `t` tag

**Files:**
- Modify: `index.js` (throughout — 84 toastr calls, ~7 simple popup text strings)

This is the largest task. Wrap all user-facing runtime strings with the `t` tagged template literal. The `t` tag works as a drop-in replacement for template literals — it uses the string (with `${n}` indexed placeholders) as a lookup key in the locale data, falling back to the original English string if no translation is found.

**Rules for wrapping:**
1. Simple string arguments: `'text'` → `` t`text` ``
2. Template literals: `` `text ${var}` `` → `` t`text ${var}` `` (no change to interpolations — `t` handles them)
3. Strings with HTML (e.g., `<b>`): wrap the whole thing with `t` — translators can rearrange HTML
4. **Do NOT wrap** the second argument to toastr (always `'CharMemory'` — this is the toast title/category, not user-facing text that needs translation)
5. **Do NOT wrap** `logActivity()` strings (excluded from scope — developer-facing)
6. **Do NOT wrap** `console.log/warn/error` strings (developer-facing)

**Pluralization refactoring:**
Anywhere the code uses inline English plurals like:
```js
`${n} memor${n === 1 ? 'y' : 'ies'}`
```
Refactor to:
```js
n === 1 ? t`${n} memory` : t`${n} memories`
```
This creates two separate locale keys (`"${0} memory"` and `"${0} memories"`) that each language can translate independently.

- [ ] **Step 1: Wrap toastr calls in extraction pipeline (lines ~2700-3100)**

These are the most visible strings — shown during the core extraction flow. Find all `toastr.*()` calls in the `extractMemories()` function and its helpers. Examples:

```js
// Before
toastr.info('No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.', 'CharMemory', { timeOut: 5000 });
// After
toastr.info(t`No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.`, 'CharMemory', { timeOut: 5000 });

// Before
toastr.warning(`Extraction stopped after ${chunksProcessed} of ${totalChunks} chunks.`, 'CharMemory');
// After
toastr.warning(t`Extraction stopped after ${chunksProcessed} of ${totalChunks} chunks.`, 'CharMemory');
```

- [ ] **Step 2: Wrap toastr calls in conversion/reformat flow (lines ~630-1060)**

All `toastr.*()` calls in `previewConversion()`, `buildConversionDialog()`, `offerReformat()`, and related functions.

- [ ] **Step 3: Wrap toastr calls in consolidation flow (lines ~6100-6800)**

All `toastr.*()` calls in `consolidateMemories()`, `buildConsolidationDialog()`, and `undoConsolidation()`.

- [ ] **Step 4: Wrap toastr calls in Memory Manager / Data Bank editor (lines ~7000-7600)**

All `toastr.*()` calls in `showMemoryManager()`, Data Bank file browser, and save/delete operations.

- [ ] **Step 5: Wrap toastr calls in settings, wizard, troubleshooter, batch, and remaining functions**

Catch all remaining `toastr.*()` calls across the file — connection testing, wizard steps, batch extraction, health checks, provider setup, etc.

- [ ] **Step 6: Wrap simple popup text strings**

Find `callGenericPopup()` calls that pass short plain-text strings (not large HTML blocks) and wrap them:

```js
// Before
callGenericPopup('No character selected.', POPUP_TYPE.TEXT);
// After
callGenericPopup(t`No character selected.`, POPUP_TYPE.TEXT);
```

Do NOT wrap the large HTML template strings passed to `callGenericPopup()` — those are handled in Task 4 via `data-i18n` attributes.

Also wrap `okButton` / `cancelButton` option strings:

```js
// Before
{ okButton: 'Save', cancelButton: 'Cancel' }
// After
{ okButton: t`Save`, cancelButton: t`Cancel` }
```

- [ ] **Step 7: Wrap status bar dynamic text**

Find all `.text()` calls that set status bar content and wrap with `t`:

```js
// Before
$('#charMemory_statFile').text('No character').attr('title', 'No character selected');
// After
$('#charMemory_statFile').text(t`No character`).attr('title', t`No character selected`);

// Pluralized status
// Before
$('#charMemory_statCount').text(`${n} memor${n === 1 ? 'y' : 'ies'}`);
// After
$('#charMemory_statCount').text(n === 1 ? t`${n} memory` : t`${n} memories`);
```

- [ ] **Step 8: Wrap health indicator labels**

```js
// Before
$('#charMemory_healthLabel').text('Healthy');
// After
$('#charMemory_healthLabel').text(t`Healthy`);
```

Do this for all health status labels: `'Healthy'`, `'Warnings'`, `'Issues'`, `'—'`.

- [ ] **Step 9: Wrap health check labels and detail strings**

In `computeHealthScore()`, the check objects have `label` and `detail` string properties that are rendered as text content. These are JS object properties (not HTML), so wrap with `t`:

```js
// Before
label: 'Vector Storage for files',
detail: 'Vector Storage is not enabled for file attachments.',
// After
label: t`Vector Storage for files`,
detail: t`Vector Storage is not enabled for file attachments.`,
```

This applies to all ~10 check labels and ~40 detail strings in the health check system. Also wrap the fix hint strings and overall status labels (`'All checks passed'`, `'Warnings detected'`, `'Issues found'`, `'No character selected.'`).

- [ ] **Step 10: Verify — search for remaining unwrapped user-facing strings**

Run a grep to check for any `toastr.` calls that don't use `t`:

```bash
grep -En "toastr\.(success|error|warning|info)\('" index.js
```

If this returns results, those are single-quoted string arguments that were missed. All toastr calls should now use `` t`...` `` (backtick template literals).

- [ ] **Step 11: Commit**

```bash
git add index.js
git commit -m "feat(i18n): wrap toastr, popup, status, and health check strings with t tag"
```

---

### Task 4: `index.js` — add `data-i18n` to dynamically built modal HTML

**Files:**
- Modify: `index.js` (modal builder functions)

For labels, headings, and button text in dynamically built HTML strings, add `data-i18n` attributes. ST's MutationObserver translates them when the HTML is injected into the DOM.

**Important:** Only add `data-i18n` to elements with **static text**. Elements whose text is set dynamically via JS (like stats counters) should NOT get `data-i18n` — those were handled in Task 3 via `t`.

**Priority targets** (highest visibility):

- [ ] **Step 1: Settings Modal nav tabs and section headings**

In `showSettingsModal()`, find the nav tabs and add `data-i18n`:

```html
<button class="cm_modal_navBtn" data-section="connection" data-i18n="Connection">Connection</button>
<button class="cm_modal_navBtn" data-section="extraction" data-i18n="Extraction">Extraction</button>
<button class="cm_modal_navBtn" data-section="storage" data-i18n="Storage">Storage</button>
<button class="cm_modal_navBtn" data-section="advanced" data-i18n="Advanced">Advanced</button>
```

And section headings:

```html
<h3 data-i18n="LLM Connection">LLM Connection</h3>
```

- [ ] **Step 2: Settings Modal field labels and helper text**

For form labels, placeholders, and helper text in the Settings Modal. Example patterns:

```html
<label data-i18n="Extraction source">Extraction source</label>
<small class="cm_modal_help" data-i18n="Which LLM to use for memory extraction">Which LLM to use for memory extraction</small>
<option value="provider" data-i18n="Dedicated API (recommended)">Dedicated API (recommended)</option>
<input placeholder="Enter API key" data-i18n="[placeholder]Enter API key" />
```

- [ ] **Step 3: Settings Modal button values**

```html
<input type="button" value="Test Connection" data-i18n="[value]Test Connection" />
<input type="button" value="Reset This Chat" data-i18n="[value]Reset This Chat" />
<input type="button" value="Clear All Memories" data-i18n="[value]Clear All Memories" />
```

- [ ] **Step 4: Troubleshooter Modal nav and headings**

In `showTroubleshooter()`:

```html
<button class="cm_ts_navBtn" data-section="health" data-i18n="Health Checks">Health Checks</button>
<button class="cm_ts_navBtn" data-section="databank" data-i18n="Data Bank">Data Bank</button>
<button class="cm_ts_navBtn" data-section="report" data-i18n="Diagnostic Report">Diagnostic Report</button>
<button class="cm_ts_navBtn" data-section="reset" data-i18n="Reset / Clear">Reset / Clear</button>
```

- [ ] **Step 5: Setup Wizard headings and button labels**

In `showSetupWizard()`, add `data-i18n` to step titles, explanatory text paragraphs, and button labels:

```html
<h3 data-i18n="LLM Connection">LLM Connection</h3>
<input type="button" value="Connect & Test" data-i18n="[value]Connect & Test" />
<input type="button" value="Next →" data-i18n="[value]Next →" />
```

- [ ] **Step 6: Prompts Modal nav and buttons**

In `showPromptsModal()`:

```html
<button class="cm_prompt_navBtn" data-i18n="Extraction">Extraction</button>
<input type="button" value="Restore Default" data-i18n="[value]Restore Default" />
<input type="button" value="Save" data-i18n="[value]Save" />
```

- [ ] **Step 7: Consolidation and conversion dialog labels**

In `buildConsolidationDialog()` and `buildConversionDialog()`:

```html
<span data-i18n="Original Memories">Original Memories</span>
<span data-i18n="Consolidated Memories">Consolidated Memories</span>
<input type="button" value="Re-run" data-i18n="[value]Re-run" />
```

- [ ] **Step 8: Find & Replace bar**

In `buildFindReplaceBar()`:

```html
<input placeholder="Find..." data-i18n="[placeholder]Find..." />
<input placeholder="Replace with..." data-i18n="[placeholder]Replace with..." />
<input type="button" value="Replace All" data-i18n="[value]Replace All" />
```

- [ ] **Step 9: Verify in browser — open each modal and check rendering**

Open Settings Modal, Troubleshooter, Wizard, Prompts Modal, Consolidation, Memory Manager. Verify all text renders correctly in English (fallback behavior).

- [ ] **Step 10: Commit**

```bash
git add index.js
git commit -m "feat(i18n): add data-i18n to modal HTML"
```

---

### Task 5: `editor.js` — wrap the single user-facing string

**Files:**
- Modify: `editor.js`

- [ ] **Step 1: Import `t` and wrap the string**

```js
import { cloneMemoryBlocks, countMatchesInBlocks, getTimestamp, reindexEditingSet, replaceInBlocks } from './lib.js';
import { t } from '../../../i18n.js';
```

```js
// Before (line 52)
chat: 'New Group',
// After
chat: t`New Group`,
```

- [ ] **Step 2: Commit**

```bash
git add editor.js
git commit -m "feat(i18n): wrap editor.js string with t tag"
```

---

### Task 6: Create `locales/zh-tw.json` from PR #12 translations

**Files:**
- Modify: `locales/zh-tw.json`

- [ ] **Step 1: Extract translation pairs from PR #12 diff**

PR #12: https://github.com/bal-spec/sillytavern-character-memory/pull/12

Use the PR diff (`gh pr diff 12`) to build the locale file. The diff shows English → Chinese string replacements. Convert each pair into a JSON key-value entry.

The PR author (Minijinai75) translated ~300 strings. Extract these into the JSON format:

```json
{
    "No character selected.": "未選擇角色。",
    "Extract Now": "立即提取",
    "Saved ${0} memories.": "已儲存 ${0} 條記憶。",
    ...
}
```

**Key conversion rules:**
- The JSON key is the English string as it appears in code (after `t` wrapping)
- Template literal interpolations become `${0}`, `${1}`, etc. in order
- `data-i18n` keys use the English text exactly as written in the attribute
- Do NOT include `logActivity` strings (excluded from scope)

- [ ] **Step 2: Verify key coverage**

After creating the file, verify that the keys match the strings instrumented in Tasks 2-5. Any keys in the JSON that don't match an instrumented string are useless; any instrumented strings without a JSON key will fall back to English.

A quick check: the number of keys in `zh-tw.json` should roughly match the number of `data-i18n` attributes plus `t` tag usages.

- [ ] **Step 3: Commit**

```bash
git add locales/zh-tw.json
git commit -m "feat(i18n): add Traditional Chinese (zh-tw) locale from PR #12"
```

---

### Task 7: Verification and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run unit tests**

```bash
npm test
```

Expected: All 97 tests pass. Unit tests only cover `lib.js` pure functions, which are not touched by i18n changes.

- [ ] **Step 2: Run snapshot tests**

```bash
npm run test:snapshot
```

Expected: All 6 tests pass. Snapshots test the extraction pipeline's output format, which is not affected by i18n.

- [ ] **Step 3: Browser verification — English (default)**

1. Start SillyTavern
2. Open CharMemory extension panel
3. Open Settings Modal, Troubleshooter, Wizard, Prompts Modal
4. Trigger an extraction and verify toastr messages display correctly
5. Check browser console for no import errors or i18n warnings

- [ ] **Step 4: Browser verification — zh-tw locale**

1. In SillyTavern, change UI language to 繁體中文 (Traditional Chinese)
2. Reload the page
3. Verify:
   - Sidebar labels (Extract Now, Consolidate, etc.) are in Chinese
   - Toastr messages appear in Chinese
   - Settings Modal labels are in Chinese
   - Any untranslated strings fall back gracefully to English

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "fix(i18n): cleanup from verification pass"
```
