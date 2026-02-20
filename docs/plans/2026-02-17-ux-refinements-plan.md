# Consolidation UX Refinements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine the consolidation dialog UX based on user testing feedback — read-only default with per-block edit, themed headers, editable presets with prompt viewer, and persistent activity log.

**Architecture:** The consolidation dialog gets a dual-mode card renderer (read-only/edit per block). The preset system changes from 3+Custom to 3 editable presets with expandable prompt disclosure. A persistent mini-log is added below the tab content area. All changes are in `index.js`, `settings.html`, and `style.css`.

**Tech Stack:** jQuery (ST convention), `callGenericPopup` for dialogs, existing `charMemory_card` CSS system.

**Design doc:** `docs/plans/2026-02-17-consolidation-ux-refinements-design.md`

---

### Task 1: Editable presets — remove Custom, add per-preset prompt storage

**Files:**
- Modify: `index.js:2448-2468` (CONSOLIDATION_PRESETS — remove `custom` entry)
- Modify: `index.js:2471-2494` (buildConsolidationPrompt — use saved prompt override)
- Modify: `index.js:297-304` (defaultSettings — replace `consolidationPrompt` with `consolidationPrompts`)
- Modify: `index.js:504-514` (updateConsolidationStrategyUI — rewrite for expandable prompt)

**Step 1: Update CONSOLIDATION_PRESETS**

Remove the `custom` entry. Keep only `conservative`, `balanced`, `aggressive`:

```javascript
const CONSOLIDATION_PRESETS = {
    conservative: {
        name: 'Conservative',
        description: 'Only merge near-exact duplicates. Preserves everything else.',
        prompt: `Merge ONLY near-exact duplicate memories. If two bullets say essentially the same thing, keep the more detailed version. Do NOT combine loosely related facts. Do NOT summarize. Preserve every distinct piece of information.`,
    },
    balanced: {
        name: 'Balanced',
        description: 'Merge duplicates and combine related facts.',
        prompt: `Merge duplicate or near-duplicate memories into one. Combine closely related facts about the same event or topic. Preserve all unique information — do NOT discard distinct memories. Summarize in third person.`,
    },
    aggressive: {
        name: 'Aggressive',
        description: 'Compress heavily. Summarize themes. Minimize bullet count.',
        prompt: `Aggressively consolidate these memories into the fewest possible entries. Group by theme or topic. Summarize rather than listing individual events. It's OK to lose minor details if the key facts are preserved. Aim for a compact overview.`,
    },
};
```

**Step 2: Update defaultSettings**

Replace `consolidationPrompt: ''` with `consolidationPrompts: {}`:

```javascript
const defaultSettings = {
    // ...existing fields...
    consolidationStrategy: 'balanced',
    consolidationPrompts: {},  // per-preset overrides: { conservative: '...', balanced: '...', aggressive: '...' }
    // ...rest...
};
```

**Step 3: Update buildConsolidationPrompt**

Change the prompt lookup to check for user overrides:

```javascript
function buildConsolidationPrompt(memoriesText) {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const userPrompt = overrides[strategy]
        || CONSOLIDATION_PRESETS[strategy]?.prompt
        || CONSOLIDATION_PRESETS.balanced.prompt;
    // ...rest of function unchanged...
}
```

**Step 4: Update updateConsolidationStrategyUI**

Rewrite to handle the expandable prompt viewer (replaces old custom textarea / preview logic):

```javascript
function updateConsolidationStrategyUI() {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const currentPrompt = overrides[strategy] || CONSOLIDATION_PRESETS[strategy]?.prompt || '';
    const isCustomized = !!overrides[strategy];

    // Update the prompt textarea value
    $('#charMemory_consolidationPrompt').val(currentPrompt);

    // Show/hide the restore default button
    $('#charMemory_restorePresetDefault').toggle(isCustomized);

    // Update preview text (shown when collapsed)
    const previewText = isCustomized ? `${CONSOLIDATION_PRESETS[strategy]?.name} (customized)` : CONSOLIDATION_PRESETS[strategy]?.description || '';
    $('#charMemory_consolidationPreview').text(previewText);
}
```

**Step 5: Commit**

```bash
git add index.js
git commit -m "refactor: replace Custom preset with per-preset editable prompts"
```

---

### Task 2: Consolidate tab HTML — expandable prompt viewer

**Files:**
- Modify: `settings.html:60-79` (Consolidate tab content)

**Step 1: Rewrite Consolidate tab HTML**

Replace lines 60-79 with:

```html
            <!-- Consolidate tab -->
            <div class="charMemory_tabContent" id="charMemory_tabConsolidate" style="display:none;">
                <div class="charMemory_promptSection">
                    <label for="charMemory_consolidationStrategy">
                        <small>Consolidation strategy</small>
                    </label>
                    <select id="charMemory_consolidationStrategy" class="text_pole">
                        <option value="conservative">Conservative — only merge near-exact duplicates</option>
                        <option value="balanced">Balanced — merge duplicates & related facts (default)</option>
                        <option value="aggressive">Aggressive — compress heavily, summarize themes</option>
                    </select>
                    <small id="charMemory_consolidationPreview" class="charMemory_helperText" style="font-style:italic;"></small>
                    <details class="charMemory_promptDisclosure" id="charMemory_promptDisclosure">
                        <summary><small>Show prompt</small></summary>
                        <textarea id="charMemory_consolidationPrompt" class="text_pole textarea_compact" rows="6" placeholder="Edit the consolidation prompt for this strategy..."></textarea>
                        <div class="charMemory_buttonRow">
                            <input type="button" id="charMemory_restorePresetDefault" class="menu_button" value="Restore Default" title="Reset this preset's prompt to its built-in default" style="display:none;" />
                        </div>
                    </details>
                </div>
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_consolidate" class="menu_button" value="Consolidate" title="Use the LLM to merge duplicate and related memories into fewer, cleaner entries" />
                    <input type="button" id="charMemory_undoConsolidate" class="menu_button" value="Undo Consolidation" title="Restore memories from before the last consolidation (session only)" disabled />
                </div>
            </div>
