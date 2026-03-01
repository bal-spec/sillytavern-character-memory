# Setup Wizard v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the setup wizard to fix critical UX bugs (competing OK button, no re-entry, state confusion) and expand it with extraction interval config, three-tier VS guidance, and a useful "Review & Go" step.

**Architecture:** All changes are in `index.js` (wizard function + troubleshooter + destructive confirmations), `settings.html` (dashboard gear icon), and `style.css` (new wizard component classes). No new files needed. The wizard uses `POPUP_TYPE.DISPLAY` which hides OK/Cancel and shows a native X button, so wizard lifecycle is entirely self-managed.

**Tech Stack:** jQuery DOM manipulation, SillyTavern `callGenericPopup`/`POPUP_TYPE`, existing `computeHealthScore()` / `extension_settings.vectors` for VS detection.

**Design doc:** `docs/plans/2026-03-01-wizard-v2-design.md`

---

## Task 1: Structural Fixes

**Files:**
- Modify: `index.js` — `showSetupWizard()` and auto-trigger condition

### Step 1: Fix auto-trigger condition

Find (line ~7654):
```js
if (!extension_settings[MODULE_NAME].selectedProvider && !extension_settings[MODULE_NAME].wizardCompleted) {
    showSetupWizard(1);
}
```

Replace with:
```js
if (!extension_settings[MODULE_NAME].wizardCompleted) {
    showSetupWizard(1);
}
```

**Why:** `defaultSettings.selectedProvider` is `'openrouter'`, so `!selectedProvider` is always false on fresh install. `wizardCompleted` is the actual "user has been through setup" flag.

### Step 2: Change popup type to DISPLAY

Find inside `showSetupWizard()`:
```js
const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
```

Replace with:
```js
const popup = callGenericPopup(html, POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
```

**Why:** `POPUP_TYPE.DISPLAY` hides OK/Cancel buttons (removing the competing "OK" that closed the wizard), while keeping the native X close button in the corner. Wizard navigation is now entirely through its own Back/Next/Get Started buttons.

### Step 3: Commit

```bash
git add index.js
git commit -m "fix: wizard uses POPUP_TYPE.DISPLAY, auto-trigger checks wizardCompleted only"
```

**Verify manually:** Start SillyTavern with `wizardCompleted: false` in settings. Wizard should appear. No OK button visible. Native X in corner closes it.

---

## Task 2: Re-entry Mechanisms

**Files:**
- Modify: `settings.html` — add wizard button to header
- Modify: `index.js` — wire up dashboard button, add wizard link to troubleshooter

### Step 1: Add wizard icon to dashboard header

In `settings.html`, find the header icons (the two `charMemory_headerGear` spans):
```html
<span id="charMemory_openTroubleshooter" class="charMemory_headerGear" title="Troubleshooter">
    <i class="fa-solid fa-screwdriver-wrench fa-sm"></i>
</span>
<span id="charMemory_openSettingsModal" class="charMemory_headerGear" title="Open Settings">
    <i class="fa-solid fa-gear fa-sm"></i>
</span>
```

Add a third icon before the troubleshooter span:
```html
<span id="charMemory_openWizard" class="charMemory_headerGear" title="Setup Wizard">
    <i class="fa-solid fa-wand-magic-sparkles fa-sm"></i>
</span>
```

### Step 2: Wire up dashboard wizard button

In `index.js`, find the nudge banner click handler (line ~7659):
```js
$('#charMemory_nudgeFix').on('click', function () {
```

Add before it:
```js
$('#charMemory_openWizard').on('click', function () {
    showSetupWizard(1);
});
```

### Step 3: Add "Re-run Setup Wizard" to Troubleshooter reset section

In `showTroubleshooter()`, find the reset section HTML where the two reset buttons are built. It looks like:
```js
<div class="charMemory_tsResetSection">
    <button class="menu_button" id="cm_ts_resetTracking">Reset Extraction State</button>
    ...
```

Add a new section at the top of the reset section (before the destructive buttons):
```js
<div class="charMemory_tsResetSection">
    <button class="menu_button" id="cm_ts_openWizard">Re-run Setup Wizard</button>
    <small class="charMemory_helperText">Walk through the setup steps again to reconfigure your LLM connection, storage, or retrieval settings.</small>
</div>
```

