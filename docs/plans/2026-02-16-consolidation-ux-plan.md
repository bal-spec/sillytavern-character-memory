# Consolidation UX Improvement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make memory consolidation interactive with strategy presets, editable preview, and re-run/undo within the dialog.

**Architecture:** Replaces the hardcoded `consolidationPrompt` constant with a preset system (`CONSOLIDATION_PRESETS`) and two new settings fields. Replaces the read-only `buildConsolidationPreview()` popup with an interactive dialog built as raw HTML (using `callGenericPopup` with `POPUP_TYPE.TEXT`). The dialog manages its own version stack and re-run logic internally.

**Tech Stack:** jQuery (ST convention), `callGenericPopup` for dialogs, `callLLM` for re-runs.

**Design doc:** `docs/plans/2026-02-16-consolidation-ux-design.md`

---

### Task 1: Add Consolidation Presets and Settings

**Files:**
- Modify: `index.js:2378-2392` (replace `consolidationPrompt` constant)
- Modify: `index.js:297-318` (add to `defaultSettings`)

**Step 1: Add the `CONSOLIDATION_PRESETS` object**

At `index.js` around line 2378, replace the `consolidationPrompt` constant with:

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
    custom: {
        name: 'Custom',
        description: 'Write your own consolidation prompt.',
        prompt: '',
    },
};