```

Key changes:
- Removed `custom` option from dropdown
- Replaced hidden textarea + preview with `<details>` disclosure containing the textarea
- Added "Restore Default" button inside the disclosure
- Preview text (collapsed summary) stays as a `<small>` above the disclosure

**Step 2: Add event listeners for prompt editing and restore**

In `setupListeners()`, add handlers for the prompt textarea and restore button:

```javascript
// Consolidation prompt editing — save override when user edits
$('#charMemory_consolidationPrompt').off('input').on('input', function () {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    if (!extension_settings[MODULE_NAME].consolidationPrompts) {
        extension_settings[MODULE_NAME].consolidationPrompts = {};
    }
    extension_settings[MODULE_NAME].consolidationPrompts[strategy] = $(this).val();
    $('#charMemory_restorePresetDefault').show();
    saveSettingsDebounced();
});

// Restore preset default
$('#charMemory_restorePresetDefault').off('click').on('click', function () {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    if (extension_settings[MODULE_NAME].consolidationPrompts) {
        delete extension_settings[MODULE_NAME].consolidationPrompts[strategy];
    }
    updateConsolidationStrategyUI();
    saveSettingsDebounced();
});
```

Also update the strategy dropdown handler to call `updateConsolidationStrategyUI()` (it likely already does — verify and ensure it doesn't reference the old `custom` logic).

**Step 3: Add CSS for the disclosure**

```css
.charMemory_promptDisclosure {
    margin-top: 4px;
}

.charMemory_promptDisclosure summary {
    cursor: pointer;
    opacity: 0.7;
}

.charMemory_promptDisclosure summary:hover {
    opacity: 1;
}

.charMemory_promptDisclosure textarea {
    margin-top: 4px;
}
```

**Step 4: Commit**

```bash
git add settings.html index.js style.css
git commit -m "feat: add expandable prompt viewer with per-preset editing"
```

---

### Task 3: Themed block headers — update prompt and parsing

**Files:**
- Modify: `index.js:2479-2494` (buildConsolidationPrompt — add theme instruction)
- Modify: `index.js:2540-2564` (runConsolidationLLM — parse chat field from LLM output)

**Step 1: Update consolidation prompt format rules**

In `buildConsolidationPrompt`, update the ADDITIONAL FORMAT RULES to instruct the LLM to use themed blocks:

```javascript
return `You are a memory consolidation assistant. Review the following character memories and consolidate them.

RULES:
${userPrompt}

ADDITIONAL FORMAT RULES:
1. Do NOT use emojis anywhere in the output.
2. Do NOT copy text verbatim from the input — rephrase in third person.
3. Group memories by theme. Each group is wrapped in <memory chat="Theme Name"></memory> tags where "Theme Name" is a short descriptive label (e.g. "Relationship History", "Character Background", "Key Events").
4. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").

MEMORIES TO CONSOLIDATE:
${memoriesText}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;
```