### Step 4: Wire up troubleshooter wizard button

In the troubleshooter event wiring section (where `cm_ts_resetTracking` and `cm_ts_clearMemories` are handled), add:
```js
$modal.find('#cm_ts_openWizard').on('click', async function () {
    // Close the troubleshooter popup first
    $modal.closest('.popup').find('.popup-button-ok, .popup-button-close').first().trigger('click');
    setTimeout(() => showSetupWizard(1), 200);
});
```

### Step 5: Commit

```bash
git add index.js settings.html
git commit -m "feat: wizard re-entry via dashboard icon and troubleshooter button"
```

---

## Task 3: Step 1 — Model Picker Redesign + NanoGPT Badges

**Files:**
- Modify: `index.js` — step1Html, renderWizModelDropdown → renderWizModelList, updateWizProviderUI, NanoGPT filter wiring
- Modify: `style.css` — new model list and badge classes

### Step 1: Replace dropdown-based model picker in step1Html

Find the `step1Html` constant in `showSetupWizard()`. Replace the `cm_wiz_modelRow` field group:

**Old:**
```js
<div class="charMemory_modalFieldGroup" id="cm_wiz_modelRow" style="display:none;">
    <label><small>Model</small></label>
    <div class="charMemory_modelPicker" style="position:relative;">
        <input type="text" id="cm_wiz_modelSearch" class="text_pole" placeholder="Search models..." autocomplete="off" value="" />
        <input type="hidden" id="cm_wiz_modelValue" value="" />
        <div id="cm_wiz_modelDropdown" class="charMemory_modelDropdown"></div>
    </div>
    <small id="cm_wiz_modelStatus" class="charMemory_helperText" style="display:none;"></small>
</div>
```

**New:**
```js
<div class="charMemory_modalFieldGroup" id="cm_wiz_modelRow" style="display:none;">
    <label><small>Model</small></label>
    <div id="cm_wiz_nanogptFilters" style="display:none; margin-bottom:6px;">
        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterSub" /> <small>Subscription</small></label>
        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterOS" /> <small>Open Source</small></label>
        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterRP" /> <small>Roleplay</small></label>
        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterReasoning" /> <small>Reasoning</small></label>
    </div>
    <div class="charMemory_wizModelPicker">
        <input type="text" id="cm_wiz_modelSearch" class="charMemory_wizModelSearch" placeholder="Search models..." autocomplete="off" value="" />
        <input type="hidden" id="cm_wiz_modelValue" value="" />
        <div id="cm_wiz_modelList" class="charMemory_wizModelList"></div>
    </div>
    <small id="cm_wiz_modelStatus" class="charMemory_helperText" style="display:none;"></small>
</div>
```

### Step 2: Replace renderWizModelDropdown with renderWizModelList

Remove the entire `renderWizModelDropdown` function and replace with:

```js
function renderWizModelList(filter) {
    const $list = $wizard.find('#cm_wiz_modelList');
    $list.empty();

    const pk = extension_settings[MODULE_NAME].selectedProvider;
    const isNanogpt = pk === 'nanogpt';
    const lowerFilter = (filter || '').toLowerCase();
    const selectedId = $wizard.find('#cm_wiz_modelValue').val();

    let models = currentModelList;
    if (isNanogpt) {
        const ps = getProviderSettings(pk);
        models = getFilteredNanoGptModels(models, ps);
    }

    if (models.length === 0) {
        $list.append('<div class="charMemory_modelEmpty">No models loaded</div>');
        return;
    }

    let hasResults = false;
    let lastGroup = null;
    for (const model of models) {
        if (lowerFilter && !model.id.toLowerCase().includes(lowerFilter) && !model.name.toLowerCase().includes(lowerFilter)) continue;
        if (model.group && model.group !== lastGroup) {
            $list.append(`<div class="charMemory_modelGroup">${escapeHtml(model.group)}</div>`);
            lastGroup = model.group;
        }

        let badgesHtml = '';
        if (isNanogpt) {
            if (model.subscription) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--sub">sub</span>';
            if (model.isOpenSource) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--open">open</span>';
            if (model.category === 'Roleplay/storytelling models') badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--rp">rp</span>';
            if (model.capabilities && model.capabilities.includes('reasoning')) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--reason">reason</span>';
        }

        const selectedClass = model.id === selectedId ? ' selected' : '';
        $list.append(`<div class="charMemory_modelOption${selectedClass}" data-model-id="${escapeAttr(model.id)}">
            <span class="charMemory_modelOptionName">${escapeHtml(model.name)}</span>
            ${badgesHtml}
        </div>`);
        hasResults = true;
    }

    if (!hasResults) {
        $list.append('<div class="charMemory_modelEmpty">No matching models</div>');
    }
}
```