function buildConsolidationPrompt(memoriesText) {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    let userPrompt;
    if (strategy === 'custom') {
        userPrompt = extension_settings[MODULE_NAME].consolidationPrompt || CONSOLIDATION_PRESETS.balanced.prompt;
    } else {
        userPrompt = CONSOLIDATION_PRESETS[strategy]?.prompt || CONSOLIDATION_PRESETS.balanced.prompt;
    }
    return `You are a memory consolidation assistant. Review the following character memories and consolidate them.

RULES:
${userPrompt}

ADDITIONAL FORMAT RULES:
1. Do NOT use emojis anywhere in the output.
2. Each consolidated memory must be wrapped in <memory></memory> tags.
3. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").

MEMORIES TO CONSOLIDATE:
${memoriesText}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;
}
```

**Step 2: Add new fields to `defaultSettings`**

In the `defaultSettings` object (~line 297), add two new fields:

```javascript
consolidationStrategy: 'balanced',
consolidationPrompt: '',
```

Add these after the `extractionPrompt` field (line 302).

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add consolidation strategy presets and buildConsolidationPrompt"
```

---

### Task 2: Add Consolidation Settings UI

**Files:**
- Modify: `settings.html:194-203` (add consolidation section after extraction prompt section)
- Modify: `index.js` (add UI initialization and event listeners)

**Step 1: Add HTML for consolidation strategy section**

In `settings.html`, after the extraction prompt section (after line 203, before the next `<hr>`), add:

```html
<hr class="charMemory_separator" />

<div class="charMemory_promptSection">
    <label for="charMemory_consolidationStrategy">
        <small>Consolidation strategy</small>
    </label>
    <select id="charMemory_consolidationStrategy" class="text_pole">
        <option value="conservative">Conservative — only merge near-exact duplicates</option>
        <option value="balanced">Balanced — merge duplicates & related facts (default)</option>
        <option value="aggressive">Aggressive — compress heavily, summarize themes</option>
        <option value="custom">Custom prompt</option>
    </select>
    <textarea id="charMemory_consolidationPrompt" class="text_pole textarea_compact" rows="6" placeholder="Enter custom consolidation prompt..." style="display:none;"></textarea>
    <small id="charMemory_consolidationPreview" class="charMemory_helperText" style="font-style:italic;"></small>
</div>
```

**Step 2: Initialize UI values in `loadSettings()`**

In the `loadSettings()` function (around line 743 where other UI values are set), add:

```javascript
$('#charMemory_consolidationStrategy').val(extension_settings[MODULE_NAME].consolidationStrategy || 'balanced');
updateConsolidationStrategyUI();
```

**Step 3: Add `updateConsolidationStrategyUI()` helper**

Add this helper function near the other UI helpers:

```javascript
function updateConsolidationStrategyUI() {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    if (strategy === 'custom') {
        $('#charMemory_consolidationPrompt').show().val(extension_settings[MODULE_NAME].consolidationPrompt || '');
        $('#charMemory_consolidationPreview').hide();
    } else {
        $('#charMemory_consolidationPrompt').hide();
        const preset = CONSOLIDATION_PRESETS[strategy];
        $('#charMemory_consolidationPreview').show().text(preset ? preset.prompt : '');
    }
}
```

**Step 4: Add event listeners in `setupListeners()`**

In `setupListeners()` (after the extraction prompt listeners around line 2718), add:

```javascript
$('#charMemory_consolidationStrategy').off('change').on('change', function () {
    extension_settings[MODULE_NAME].consolidationStrategy = String($(this).val());
    updateConsolidationStrategyUI();
    saveSettingsDebounced();
});

$('#charMemory_consolidationPrompt').off('input').on('input', function () {
    extension_settings[MODULE_NAME].consolidationPrompt = String($(this).val());
    saveSettingsDebounced();
});
```

**Step 5: Commit**

```bash
git add index.js settings.html
git commit -m "feat: add consolidation strategy UI with presets and custom prompt"
```

---

### Task 3: Build the Interactive Consolidation Dialog

**Files:**
- Modify: `index.js:2347-2362` (replace `buildConsolidationPreview`)
- Modify: `style.css` (add styles for the new dialog)

**Step 1: Replace `buildConsolidationPreview` with interactive dialog builder**

Replace the `buildConsolidationPreview` function (lines 2347-2362) with:

```javascript
function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedText) {
    const renderBefore = (blocks) => {
        return blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${escapeHtml(b.chat)}</strong> <span class="charMemory_cardDate">${escapeHtml(b.date)}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
    };

    const afterCount = countConsolidatedText(consolidatedText);

    return `<div class="charMemory_consolidationDialog">
        <div class="charMemory_consolidationStats" id="charMemory_consolidationStats">
            Original: ${beforeCount} memories in ${beforeBlocks.length} blocks → Consolidated: <span id="charMemory_afterCount">${afterCount}</span> memories
        </div>
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4>Original</h4>
                <div class="charMemory_consolidationContent">${renderBefore(beforeBlocks)}</div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4>Consolidated <small>(editable)</small></h4>
                <textarea id="charMemory_consolidationEditor" class="charMemory_consolidationEditor">${escapeHtml(consolidatedText)}</textarea>
            </div>
        </div>
        <div class="charMemory_consolidationToolbar">
            <select id="charMemory_consolidationDialogStrategy" class="text_pole" style="max-width:200px;">
                ${Object.entries(CONSOLIDATION_PRESETS).filter(([k]) => k !== 'custom').map(([k, v]) =>
                    `<option value="${k}">${escapeHtml(v.name)}</option>`
                ).join('')}
                <option value="custom">Custom</option>
            </select>
            <input type="button" id="charMemory_rerunConsolidation" class="menu_button" value="Re-run" title="Send original memories to the LLM again with current strategy" />
            <input type="button" id="charMemory_undoRerun" class="menu_button" value="Undo" title="Revert to previous consolidated version" disabled />
            <span id="charMemory_rerunSpinner" style="display:none;">Working...</span>
        </div>
    </div>`;
}

function countConsolidatedText(text) {
    const lines = text.split('\n').filter(l => l.trim().startsWith('- '));
    return lines.length;
}
```

**Step 2: Add CSS for the consolidation dialog**

In `style.css`, add:

```css
.charMemory_consolidationDialog {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.charMemory_consolidationStats {
    font-size: 0.9em;
    padding: 6px 10px;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
}

.charMemory_consolidationPanes {
    display: flex;
    gap: 12px;
}

.charMemory_consolidationPane {
    flex: 1;
    min-width: 0;
}

.charMemory_consolidationPane h4 {
    margin: 0 0 6px 0;
}

.charMemory_consolidationContent {
    max-height: 50vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.charMemory_consolidationEditor {
    width: 100%;
    height: 50vh;
    resize: vertical;
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    border-radius: 6px;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.05));
    color: var(--SmartThemeBodyColor);
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1));
}