**Step 2: Update runConsolidationLLM parsing to extract chat attribute**

Currently (line 2549), the parsing uses a simple `<memory>` regex without attributes. Update it to extract the `chat` attribute:

```javascript
const consolidationRegex = /<memory(?:\s+chat="([^"]*)")?>([\s\S]*?)<\/memory>/gi;
const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
const rawEntries = consolidationMatches.length > 0
    ? consolidationMatches.map(m => ({ theme: m[1] || 'Consolidated', content: m[2].trim() })).filter(e => e.content)
    : [{ theme: 'Consolidated', content: cleanResult.trim() }].filter(e => e.content);

const consolidated = rawEntries.map((entry, i) => {
    const bullets = entry.content.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
        .map(l => l.slice(2).trim())
        .filter(Boolean);
    return { chat: entry.theme, date: timestamp, bullets: bullets.length > 0 ? bullets : [entry.content] };
});
```

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add themed block headers to consolidation output"
```

---

### Task 4: Read-only default with per-block edit toggle

**Files:**
- Modify: `index.js:2369-2390` (renderEditableCards → replace with renderConsolidatedCards dual-mode)
- Modify: `index.js:2392-2432` (buildConsolidationDialog — use new renderer, update headings)
- Modify: `index.js:2575-2760` (consolidateMemories — rewrite event delegation for edit mode)
- Modify: `style.css` (add edit mode toggle styles)

This is the largest task. The right pane cards need two modes: read-only (default) and edit (per-block toggle).

**Step 1: Replace renderEditableCards with renderConsolidatedCards**

This new function renders blocks that are read-only by default with a pencil icon per block. In `consolidateMemories()`, a Set tracks which block indices are in edit mode.

```javascript
function renderConsolidatedCards(blocks, editingSet) {
    return blocks.map((b, bi) => {
        const isEditing = editingSet.has(bi);
        const themeLabel = `${bi + 1}. ${b.chat}`;

        if (isEditing) {
            const bullets = b.bullets.map((bullet, bui) =>
                `<div class="charMemory_editorBulletRow" data-block="${bi}" data-bullet="${bui}">
                    <span class="charMemory_editorDash">-</span>
                    <input type="text" class="charMemory_editorBulletInput" value="${escapeHtml(bullet)}" data-block="${bi}" data-bullet="${bui}" />
                    <button class="charMemory_editorDeleteBullet menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete memory"><i class="fa-solid fa-trash fa-xs"></i></button>
                </div>`
            ).join('');
            return `<div class="charMemory_card charMemory_editorCard charMemory_editorCard--editing" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <input type="text" class="charMemory_editorThemeInput" value="${escapeHtml(b.chat)}" data-block="${bi}" />
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Done editing"><i class="fa-solid fa-check"></i></button>
                        <button class="charMemory_editorDeleteBlock menu_button menu_button_icon" data-block="${bi}" title="Delete block"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                <div class="charMemory_editorBullets">${bullets}</div>
                <button class="charMemory_editorAddBullet menu_button" data-block="${bi}"><i class="fa-solid fa-plus fa-xs"></i> Add memory</button>
            </div>`;
        } else {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card charMemory_editorCard" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <strong>${escapeHtml(themeLabel)}</strong>
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Edit block"><i class="fa-solid fa-pencil"></i></button>
                    </span>
                </div>
                <ul>${bullets}</ul>
            </div>`;
        }
    }).join('');
}
```

**Step 2: Update buildConsolidationDialog**

- Change headings to "Original Memories" and "Consolidated Memories"
- Pass `editingSet` (empty by default)
- Use `renderConsolidatedCards` for right pane
- Add Block button hidden by default (CSS class `charMemory_editorAddBlock--hidden`)

```javascript
function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedBlocks, editingSet) {
    const renderReadOnlyCards = (blocks) => {
        return blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${escapeHtml(b.chat)}</strong> <span class="charMemory_cardDate">${escapeHtml(b.date)}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
    };

    const afterCount = countMemories(consolidatedBlocks);
    const hasEditing = editingSet.size > 0;

    return `<div class="charMemory_consolidationDialog">
        <div class="charMemory_consolidationStats" id="charMemory_consolidationStats">
            Original: ${beforeCount} memories in ${beforeBlocks.length} blocks &rarr; Consolidated: <span id="charMemory_afterCount">${afterCount}</span> memories
        </div>
        <div class="charMemory_consolidationToolbar">
            <select id="charMemory_consolidationDialogStrategy" class="text_pole" style="max-width:200px;">
                ${Object.entries(CONSOLIDATION_PRESETS).map(([k, v]) =>
                    `<option value="${k}">${escapeHtml(v.name)}</option>`
                ).join('')}
            </select>
            <details class="charMemory_promptDisclosure charMemory_promptDisclosure--dialog">
                <summary><small>Show prompt</small></summary>
                <textarea id="charMemory_dialogPrompt" class="text_pole textarea_compact" rows="4" placeholder="Edit prompt for this strategy..."></textarea>
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_dialogRestoreDefault" class="menu_button" value="Restore Default" style="display:none;" />
                </div>
            </details>
            <input type="button" id="charMemory_rerunConsolidation" class="menu_button" value="Re-run" title="Send original memories to the LLM again with current strategy" />
            <input type="button" id="charMemory_undoRerun" class="menu_button" value="Undo" title="Revert to previous consolidated version" disabled />
            <span id="charMemory_rerunSpinner" style="display:none;">Working...</span>
        </div>
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4>Original Memories</h4>
                <div class="charMemory_consolidationContent">${renderReadOnlyCards(beforeBlocks)}</div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4>Consolidated Memories</h4>
                <div class="charMemory_consolidationContent" id="charMemory_editorPane">${renderConsolidatedCards(consolidatedBlocks, editingSet)}</div>
                <button class="charMemory_editorAddBlock menu_button ${hasEditing ? '' : 'charMemory_editorAddBlock--hidden'}" id="charMemory_editorAddBlock"><i class="fa-solid fa-plus fa-xs"></i> Add Block</button>
            </div>
        </div>
    </div>`;
}
```

**Step 3: Rewrite consolidateMemories event delegation**

Replace the edit-mode event handlers in `consolidateMemories()`. Key changes:

- Add `const editingSet = new Set();` alongside `editorBlocks` and `versionStack`
- `refreshEditor` now passes `editingSet` to `renderConsolidatedCards`
- Add toggle-edit handler for `.charMemory_editorToggleEdit`:

```javascript
// Toggle edit mode per block
$(document).off('click.charMemoryEditorToggle').on('click.charMemoryEditorToggle', '.charMemory_editorToggleEdit', function () {
    const bi = Number($(this).data('block'));
    if (editingSet.has(bi)) {
        editingSet.delete(bi);
    } else {
        editingSet.add(bi);
    }
    refreshEditor();
});
```

- Update `refreshEditor` to show/hide Add Block based on `editingSet.size > 0`:

```javascript
const refreshEditor = () => {
    $('#charMemory_editorPane').html(renderConsolidatedCards(editorBlocks, editingSet));
    $('#charMemory_afterCount').text(countMemories(editorBlocks));
    $('#charMemory_editorAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editingSet.size === 0);
};
```

- Add theme input sync handler:

```javascript
$(document).off('input.charMemoryEditorTheme').on('input.charMemoryEditorTheme', '.charMemory_editorThemeInput', function () {
    const bi = Number($(this).data('block'));
    if (editorBlocks[bi]) {
        editorBlocks[bi].chat = $(this).val();
    }
});
```

- Add dialog prompt handlers (for the expandable prompt in the toolbar):

```javascript
// Sync dialog prompt textarea to settings
$('#charMemory_dialogPrompt').off('input').on('input', function () {
    const strategy = $('#charMemory_consolidationDialogStrategy').val();
    if (!extension_settings[MODULE_NAME].consolidationPrompts) {
        extension_settings[MODULE_NAME].consolidationPrompts = {};
    }
    extension_settings[MODULE_NAME].consolidationPrompts[strategy] = $(this).val();
    $('#charMemory_dialogRestoreDefault').show();
    saveSettingsDebounced();
});

// Restore default in dialog
$('#charMemory_dialogRestoreDefault').off('click').on('click', function () {
    const strategy = $('#charMemory_consolidationDialogStrategy').val();
    if (extension_settings[MODULE_NAME].consolidationPrompts) {
        delete extension_settings[MODULE_NAME].consolidationPrompts[strategy];
    }
    const preset = CONSOLIDATION_PRESETS[strategy];
    $('#charMemory_dialogPrompt').val(preset?.prompt || '');
    $('#charMemory_dialogRestoreDefault').hide();
    saveSettingsDebounced();
});

// Update dialog prompt when strategy changes
$('#charMemory_consolidationDialogStrategy').off('change').on('change', function () {
    const strategy = $(this).val();
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const prompt = overrides[strategy] || CONSOLIDATION_PRESETS[strategy]?.prompt || '';
    const isCustomized = !!overrides[strategy];
    $('#charMemory_dialogPrompt').val(prompt);
    $('#charMemory_dialogRestoreDefault').toggle(isCustomized);
});
```

- Clean up the new namespaced events on popup close:

```javascript
$(document).off('click.charMemoryEditorToggle');
$(document).off('input.charMemoryEditorTheme');
```

- On re-run, clear `editingSet`:

```javascript
if (newResult) {
    versionStack.push(currentBlocks);
    $('#charMemory_undoRerun').prop('disabled', false);
    editorBlocks = parseMemories(newResult);
    editingSet.clear();
    refreshEditor();
}
```

- On undo, clear `editingSet`:

```javascript
$('#charMemory_undoRerun').off('click').on('click', () => {
    if (versionStack.length === 0) return;
    editorBlocks = versionStack.pop();
    editingSet.clear();
    refreshEditor();
    if (versionStack.length === 0) {
        $('#charMemory_undoRerun').prop('disabled', true);
    }
});
```

**Step 4: Add CSS**

```css
.charMemory_editorCard--editing {
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));
}

.charMemory_editorToggleEdit {
    opacity: 0.5;
}

.charMemory_editorToggleEdit:hover {
    opacity: 1;
}

.charMemory_editorThemeInput {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    font-weight: bold;
    font-size: 0.95em;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.05));
    color: var(--SmartThemeBodyColor);
    border: 1px solid transparent;
    border-radius: 4px;
}

.charMemory_editorThemeInput:focus {
    border-color: var(--SmartThemeBorderColor, rgba(255,255,255,0.2));
    outline: none;
}

.charMemory_editorAddBlock--hidden {
    display: none;
}
```

**Step 5: Remove old renderEditableCards function** (it's replaced by renderConsolidatedCards)

**Step 6: Commit**

```bash
git add index.js style.css
git commit -m "feat: read-only cards by default with per-block edit toggle and themed headers"
```

---

### Task 5: Persistent mini-log at panel bottom

**Files:**
- Modify: `settings.html:284-286` (add mini-log before closing divs)
- Modify: `index.js:64-90` (update logActivity / updateActivityLogDisplay to also update mini-log)
- Modify: `style.css` (add mini-log styles)

**Step 1: Add mini-log HTML to settings.html**

Insert before the closing `</div><!-- inline-drawer-content -->` (before line 286):

```html
            <!-- Persistent mini activity log — always visible -->
            <div class="charMemory_miniLog" id="charMemory_miniLog">
                <div class="charMemory_miniLogContent" id="charMemory_miniLogContent">
                    <div class="charMemory_diagEmpty charMemory_miniLogEmpty">No activity yet.</div>
                </div>
            </div>
```

**Step 2: Update logActivity to also populate mini-log**

In `updateActivityLogDisplay()`, after updating the main `#charMemory_activityLog`, also update the mini-log:

```javascript
function updateActivityLogDisplay() {
    // ... existing main log update code ...

    // Update mini-log (last 3 entries, non-verbose only)
    const $miniLog = $('#charMemory_miniLogContent');
    if (!$miniLog.length) return;

    if (activityLog.length === 0) {
        $miniLog.html('<div class="charMemory_diagEmpty charMemory_miniLogEmpty">No activity yet.</div>');
        return;
    }

    const miniEntries = activityLog.slice(0, 3);
    const miniHtml = miniEntries.map(entry => {
        const typeClass = `charMemory_log_${entry.type}`;
        const msgText = entry.message.split('\n')[0]; // first line only
        return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${escapeHtml(msgText)}</div>`;
    }).join('');
    $miniLog.html(miniHtml);
}
```

**Step 3: Add CSS for mini-log**

```css
.charMemory_miniLog {
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1));
    margin-top: 8px;
    padding-top: 4px;
    font-size: 0.8em;
    font-family: monospace;
    max-height: 60px;
    overflow-y: hidden;
    cursor: pointer;
    transition: max-height 0.2s ease;
}