### Step 3: Update event handlers to use the new list

Remove the old dropdown focus/input handlers and replace with:

```js
$wizard.on('input', '#cm_wiz_modelSearch', function () {
    renderWizModelList($(this).val());
});
```

Remove the `$(document).off('click.cmWizModelPicker')` handler entirely — the always-visible list doesn't need click-outside-to-close behavior.

Update the click handler to use the new IDs:

```js
$wizard.on('click', '#cm_wiz_modelList .charMemory_modelOption', function () {
    const modelId = String($(this).data('model-id'));
    const model = currentModelList.find(m => m.id === modelId);
    if (!model) return;

    $wizard.find('#cm_wiz_modelValue').val(modelId);
    $wizard.find('#cm_wiz_modelSearch').val(model.name);

    $wizard.find('#cm_wiz_modelList .charMemory_modelOption').removeClass('selected');
    $(this).addClass('selected');

    const pk = extension_settings[MODULE_NAME].selectedProvider;
    const ps = getProviderSettings(pk);
    ps.model = modelId;
    saveSettingsDebounced();
});
```

### Step 4: Update updateWizProviderUI to show/hide NanoGPT filters and sync checkboxes

Inside `updateWizProviderUI()`, add after the existing logic:

```js
const isNanogpt = pk === 'nanogpt';
$wizard.find('#cm_wiz_nanogptFilters').toggle(isNanogpt);
if (isNanogpt) {
    const ps = getProviderSettings(pk);
    $wizard.find('#cm_wiz_nanogptFilterSub').prop('checked', ps.nanogptFilterSubscription || false);
    $wizard.find('#cm_wiz_nanogptFilterOS').prop('checked', ps.nanogptFilterOpenSource || false);
    $wizard.find('#cm_wiz_nanogptFilterRP').prop('checked', ps.nanogptFilterRoleplay || false);
    $wizard.find('#cm_wiz_nanogptFilterReasoning').prop('checked', ps.nanogptFilterReasoning || false);
}
```

Also update the connect handler: when models load and model list is shown, call `renderWizModelList('')` instead of the old dropdown renderer.

### Step 5: Wire up NanoGPT filter checkboxes

```js
$wizard.on('change', '#cm_wiz_nanogptFilterSub, #cm_wiz_nanogptFilterOS, #cm_wiz_nanogptFilterRP, #cm_wiz_nanogptFilterReasoning', function () {
    const pk = extension_settings[MODULE_NAME].selectedProvider;
    const ps = getProviderSettings(pk);
    ps.nanogptFilterSubscription = $wizard.find('#cm_wiz_nanogptFilterSub').prop('checked');
    ps.nanogptFilterOpenSource = $wizard.find('#cm_wiz_nanogptFilterOS').prop('checked');
    ps.nanogptFilterRoleplay = $wizard.find('#cm_wiz_nanogptFilterRP').prop('checked');
    ps.nanogptFilterReasoning = $wizard.find('#cm_wiz_nanogptFilterReasoning').prop('checked');
    saveSettingsDebounced();
    renderWizModelList($wizard.find('#cm_wiz_modelSearch').val());
});
```

### Step 6: Add CSS for model list and badges

In `style.css`, in the wizard section (after `.charMemory_wizardSummary`), add:

```css
.charMemory_wizModelPicker {
    position: relative;
}

.charMemory_wizModelSearch {
    background: var(--SmartThemeBodyColor, #1a1a1a);
    color: var(--SmartThemeBodyTextColor, #ccc);
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-radius: 4px 4px 0 0;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    font-size: 0.9em;
}

.charMemory_wizModelList {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-top: none;
    border-radius: 0 0 4px 4px;
    background: var(--SmartThemeBodyColor, #1a1a1a);
}

.charMemory_wizModelList .charMemory_modelOption {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.charMemory_modelOptionName {
    flex: 1;
    min-width: 0;
}

.charMemory_modelBadge {
    font-size: 0.7em;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    opacity: 0.85;
}

.charMemory_modelBadge--sub  { background: #1a4a2a; color: #6ecf8f; }
.charMemory_modelBadge--open { background: #1a2a4a; color: #6ea8cf; }
.charMemory_modelBadge--rp   { background: #3a1a4a; color: #b06ecf; }
.charMemory_modelBadge--reason { background: #4a3a1a; color: #cfb06e; }
```

### Step 7: Run tests and commit

```bash
npm test
git add index.js style.css
git commit -m "feat: wizard step 1 — always-visible model list, NanoGPT subscription badges and filters"
```

**Verify manually:** Connect to NanoGPT in wizard. Model list should be visible and scrollable immediately after connect. Badges appear next to NanoGPT models. Filter checkboxes narrow the list. Non-NanoGPT providers show plain list, no filters/badges.

---

## Task 4: Step 2 — Configure

**Files:**
- Modify: `index.js` — step2Html, initStep2()

### Step 1: Replace step2Html

Replace the entire `step2Html` constant:

```js
const step2Html = `
    <div class="charMemory_wizardStep" data-step="2">
        <div class="charMemory_wizardExplanation">
            Configure how CharMemory stores and retrieves memories.
        </div>

        <div class="charMemory_wizardSection">
            <div class="charMemory_wizardSectionTitle">Memory Storage</div>
            <p class="charMemory_helperText" style="margin:4px 0 0;">Each character gets their own memory file in their Data Bank. You can change storage options (including per-chat separation) in Settings later.</p>
        </div>

        <div class="charMemory_wizardSection">
            <div class="charMemory_wizardSectionTitle">Extraction Frequency</div>
            <div class="charMemory_modalFieldGroup" style="margin:4px 0 0;">
                <label><small>Extract every
                    <input type="number" id="cm_wiz_interval" class="charMemory_wizSmallInput" min="5" max="500" value="${s.interval || 20}" />
                    messages</small></label>
                <small class="charMemory_helperText">Lower = more frequent, more API calls. Higher = less frequent, bigger batches. 20 is a good starting point.</small>
            </div>
        </div>

        <div class="charMemory_wizardSection">
            <div class="charMemory_wizardSectionTitle">Retrieval (Vector Storage)</div>
            <p class="charMemory_helperText" style="margin:4px 0 6px;">Vector Storage finds the right memories at the right time and injects them into the prompt. Without it, memories are stored but never used.</p>
            <div id="cm_wiz_healthChecks">
                <div class="charMemory_diagEmpty">Checking Vector Storage configuration...</div>
            </div>
        </div>

        <div id="cm_wiz_vsWarning" class="charMemory_wizardVsWarning" style="display:none;">
            ⚠ You can continue — memories will be stored but not retrieved until Vector Storage is configured.
        </div>

        <div class="charMemory_wizardNav">
            <input type="button" id="cm_wiz_back2" class="menu_button" value="← Back" />
            <input type="button" id="cm_wiz_next2" class="menu_button" value="Next →" />
        </div>
    </div>`;
```

### Step 2: Add interval input wiring

After the provider change handler block (with the other `$wizard.on` handlers), add:

```js
$wizard.on('input', '#cm_wiz_interval', function () {
    const val = Math.max(5, Math.min(500, parseInt($(this).val(), 10) || 20));
    extension_settings[MODULE_NAME].interval = val;
    saveSettingsDebounced();
});
```

### Step 3: Rewrite initStep2 with three-tier VS detection

Replace the entire `initStep2` function:

```js
async function initStep2() {
    const $container = $wizard.find('#cm_wiz_healthChecks');
    $container.html('<div class="charMemory_diagEmpty">Checking Vector Storage configuration...</div>');
    $wizard.find('#cm_wiz_vsWarning').hide();

    const vsSettings = extension_settings.vectors;
    const filesEnabled = vsSettings?.enabled_files;

    if (!filesEnabled) {
        // Tier 1: VS Files not enabled
        $container.html(`
            <div class="charMemory_wizardCheck">
                <i class="fa-solid fa-circle-xmark fa-sm" style="color:#c44;"></i>
                <div class="charMemory_wizardCheckDetail">
                    <div class="charMemory_wizardCheckLabel">Vector Storage not enabled</div>
                    <div class="charMemory_wizardCheckText">CharMemory will store memories but your character won't recall them automatically. Enable <strong>Files</strong> in <strong>Extensions → Vector Storage</strong> when you're ready.</div>
                </div>
            </div>
        `);
        $wizard.find('#cm_wiz_vsWarning').show();
        wizHealthResult = null;
        return;
    }

    // Tier 2: VS enabled — check chunk settings
    const chunkSize = vsSettings?.chunk_size_db ?? 2500;
    const overlap = vsSettings?.overlap_percent_db ?? 0;
    const badChunkSize = chunkSize < 500 || chunkSize > 1500;
    const badOverlap = overlap === 0;

    if (badChunkSize || badOverlap) {
        let issues = [];
        if (badChunkSize) issues.push(`chunk size is ${chunkSize} chars (recommended 800–1000)`);
        if (badOverlap) issues.push('overlap is 0% (recommended 10–25%)');

        $container.html(`
            <div class="charMemory_wizardCheck">
                <i class="fa-solid fa-circle-check fa-sm" style="color:#4a4;"></i>
                <div class="charMemory_wizardCheckDetail">
                    <div class="charMemory_wizardCheckLabel">Vector Storage for files</div>
                    <div class="charMemory_wizardCheckText">Enabled — Data Bank files will be vectorized</div>
                </div>
            </div>
            <div class="charMemory_wizardCheck">
                <i class="fa-solid fa-triangle-exclamation fa-sm" style="color:#e8a33d;"></i>
                <div class="charMemory_wizardCheckDetail">
                    <div class="charMemory_wizardCheckLabel">Settings may need tuning</div>
                    <div class="charMemory_wizardCheckText">Your ${issues.join(' and ')}. CharMemory works best with chunk size 800–1000 chars and overlap 10–25%. Adjust in <strong>Extensions → Vector Storage</strong>.</div>
                </div>
            </div>
        `);
        $wizard.find('#cm_wiz_vsWarning').show();
        wizHealthResult = { level: 'yellow', checks: [] };
        return;
    }

    // Tier 3: All good
    $container.html(`
        <div class="charMemory_wizardCheck">
            <i class="fa-solid fa-circle-check fa-sm" style="color:#4a4;"></i>
            <div class="charMemory_wizardCheckDetail">
                <div class="charMemory_wizardCheckLabel">Vector Storage for files</div>
                <div class="charMemory_wizardCheckText">Enabled — Data Bank files will be vectorized</div>
            </div>
        </div>
        <div class="charMemory_wizardCheck">
            <i class="fa-solid fa-circle-check fa-sm" style="color:#4a4;"></i>
            <div class="charMemory_wizardCheckDetail">
                <div class="charMemory_wizardCheckLabel">Chunk settings</div>
                <div class="charMemory_wizardCheckText">Chunk size ${chunkSize} chars, overlap ${overlap}% — looks good for CharMemory.</div>
            </div>
        </div>
    `);
    wizHealthResult = { level: 'green', checks: [] };
}
```

### Step 4: Add CSS for step 2 new elements

In `style.css`, in the wizard section, add:

```css
.charMemory_wizardSection {
    margin-bottom: 14px;
}

.charMemory_wizardSectionTitle {
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin-bottom: 4px;
}

.charMemory_wizSmallInput {
    width: 60px;
    text-align: center;
    padding: 2px 4px;
    margin: 0 4px;
    background: var(--SmartThemeBodyColor, #1a1a1a);
    color: var(--SmartThemeBodyTextColor, #ccc);
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-radius: 3px;
}

.charMemory_wizardVsWarning {
    font-size: 0.85em;
    color: #e8a33d;
    padding: 6px 0;
    margin-bottom: 6px;
}
```