.charMemory_consolidationToolbar {
    display: flex;
    gap: 6px;
    align-items: center;
    padding-top: 6px;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1));
}
```

**Step 3: Commit**

```bash
git add index.js style.css
git commit -m "feat: add interactive consolidation dialog with editable textarea"
```

---

### Task 4: Rewrite `consolidateMemories()` to Use Interactive Dialog

**Files:**
- Modify: `index.js:2394-2499` (rewrite `consolidateMemories()`)

**Step 1: Rewrite `consolidateMemories()`**

Replace the entire function with:

```javascript
async function consolidateMemories() {
    if (inApiCall) {
        toastr.warning('An API call is already in progress.', 'CharMemory');
        return;
    }

    const content = await readMemories();
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info('Not enough memories to consolidate.', 'CharMemory');
        return;
    }

    const beforeCount = countMemories(memories);
    logActivity(`Consolidation started: ${beforeCount} memories in ${memories.length} blocks`);

    // Run initial consolidation
    const initialResult = await runConsolidationLLM(memories);
    if (!initialResult) return;

    // Build and show the interactive dialog
    const dialogHtml = buildConsolidationDialog(memories, beforeCount, initialResult);
    const versionStack = [];

    // Use TEXT popup so we control accept/cancel via our own logic
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true });

    // Set up the strategy dropdown to match current setting
    const currentStrategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    $('#charMemory_consolidationDialogStrategy').val(currentStrategy);

    // Wire up re-run button
    $('#charMemory_rerunConsolidation').off('click').on('click', async () => {
        if (inApiCall) return;

        // Push current editor content to version stack
        const currentText = $('#charMemory_consolidationEditor').val();
        versionStack.push(currentText);
        $('#charMemory_undoRerun').prop('disabled', false);

        // Update strategy from dialog dropdown
        const dialogStrategy = $('#charMemory_consolidationDialogStrategy').val();
        extension_settings[MODULE_NAME].consolidationStrategy = dialogStrategy;
        updateConsolidationStrategyUI();
        saveSettingsDebounced();

        // Run LLM
        $('#charMemory_rerunSpinner').show();
        $('#charMemory_rerunConsolidation').prop('disabled', true);

        const newResult = await runConsolidationLLM(memories);

        $('#charMemory_rerunSpinner').hide();
        $('#charMemory_rerunConsolidation').prop('disabled', false);

        if (newResult) {
            $('#charMemory_consolidationEditor').val(newResult);
            $('#charMemory_afterCount').text(countConsolidatedText(newResult));
        }
    });

    // Wire up undo button
    $('#charMemory_undoRerun').off('click').on('click', () => {
        if (versionStack.length === 0) return;
        const previousText = versionStack.pop();
        $('#charMemory_consolidationEditor').val(previousText);
        $('#charMemory_afterCount').text(countConsolidatedText(previousText));
        if (versionStack.length === 0) {
            $('#charMemory_undoRerun').prop('disabled', true);
        }
    });

    // Update count on editor change
    $('#charMemory_consolidationEditor').off('input').on('input', function () {
        $('#charMemory_afterCount').text(countConsolidatedText($(this).val()));
    });

    // Wait for user to accept or cancel
    const confirmed = await popup;
    if (!confirmed) {
        logActivity('Consolidation cancelled by user');
        toastr.info('Consolidation cancelled.', 'CharMemory');
        return;
    }

    // Parse the editor content and save
    const editedText = $('#charMemory_consolidationEditor').val();
    const parsed = parseMemories(editedText);
    if (parsed.length === 0) {
        toastr.warning('Could not parse any memories from the edited text. Memories unchanged.', 'CharMemory');
        return;
    }

    consolidationBackup = content;
    await writeMemories(serializeMemories(parsed));
    $('#charMemory_undoConsolidate').prop('disabled', false);

    const afterCount = countMemories(parsed);
    logActivity(`Consolidation complete: ${beforeCount} → ${afterCount} memories`, 'success');
    toastr.success(`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
    updateStatusDisplay();
}
```

**Step 2: Extract `runConsolidationLLM()` helper**

Add this function before `consolidateMemories()`:

```javascript
async function runConsolidationLLM(memories) {
    let memoriesText = memories.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(bullet => `- ${bullet}`).join('\n')}`,
    ).join('\n\n');

    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;
    if (isWebLlm) {
        const template = buildConsolidationPrompt('');
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - template.length, 1000);
        memoriesText = truncateText(memoriesText, available);
    }

    let prompt = buildConsolidationPrompt(memoriesText);
    prompt = substituteParamsExtended(prompt);

    try {
        inApiCall = true;
        const sourceLabel = getSourceLabel();
        toastr.info(`Consolidating via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

        const verbose = extension_settings[MODULE_NAME].verboseLogging;
        if (verbose) {
            logActivity(`Consolidation prompt sent to ${sourceLabel} (${prompt.length} chars):\n${prompt}`);
        }

        logActivity(`Sending consolidation to ${sourceLabel}... waiting for response`);
        const llmStartTime = Date.now();
        const result = await callLLM(
            prompt,
            extension_settings[MODULE_NAME].responseLength * 2,
            'You are a memory consolidation assistant.',
        );

        const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
        logActivity(`Consolidation response received from ${sourceLabel} in ${llmElapsed}s (${(result || '').length} chars)`);
        if (verbose && result) {
            logActivity(`Raw consolidation response:\n${result}`);
        }

        let cleanResult = removeReasoningFromString(result);
        cleanResult = cleanResult.trim();

        if (!cleanResult) {
            logActivity('Consolidation returned empty result', 'warning');
            toastr.warning('Consolidation returned empty result.', 'CharMemory');
            return null;
        }

        // Parse into memory format, then serialize back to plain text for the editor
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const consolidationRegex = /<memory>([\s\S]*?)<\/memory>/gi;
        const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
        const rawEntries = consolidationMatches.length > 0
            ? consolidationMatches.map(m => m[1].trim()).filter(Boolean)
            : [cleanResult.trim()].filter(Boolean);

        const consolidated = rawEntries.map(entry => {
            const bullets = entry.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('- '))
                .map(l => l.slice(2).trim())
                .filter(Boolean);
            return { chat: 'consolidated', date: timestamp, bullets: bullets.length > 0 ? bullets : [entry] };
        });

        return serializeMemories(consolidated);
    } catch (err) {
        console.error(LOG_PREFIX, 'Consolidation failed:', err);
        logActivity(`Consolidation failed: ${err.message}`, 'error');
        toastr.error('Memory consolidation failed. Check console for details.', 'CharMemory');
        return null;
    } finally {
        inApiCall = false;
    }
}
```

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: rewrite consolidateMemories with interactive dialog, re-run, and undo"
```

---

### Task 5: Final Integration and Manual Testing

**Files:**
- Modify: `index.js` (verify loadSettings initialization)
- Modify: `CHANGELOG.md` (add entry)

**Step 1: Verify settings migration**

Check that existing users who have no `consolidationStrategy` setting won't break. In `loadSettings()`, ensure the default fallback works:

```javascript
// After Object.assign for settings, no explicit migration needed —
// defaultSettings provides 'balanced' and buildConsolidationPrompt()
// falls back to 'balanced' if the field is missing.
```

**Step 2: Manual test checklist**

1. Open SillyTavern, go to a character with existing memories
2. Open CharMemory panel → Settings → verify "Consolidation strategy" dropdown appears with 4 options
3. Select each preset → verify the description text shows below the dropdown
4. Select "Custom" → verify the textarea appears
5. Click "Consolidate" → verify the interactive dialog opens with:
   - Left pane showing original memories
   - Right pane showing editable textarea with consolidated result
   - Stats bar at top
   - Strategy dropdown, Re-run, Undo buttons at bottom
6. Edit text in the textarea → verify the count updates live
7. Change strategy in dialog → click Re-run → verify new result appears
8. Click Undo → verify previous version is restored
9. Click Undo again → verify button disables when stack is empty
10. Click Accept → verify memories are saved
11. Click "Undo Consolidation" → verify original memories restore
12. Test cancel: run consolidation, click Cancel → verify memories unchanged

**Step 3: Update CHANGELOG.md**

Add entry for the new version.

**Step 4: Commit**

```bash
git add index.js CHANGELOG.md
git commit -m "feat: complete consolidation UX improvements with strategy presets"
```

---

## Task Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add consolidation presets + `buildConsolidationPrompt()` | `index.js` |
| 2 | Add consolidation strategy UI (HTML + listeners) | `settings.html`, `index.js` |
| 3 | Build interactive dialog HTML/CSS | `index.js`, `style.css` |
| 4 | Rewrite `consolidateMemories()` with dialog + re-run + undo | `index.js` |
| 5 | Integration, testing, changelog | `index.js`, `CHANGELOG.md` |