.charMemory_miniLog:hover,
.charMemory_miniLog.charMemory_miniLog--expanded {
    max-height: 200px;
    overflow-y: auto;
}

.charMemory_miniLogEmpty {
    font-size: 0.9em;
    opacity: 0.5;
}
```

**Step 4: Add click-to-expand behavior**

In `setupListeners()`:

```javascript
$('#charMemory_miniLog').off('click').on('click', function () {
    $(this).toggleClass('charMemory_miniLog--expanded');
});
```

**Step 5: Commit**

```bash
git add settings.html index.js style.css
git commit -m "feat: add persistent mini activity log at panel bottom"
```

---

### Task 6: Final integration, cleanup, and changelog

**Files:**
- Modify: `index.js` (remove dead code, migrate old `consolidationPrompt` setting)
- Modify: `CHANGELOG.md`

**Step 1: Add settings migration**

In `loadSettings()`, migrate old `consolidationPrompt` field to new `consolidationPrompts`:

```javascript
// Migrate old consolidationPrompt to new per-preset system
if (extension_settings[MODULE_NAME].consolidationPrompt && !extension_settings[MODULE_NAME].consolidationPrompts) {
    const oldPrompt = extension_settings[MODULE_NAME].consolidationPrompt;
    const oldStrategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    extension_settings[MODULE_NAME].consolidationPrompts = { [oldStrategy]: oldPrompt };
    delete extension_settings[MODULE_NAME].consolidationPrompt;
    saveSettingsDebounced();
}
```

**Step 2: Remove dead code**

- Remove old `renderEditableCards` function if not already removed in Task 4
- Remove any remaining references to the `custom` preset
- Remove old `consolidationPrompt` from `defaultSettings`

**Step 3: Update CHANGELOG.md**

Add under `## 1.3.0 > ### Improvements`:

```markdown
- **Read-only consolidation preview**: Consolidated memories now display as clean read-only cards by default, matching the original memories pane. Click the pencil icon on any block to enter edit mode for that block.
- **Themed block headers**: The LLM now groups consolidated memories by theme (e.g., "Relationship History", "Key Events"). Theme names are editable.
- **Editable strategy presets**: Each consolidation strategy (Conservative, Balanced, Aggressive) now has an expandable prompt viewer. Customize any preset's prompt and save it — with Restore Default to revert.
- **Persistent activity log**: A compact activity log is always visible at the bottom of the panel, regardless of which tab is active. Click to expand.
```

**Step 4: Commit**

```bash
git add index.js CHANGELOG.md
git commit -m "feat: complete UX refinements — migration, cleanup, changelog"
```

---

## Task Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Editable presets — remove Custom, add per-preset storage | `index.js` |
| 2 | Consolidate tab HTML — expandable prompt viewer | `settings.html`, `index.js`, `style.css` |
| 3 | Themed block headers — update prompt and parsing | `index.js` |
| 4 | Read-only default with per-block edit toggle | `index.js`, `style.css` |
| 5 | Persistent mini-log at panel bottom | `settings.html`, `index.js`, `style.css` |
| 6 | Final integration, cleanup, changelog | `index.js`, `CHANGELOG.md` |