### Step 5: Run tests and commit

```bash
npm test
git add index.js style.css
git commit -m "feat: wizard step 2 — extraction interval input, three-tier VS detection"
```

**Verify manually:**
- VS not enabled → red message + warning above Next
- VS enabled with default chunk settings → yellow tuning message
- VS enabled with good settings → two green checks
- Changing interval saves to extension_settings

---

## Task 5: Step 3 — Review & Go

**Files:**
- Modify: `index.js` — step3Html, initStep3()

### Step 1: Replace step3Html

Replace the entire `step3Html` constant:

```js
const step3Html = `
    <div class="charMemory_wizardStep" data-step="3">
        <div class="charMemory_wizardExplanation">
            <strong>Review your setup</strong> — everything looks correct? Hit Get Started. If something's wrong, use Back.
        </div>
        <div id="cm_wiz_summary" class="charMemory_wizardSummary"></div>
        <div class="charMemory_wizardSection" style="margin-top:10px;">
            <div class="charMemory_wizardSectionTitle">Getting Started</div>
            <p class="charMemory_helperText" style="margin:4px 0 0;">Open the <strong>Injection Sidebar</strong> from the dashboard to see which memories are being used in your character's prompt in real time.</p>
        </div>
        <div id="cm_wiz_convertSection" style="display:none;" class="charMemory_wizardConvertSection">
            <div class="charMemory_wizardSectionTitle">Existing Memories Found</div>
            <p class="charMemory_helperText" style="margin:4px 0 6px;">We found existing memories for <span id="cm_wiz_convertCharName"></span>. The <strong>Convert</strong> tool can reformat them for better retrieval.</p>
            <input type="button" id="cm_wiz_convertNow" class="menu_button" value="Convert Now" />
            <input type="button" id="cm_wiz_convertSkip" class="menu_button" value="Skip — I'll do this later" style="margin-left:6px;" />
        </div>
        <p class="charMemory_helperText" style="margin-top:auto; padding-top:10px; font-size:0.8em; opacity:0.6;">Tools like Clear Memories and Reset Extraction State only affect the current character.</p>
        <div class="charMemory_wizardNav">
            <input type="button" id="cm_wiz_back3" class="menu_button" value="← Back" />
            <input type="button" id="cm_wiz_done" class="menu_button" value="Get Started" />
        </div>
    </div>`;
```

### Step 2: Replace initStep3 with async version

Replace the entire `initStep3` function:

```js
async function initStep3() {
    const pk = extension_settings[MODULE_NAME].selectedProvider;
    const p = PROVIDER_PRESETS[pk] || {};
    const ps = getProviderSettings(pk);
    const modelName = ps.model || p.defaultModel || '(default)';
    const modelShort = modelName.length > 40 ? modelName.slice(0, 40) + '\u2026' : modelName;
    const interval = extension_settings[MODULE_NAME].interval || 20;

    const vsStatus = (() => {
        if (!wizHealthResult) return '\u2014 Not checked';
        if (wizHealthResult.level === 'green') return '\u2714 Ready';
        if (wizHealthResult.level === 'yellow') return '\u26A0 Needs tuning';
        return '\u26A0 Not configured';
    })();

    $wizard.find('#cm_wiz_summary').html(`
        <div class="charMemory_wizardSummaryRow">
            <span class="label">Provider</span>
            <span>${escapeHtml(p.name || pk)}</span>
        </div>
        <div class="charMemory_wizardSummaryRow">
            <span class="label">Model</span>
            <span>${escapeHtml(modelShort)}</span>
        </div>
        <div class="charMemory_wizardSummaryRow">
            <span class="label">Connection</span>
            <span class="charMemory_wizardHighlight">${wizConnectionOk ? '\u2714 Connected' : '\u26A0 Not tested'}</span>
        </div>
        <div class="charMemory_wizardSummaryRow">
            <span class="label">Extract every</span>
            <span>${interval} messages</span>
        </div>
        <div class="charMemory_wizardSummaryRow">
            <span class="label">Vector Storage</span>
            <span class="charMemory_wizardHighlight">${vsStatus}</span>
        </div>
    `);

    // Check for existing memories — show conversion section if found
    const targets = getMemoryTargets();
    const target = targets[0];
    if (target) {
        const content = await readMemoriesForCharacter(target.avatar, target.fileName);
        if (content && content.trim()) {
            $wizard.find('#cm_wiz_convertCharName').text(target.name);
            $wizard.find('#cm_wiz_convertSection').show();
        } else {
            $wizard.find('#cm_wiz_convertSection').hide();
        }
    }
}
```

### Step 3: Update showStep to await initStep3

Find:
```js
if (step === 3) initStep3();
```

Replace with:
```js
if (step === 3) initStep3(); // async, fire and forget — DOM updates when ready
```

(No change needed — fire-and-forget is fine; the summary and convert section appear as they load.)

### Step 4: Wire up Convert Now and Skip buttons

After the existing `cm_wiz_done` click handler, add:

```js
$wizard.on('click', '#cm_wiz_convertNow', async function () {
    const targets = getMemoryTargets();
    const target = targets[0];
    if (!target) return;

    extension_settings[MODULE_NAME].wizardCompleted = true;
    saveSettingsDebounced();

    // Close wizard
    $wizard.closest('.popup').find('.popup-button-ok, .popup-button-close').first().trigger('click');

    // Launch convert flow after brief delay
    setTimeout(() => convertWithLLM(target), 200);
});

$wizard.on('click', '#cm_wiz_convertSkip', function () {
    // Just hide the section, user can convert later
    $wizard.find('#cm_wiz_convertSection').hide();
});
```

### Step 5: Add CSS for step 3 convert section

```css
.charMemory_wizardConvertSection {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-radius: 4px;
    padding: 10px 12px;
    margin-bottom: 10px;
}
```

### Step 6: Run tests and commit

```bash
npm test
git add index.js style.css
git commit -m "feat: wizard step 3 — review summary with interval, injection sidebar tip, existing memory conversion"
```

**Verify manually:**
- Summary shows provider, model, connection status, interval, VS status
- Injection sidebar tip is visible
- With existing memories: Convert section appears with character name
- Without existing memories: Convert section hidden
- Convert Now closes wizard and launches convert flow
- Skip hides the convert section

---

## Task 6: Destructive Action Scoping Language

**Files:**
- Modify: `index.js` — confirmation dialogs in Troubleshooter reset section

### Step 1: Update Reset Extraction State confirmation

Find the confirmation text for `cm_ts_resetTracking` (in `showTroubleshooter` event wiring):
```js
'Reset extraction tracking for the current character? Next extraction will re-read all messages.',
```

Replace with (using `charName` which is already available in `showTroubleshooter` scope):
```js
`Reset extraction tracking for ${charName || 'this character'}? CharMemory will re-process messages from the beginning. This only affects ${charName || 'this character'} — other characters are not affected.`,
```

### Step 2: Update Clear All Memories confirmation

Find the confirmation text for `cm_ts_clearMemories`:
```js
'Delete ALL memories for this character and reset extraction tracking? This cannot be undone.',
```

Replace with:
```js
`Delete all memories for ${charName || 'this character'} and reset extraction tracking? This cannot be undone.\n\n${extension_settings[MODULE_NAME].perChat ? 'Only this chat\'s memories will be deleted.' : 'In default mode, this deletes memories from all of ' + (charName || 'this character') + '\'s chats.'}`,
```

### Step 3: Run tests and commit

```bash
npm test
git add index.js
git commit -m "fix: destructive action confirmations include character name and scope clarification"
```

---

## Task 7: Push and Manual Test

### Step 1: Push beta branch

```bash
git push origin beta
```

### Step 2: Install in SillyTavern and test against test plan

Follow the manual test plan in the session context:
1. Fresh install wizard — verify no OK button, wizard appears on first load
2. Step 1 — NanoGPT model list visible, badges present, filters work
3. Step 2 — VS not enabled shows red, VS with bad settings shows yellow, good VS shows green; interval saves
4. Step 3 — summary reflects all config including interval; conversion prompt appears with existing memories
5. Dashboard gear icon opens wizard
6. Troubleshooter "Re-run Setup Wizard" works
7. Destructive confirmations include character name and scope
