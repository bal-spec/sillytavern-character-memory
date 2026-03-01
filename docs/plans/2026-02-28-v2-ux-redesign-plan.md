# v2.0 UX Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 4-tab sidebar with a single-view dashboard and center-screen modals, creating a guided first-run experience while preserving all features.

**Architecture:** Build modals first (additive, non-breaking), then rebuild the sidebar (destructive, replaces tabs). Each modal is self-contained HTML/CSS/JS that can be tested independently before the sidebar migration. The Injection Viewer drawer pattern is reused for the Log Drawer.

**Tech Stack:** JavaScript (ES modules), jQuery, SillyTavern extension framework (callGenericPopup, POPUP_TYPE), CSS with ST theme variables

---

## Important Context

- `callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true })` creates a center-screen modal. The HTML can be anything — we build left-nav layouts inside.
- `POPUP_TYPE.TEXT` = display-only modal (no OK/Cancel). `POPUP_TYPE.CONFIRM` = modal with OK/Cancel buttons. We use TEXT for settings/prompts (save buttons are in our HTML), CONFIRM for dialogs needing accept/reject.
- All CSS classes use `charMemory_` prefix. All element IDs use `charMemory_` prefix.
- Theme variables: `var(--SmartThemeBlurTintColor)` (background), `var(--SmartThemeBorderColor)` (borders), `var(--SmartThemeQuoteColor)` (accent), `var(--SmartThemeBodyColor)` (text).
- Working directory: `/Users/davidsayed/repos/sillytavern-character-memory` on the `beta` branch.
- Run `npm test` after every commit. All 117 unit tests must pass.
- The current `settings.html` (448 lines), `style.css` (1,072 lines), and `index.js` (5,709 lines) are the starting points.

---

## Task 1: Settings Modal

Build the center-screen Settings modal with left sidebar nav (Connection, Extraction, Storage, Prompts, Advanced). Opened by a gear icon. Does NOT remove the existing Settings tab yet — both coexist until the sidebar rebuild.

**Files:**
- Modify: `settings.html` (add gear icon to header, add modal template)
- Modify: `style.css` (add modal and nav styles)
- Modify: `index.js` (add `showSettingsModal()`, wire gear icon, populate settings into modal)

### Step 1: Add the Settings modal HTML template

Add to `settings.html` at the very end (after the existing bottom diagnostics section), a hidden template div that `showSettingsModal()` will clone and populate:

```html
<!-- Settings Modal Template -->
<div id="charMemory_settingsModalTemplate" style="display:none;">
    <div class="charMemory_modal">
        <div class="charMemory_modalNav">
            <button class="charMemory_modalNavItem active" data-section="connection">Connection</button>
            <button class="charMemory_modalNavItem" data-section="extraction">Extraction</button>
            <button class="charMemory_modalNavItem" data-section="storage">Storage</button>
            <button class="charMemory_modalNavItem" data-section="prompts">Prompts</button>
            <button class="charMemory_modalNavItem" data-section="advanced">Advanced</button>
        </div>
        <div class="charMemory_modalContent">
            <!-- Each section is a div, shown/hidden by nav clicks -->
            <div class="charMemory_modalSection active" data-section="connection">
                <!-- LLM source dropdown, provider settings, API key, connect, model picker, system prompt -->
                <!-- "Run Setup Wizard" link at bottom -->
            </div>
            <div class="charMemory_modalSection" data-section="extraction">
                <!-- Auto-extraction: interval slider, cooldown slider -->
                <!-- Messages per LLM call, max response length, merge chunks toggle -->
                <!-- Extraction Prompt (1:1): summary line + [View / Edit] button -->
                <!-- Extraction Prompt (Group): summary line + [View / Edit] button -->
            </div>
            <div class="charMemory_modalSection" data-section="storage">
                <!-- Per-chat memories toggle -->
                <!-- File name field -->
                <!-- Group chat member files (shown when in group chat) -->
            </div>
            <div class="charMemory_modalSection" data-section="prompts">
                <!-- Overview of all 4 prompts with version badges and customization status -->
                <!-- Each has [View / Edit] → opens Prompts modal -->
            </div>
            <div class="charMemory_modalSection" data-section="advanced">
                <!-- Memory File Format (chunk boundary, custom separator, metadata prefix) -->
                <!-- Reset extraction state, Clear all memories (with confirmation dialogs) -->
            </div>
        </div>
    </div>
</div>
```

The actual form controls (sliders, dropdowns, checkboxes) should be the SAME controls as the current Settings tab — same IDs, same structure. They're being moved, not rebuilt. The key difference is the container layout (left-nav modal vs tab content).

### Step 2: Add CSS for the modal layout

Add to `style.css`:

```css
/* ── Settings/Prompts Modal ── */
.charMemory_modal {
    display: flex;
    min-height: 400px;
    max-height: 70vh;
    gap: 0;
}

.charMemory_modalNav {
    display: flex;
    flex-direction: column;
    min-width: 130px;
    border-right: 1px solid var(--SmartThemeBorderColor);
    padding: 8px 0;
    flex-shrink: 0;
}

.charMemory_modalNavItem {
    background: none;
    border: none;
    padding: 8px 16px;
    text-align: left;
    cursor: pointer;
    opacity: 0.6;
    font-size: 0.9em;
    border-left: 3px solid transparent;
    color: var(--SmartThemeBodyColor);
}

.charMemory_modalNavItem:hover {
    opacity: 0.85;
    background: rgba(255,255,255,0.03);
}

.charMemory_modalNavItem.active {
    opacity: 1;
    border-left-color: var(--SmartThemeQuoteColor);
    background: rgba(255,255,255,0.05);
}

.charMemory_modalContent {
    flex: 1;
    padding: 12px 16px;
    overflow-y: auto;
    min-width: 0;
}

.charMemory_modalSection {
    display: none;
}

.charMemory_modalSection.active {
    display: block;
}
```

### Step 3: Add gear icon to sidebar header

In `settings.html`, add a gear icon button to the extension header area (next to the "CharMemory" title in the inline-drawer header). The exact location depends on the current header structure.

### Step 4: Implement `showSettingsModal()` in index.js

Create function that:
1. Clones the template HTML
2. Populates all form controls with current settings values (reuse patterns from `loadSettings()`)
3. Opens via `callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true })`
4. Wires nav click handlers (show/hide sections)
5. Wires all form control change handlers (save on change, same as current `setupExtractionControls()` etc.)
6. Wires the [View / Edit] prompt buttons to call `showPromptsModal()` (Task 2)

### Step 5: Wire gear icon click handler

In `setupLogControls()` (or a new `setupDashboardControls()`), add click handler for the gear icon that calls `showSettingsModal()`.

### Step 6: Test manually

- Click gear icon → Settings modal opens
- Left nav works — switching between Connection, Extraction, Storage, Prompts, Advanced
- All settings controls respond and save
- Provider switching, connect, model picker all work inside the modal
- [View / Edit] buttons exist (will be wired in Task 2)
- Close modal → settings are preserved

### Step 7: Commit

```bash
git add settings.html style.css index.js
git commit -m "feat: add Settings modal with left-nav layout

Center-screen modal opened by gear icon. Contains Connection,
Extraction, Storage, Prompts overview, and Advanced sections.
Coexists with existing Settings tab until sidebar rebuild."
```

---

## Task 2: Prompts Modal

Build the Prompts modal — full-screen modal for viewing/editing all 4 prompts. Opened from [View / Edit] buttons in the Settings modal's Extraction and Prompts sections.

**Files:**
- Modify: `settings.html` (add prompts modal template)
- Modify: `style.css` (add prompts modal styles)
- Modify: `index.js` (add `showPromptsModal(activePrompt)`, wire View/Edit buttons)

### Step 1: Add Prompts modal HTML template

Add to `settings.html`:

```html
<div id="charMemory_promptsModalTemplate" style="display:none;">
    <div class="charMemory_modal charMemory_promptsModal">
        <div class="charMemory_modalNav">
            <button class="charMemory_modalNavItem active" data-prompt="extraction">Extract (1:1)</button>
            <button class="charMemory_modalNavItem" data-prompt="groupExtraction">Extract (Group)</button>
            <button class="charMemory_modalNavItem" data-prompt="consolidation">Consolidation</button>
            <button class="charMemory_modalNavItem" data-prompt="conversion">Convert</button>
        </div>
        <div class="charMemory_modalContent">
            <div class="charMemory_promptHeader">
                <h3 id="charMemory_promptTitle">Extraction Prompt (1:1)</h3>
                <span class="charMemory_promptBadge" id="charMemory_promptBadge">v1.7.0 • Default</span>
            </div>
            <textarea id="charMemory_promptEditor" class="text_pole" rows="20"></textarea>
            <div class="charMemory_buttonRow" style="margin-top: 8px;">
                <input type="button" id="charMemory_promptRestore" class="menu_button" value="Restore Default" />
                <input type="button" id="charMemory_promptSave" class="menu_button" value="Save" />
            </div>
        </div>
    </div>
</div>
```

### Step 2: Add CSS for prompts modal

```css
.charMemory_promptsModal {
    min-height: 500px;
}

.charMemory_promptHeader {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
}

.charMemory_promptHeader h3 {
    margin: 0;
    font-size: 1em;
}

.charMemory_promptBadge {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 2px 8px;
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 10px;
}

#charMemory_promptEditor {
    width: 100%;
    min-height: 300px;
    font-family: monospace;
    font-size: 0.85em;
    resize: vertical;
}
```

### Step 3: Implement `showPromptsModal(activePrompt)`

Create function that:
1. `activePrompt` parameter: `'extraction'`, `'groupExtraction'`, `'consolidation'`, or `'conversion'`
2. Clones the template HTML
3. Sets the active nav item based on `activePrompt`
4. Loads the prompt text into the textarea
5. Shows the version badge (default vs custom)
6. Opens via `callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true })`
7. Wires nav click handlers (switch between prompts, save current before switching)
8. Wires Save button (save to `extension_settings`)
9. Wires Restore Default button (confirm, then restore default prompt text)

### Step 4: Wire [View / Edit] buttons in Settings modal

In `showSettingsModal()`, add click handlers for the prompt View/Edit buttons that call `showPromptsModal('extraction')` etc.

### Step 5: Define prompt metadata

Add a `PROMPT_CONFIG` object to index.js that maps prompt keys to their display names, default values, and settings keys:

```javascript
const PROMPT_CONFIG = {
    extraction: {
        title: 'Extraction Prompt (1:1)',
        settingsKey: 'extractionPrompt',
        defaultValue: defaultExtractionPrompt,
        version: '1.7.0',
    },
    groupExtraction: {
        title: 'Extraction Prompt (Group)',
        settingsKey: 'groupExtractionPrompt',
        defaultValue: defaultGroupExtractionPrompt,
        version: '1.7.0',
    },
    consolidation: {
        title: 'Consolidation Prompt',
        settingsKey: 'consolidationPrompt', // per-strategy
        defaultValue: null, // depends on strategy
        version: '1.7.0',
    },
    conversion: {
        title: 'Conversion Prompt',
        settingsKey: 'convertPrompt',
        defaultValue: defaultConversionPrompt,
        version: '1.7.0',
    },
};
```

### Step 6: Test manually

- Open Settings modal → Extraction section → click [View / Edit] next to Extraction Prompt
- Prompts modal opens with the correct prompt loaded
- Switch between 4 prompts using left nav
- Edit a prompt → Save → close → reopen → edit is preserved
- Restore Default → confirm → prompt reverts to default

### Step 7: Commit

```bash
git add settings.html style.css index.js
git commit -m "feat: add Prompts modal with full-width editor

Four-prompt editor with left nav, version badges,
Save and Restore Default buttons. Opened from Settings modal."
```

---

## Task 3: Log Drawer

Build the slide-out Log Drawer (same pattern as Injection Viewer). Opened from "View full log" link. Replaces the current Log tab.

**Files:**
- Modify: `index.js` (add `toggleLogDrawer()`, `updateLogDrawer()`, wire triggers)
- Modify: `style.css` (add log drawer styles, reuse injection drawer patterns)

### Step 1: Add Log Drawer HTML

The drawer HTML is built in JS (same as the Injection Viewer — appended to `$('body')`). Add it in the jQuery ready handler:

```javascript
$('body').append(`
    <div id="charMemory_logDrawer" class="charMemory_logDrawer">
        <div class="charMemory_drawerHeader">
            <span>Activity Log</span>
            <div style="display:flex; gap:6px; align-items:center;">
                <label class="checkbox_label" style="font-size:0.85em;">
                    <input type="checkbox" id="charMemory_logDrawerVerbose" />
                    <span>Verbose</span>
                </label>
                <button id="charMemory_logDrawerClear" class="menu_button" style="font-size:0.8em; padding:2px 8px;">Clear</button>
                <button id="charMemory_logDrawerSave" class="menu_button" style="font-size:0.8em; padding:2px 8px;">Save</button>
                <button id="charMemory_logDrawerClose" class="charMemory_drawerCloseBtn">✕</button>
            </div>
        </div>
        <div class="charMemory_drawerBody" id="charMemory_logDrawerBody">
            <!-- Log entries rendered here -->
        </div>
    </div>
`);
```

### Step 2: Add CSS for Log Drawer

Reuse the Injection Viewer drawer pattern but from the right side:

```css
.charMemory_logDrawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(380px, 45vw);
    height: 100%;
    background: var(--SmartThemeBlurTintColor);
    border-left: 1px solid var(--SmartThemeBorderColor);
    transform: translateX(100%);
    transition: transform 0.2s ease;
    z-index: 1001;
    display: flex;
    flex-direction: column;
}

.charMemory_logDrawer.open {
    transform: translateX(0);
}
```

Reuse existing `.charMemory_drawerHeader`, `.charMemory_drawerBody` patterns for consistent look.

### Step 3: Implement `toggleLogDrawer()`

Mirror `toggleInjectionDrawer()`:
- Toggle `.open` class
- Position below ST top bar
- Populate log entries from `logHistory` array
- Sync verbose toggle state

### Step 4: Implement `updateLogDrawer()`

Called from `logActivity()` — if the drawer is open, append the new log entry to the drawer body. Reuse the existing log entry rendering (`.charMemory_logEntry` with color classes).

### Step 5: Wire handlers

- Close button click → `toggleLogDrawer(false)`
- Clear button → clear log entries (same as existing `#charMemory_clearLog`)
- Save button → download log (same as existing `#charMemory_saveLog`)
- Verbose toggle → toggle verbose mode
- "View full log" link (will be added to sidebar in Task 5) → `toggleLogDrawer(true)`

### Step 6: Test manually

- Open log drawer → shows full activity log
- New extractions appear live in the drawer
- Verbose toggle works
- Clear and Save buttons work
- Drawer slides in/out smoothly

### Step 7: Commit

```bash
git add index.js style.css
git commit -m "feat: add Log Drawer (slide-out panel)

Full activity log in a slide-out drawer, same pattern as
Injection Viewer. Verbose toggle, clear, save buttons.
Will be triggered from sidebar dashboard."
```

---

## Task 4: Troubleshooter Modal

Build the Troubleshooter modal with automated health checks, Data Bank browser, diagnostic report export, and reset/clear actions.

**Files:**
- Modify: `index.js` (add `showTroubleshooter()`, Data Bank browser functions)
- Modify: `style.css` (add troubleshooter styles)

### Step 1: Implement `showTroubleshooter()`

Build modal HTML dynamically:

**Section 1: Health Checks**
- Run `computeHealthScore()` and display all checks with pass/fail icons
- Each failing check shows: explanation + [Fix] button where possible
- Reuse `renderHealthDiagnosticsCard()` output but with interactive fix buttons

**Section 2: Data Bank Browser**
- Call `getDataBankAttachmentsForSource()` to list character's files
- For each file show: name, size, whether it's a CharMemory file
- Action buttons: [View] [Export] [Delete] [Convert]
- [Import file] button at bottom

**Section 3: Diagnostic Report**
- "Copy diagnostic report" button
- Bundles: settings snapshot, last activity log entries, health check results, memory count, VS configuration, last injection data
- Copies to clipboard

**Section 4: Reset/Clear Actions**
- Reset Extraction State button (with confirmation)
- Clear All Memories button (with confirmation, danger styled)

Open via `callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true })`.

### Step 2: Implement Data Bank file actions

- **View**: Read file content via `getFileAttachment()`, show in a read-only popup. For CharMemory files, parse and highlight memory blocks.
- **Export**: Read file content, trigger browser download.
- **Delete**: Confirm dialog, then `deleteAttachment()`.
- **Convert**: Open the Convert tool with this file pre-selected.
- **Import**: File input → `uploadFileAttachment()`.

### Step 3: Implement diagnostic report builder

```javascript
function buildDiagnosticReport() {
    // Gather: settings, health checks, last log entries, memory count,
    // VS config, injection data, version info
    // Format as text block
    // Copy to clipboard via navigator.clipboard.writeText()
}
```

### Step 4: Add CSS for troubleshooter

```css
.charMemory_troubleshooter { /* scrollable modal content */ }
.charMemory_troubleshooterSection { /* bordered section with header */ }
.charMemory_dataBankItem { /* file row with actions */ }
.charMemory_dataBankActions { /* button row per file */ }
```

### Step 5: Test manually

- Open troubleshooter → health checks run and display
- Data Bank browser lists character's files
- View shows file content
- Export downloads the file
- Delete removes with confirmation
- Diagnostic report copies to clipboard
- Reset/Clear work with confirmation

### Step 6: Commit

```bash
git add index.js style.css
git commit -m "feat: add Troubleshooter modal

Health checks with fix buttons, Data Bank file browser
(view/export/delete/convert/import), diagnostic report
export, and reset/clear actions."
```

---

## Task 5: Sidebar Dashboard

The big migration — replace the 4-tab sidebar with a single-view dashboard. This task removes the tabs and restructures `settings.html` completely.

**Files:**
- Rewrite: `settings.html` (replace tabs with dashboard layout)
- Modify: `style.css` (add dashboard styles, can remove old tab styles)
- Modify: `index.js` (update `loadSettings()`, remove old tab switching, add dashboard controls)

### Step 1: Rewrite settings.html

Replace the entire tab structure with:

```html
<div class="charMemory_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>CharMemory</b>
            <button id="charMemory_settingsGear" class="charMemory_gearBtn" title="Settings">⚙</button>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <!-- Stats Bar (same as current, kept) -->
            <div class="charMemory_statsBar">...</div>

            <!-- File Section -->
            <div class="charMemory_dashSection">
                <div class="charMemory_fileInfo">
                    <span id="charMemory_dashFileName">Flux_the_Cat-memories.md</span>
                    <span id="charMemory_dashFileMeta" class="charMemory_dimText">42 KB • 11 chunks</span>
                </div>
                <div class="charMemory_buttonRow">
                    <button id="charMemory_manageMemories" class="menu_button">View / Edit</button>
                    <button id="charMemory_filesPopover" class="menu_button">Files ▾</button>
                </div>
            </div>

            <!-- Extraction Controls -->
            <div class="charMemory_dashSection">
                <label class="checkbox_label">
                    <input type="checkbox" id="charMemory_enabled" />
                    <span>Automatic extraction</span>
                </label>
                <button id="charMemory_extractNow" class="menu_button">Extract Now</button>
            </div>

            <!-- Tool Launchers -->
            <div class="charMemory_dashSection">
                <small class="charMemory_sectionLabel">Tools</small>
                <div class="charMemory_buttonRow">
                    <button id="charMemory_consolidate" class="menu_button">Consolidate</button>
                    <button id="charMemory_batchBtn" class="menu_button">Batch</button>
                    <button id="charMemory_convertBtn" class="menu_button">Convert</button>
                </div>
            </div>

            <!-- Activity (mini log) -->
            <div class="charMemory_dashSection">
                <small class="charMemory_sectionLabel">Activity</small>
                <div id="charMemory_dashActivity" class="charMemory_dashActivity">
                    <!-- Last 2-3 log entries -->
                </div>
                <a id="charMemory_viewFullLog" class="charMemory_link">View full log →</a>
            </div>

            <!-- Diagnostics summary -->
            <div class="charMemory_dashSection">
                <div class="charMemory_dashDiagHeader">
                    <small class="charMemory_sectionLabel">Diagnostics</small>
                    <button id="charMemory_refreshDiag" class="charMemory_miniBtn">Refresh</button>
                </div>
                <div id="charMemory_dashDiagSummary">✅ Healthy — 7/7 checks pass</div>
                <a id="charMemory_viewDiagDetails" class="charMemory_link">View details →</a>
            </div>

            <!-- Troubleshooter -->
            <div class="charMemory_dashSection">
                <button id="charMemory_troubleshooterBtn" class="menu_button charMemory_fullWidth">🔧 Help, it's not working</button>
            </div>

        </div>
    </div>
</div>
```

### Step 2: Update CSS

- Remove old tab styles (`.charMemory_tabs`, `.charMemory_tab`, `.charMemory_tabContent`, `.charMemory_toolPill`, `.charMemory_toolContent`)
- Add dashboard section styles:

```css
.charMemory_dashSection {
    padding: 6px 0;
    border-bottom: 1px solid var(--SmartThemeBorderColor);
}

.charMemory_dashSection:last-child {
    border-bottom: none;
}

.charMemory_sectionLabel {
    opacity: 0.6;
    font-size: 0.85em;
    display: block;
    margin-bottom: 4px;
}

.charMemory_dashActivity {
    max-height: 80px;
    overflow-y: auto;
    font-size: 0.85em;
}

.charMemory_link {
    font-size: 0.85em;
    cursor: pointer;
    color: var(--SmartThemeQuoteColor);
}

.charMemory_gearBtn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.1em;
    opacity: 0.7;
    padding: 0 4px;
}

.charMemory_gearBtn:hover {
    opacity: 1;
}

.charMemory_fullWidth {
    width: 100%;
}
```

### Step 3: Update index.js

- **Remove** old tab switching logic from `setupLogControls()` (the `.charMemory_tab` click handler)
- **Remove** tool pill switching from `setupToolControls()`
- **Update** `loadSettings()` to populate dashboard elements instead of tabs
- **Add** dashboard-specific handlers:
  - Gear icon → `showSettingsModal()`
  - View full log → `toggleLogDrawer(true)`
  - View details → `showTroubleshooter()`
  - Troubleshooter button → `showTroubleshooter()`
  - Files button → show Data Bank popover (or open Troubleshooter to Data Bank section)
  - Batch button → show batch extract dialog
  - Convert button → show convert tool dialog
- **Update** `logActivity()` to also update `#charMemory_dashActivity` with latest 3 entries
- **Update** `updateHealthIndicator()` to also update `#charMemory_dashDiagSummary`
- **Update** `updateDashboardFileInfo()` — new function to show active memory file name, size, chunk count

### Step 4: Update setupListeners() sub-functions

The 5 setup functions need adjustment:
- `setupConnectionControls()` — handlers move to Settings modal (remove from here, wire in `showSettingsModal()`)
- `setupExtractionControls()` — most handlers move to Settings modal. Keep the `#charMemory_enabled` toggle and `#charMemory_extractNow` for the dashboard.
- `setupToolControls()` — remove pill switching, keep tool button clicks
- `setupStorageControls()` — handlers move to Settings modal
- `setupLogControls()` — remove tab switching, keep log drawer triggers

### Step 5: Test manually (comprehensive)

This is the biggest visual change. Test everything:
- Dashboard loads with stats, file info, extraction controls, tool launchers, activity, diagnostics
- Gear icon opens Settings modal with all settings working
- Extract Now triggers extraction, activity updates live
- Tool buttons open their respective dialogs
- View full log opens Log Drawer
- View details opens Troubleshooter
- Troubleshooter button opens Troubleshooter
- Files button shows Data Bank files
- Health dot is clickable (opens Troubleshooter)
- No console errors

### Step 6: Commit

```bash
git add settings.html style.css index.js
git commit -m "feat: replace 4-tab sidebar with single-view dashboard

Remove tabs. Dashboard shows stats, file info, extraction toggle,
tool launchers, activity summary, diagnostics, and troubleshooter.
All settings moved to Settings modal (gear icon)."
```

---

## Task 6: Setup Wizard

Build the 3-step setup wizard modal with smart triggering.

**Files:**
- Modify: `index.js` (add `showSetupWizard()`, trigger logic, verification step)
- Modify: `style.css` (add wizard styles)

### Step 1: Implement `showSetupWizard(startStep)`

Build modal HTML dynamically with 3 steps:

**Step 1: LLM Connection**
- Explanation text
- Provider dropdown (Pollinations highlighted)
- API key field (hidden when not needed)
- Connect & Test button with inline status
- Model auto-selected, option to change
- [Next →]

**Step 2: Vector Storage**
- Explanation text
- Auto-detect VS configuration using `computeHealthScore()`
- Show passing checks (green) and issues (amber)
- [Fix] buttons where possible
- [← Back] [Next →]

**Step 3: Ready**
- Summary of configuration
- Explain what happens next
- [Get Started] closes wizard, stores `wizardCompleted: true`

Open via `callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true })`.

### Step 2: Add smart trigger logic

In the jQuery ready handler (after `loadSettings()`):

```javascript
// Full wizard: no provider configured
if (!extension_settings[MODULE_NAME].selectedProvider && !extension_settings[MODULE_NAME].wizardCompleted) {
    showSetupWizard(1);
}
```

For light nudge (health issues detected), add a banner div to the dashboard HTML:

```html
<div id="charMemory_nudgeBanner" class="charMemory_nudgeBanner" style="display:none;">
    <span>Something needs attention</span>
    <button id="charMemory_nudgeFix" class="menu_button">Fix now</button>
</div>
```

The banner is shown when `computeHealthScore()` returns non-green and `wizardCompleted` is true. Clicking [Fix now] opens the wizard to the relevant step.

### Step 3: Implement Step 4: Verification (post-first-extraction)

After the first successful extraction (in `extractMemories()` success path), check:
```javascript
if (!extension_settings[MODULE_NAME].verificationSeen) {
    showVerificationStep();
}
```

Show a modal explaining how to check retrieval quality, with links to the syringe icon and health check.

### Step 4: Add wizard styles

```css
.charMemory_wizard { /* wizard container */ }
.charMemory_wizardStep { /* step container, shown one at a time */ }
.charMemory_wizardNav { /* Back/Next buttons */ }
.charMemory_wizardExplanation { /* intro text styling */ }
.charMemory_wizardCheck { /* health check row */ }
.charMemory_nudgeBanner { /* attention banner in dashboard */ }
```

### Step 5: Add "Run Setup Wizard" link to Settings modal

In the Connection section of the Settings modal, add a link at the bottom:
```html
<a id="charMemory_runWizard" class="charMemory_link">Run Setup Wizard</a>
```

### Step 6: Test manually

- Fresh install (clear settings) → wizard auto-triggers
- Step 1: select provider → connect → success
- Step 2: VS checks run, issues flagged
- Step 3: summary → Get Started → wizard closes
- First extraction → verification step appears
- Light nudge banner appears when health issues exist

### Step 7: Commit

```bash
git add index.js style.css
git commit -m "feat: add Setup Wizard with smart triggering

3-step wizard (LLM Connection, Vector Storage, Ready).
Auto-triggers on first launch. Light nudge banner for
health issues. Post-extraction verification step."
```

---

## Task 7: Prompt Version Tracking

Add version tracking to prompts — notify users when defaults update, offer compare & edit.

**Files:**
- Modify: `index.js` (add `PROMPT_VERSIONS`, comparison logic, compare & edit UI)
- Modify: `style.css` (add update notification and compare styles)

### Step 1: Add PROMPT_VERSIONS constant

```javascript
const PROMPT_VERSIONS = {
    extraction: '2.0.0',
    groupExtraction: '2.0.0',
    consolidation: '2.0.0',
    conversion: '2.0.0',
};
```

### Step 2: Add version check on load

In `loadSettings()` or a new `checkPromptVersions()`:

```javascript
function checkPromptVersions() {
    const stored = extension_settings[MODULE_NAME].promptVersions || {};
    for (const [key, currentVersion] of Object.entries(PROMPT_VERSIONS)) {
        if (stored[key] && stored[key] !== currentVersion) {
            // User has a custom prompt based on an older version
            // Flag for notification in Prompts modal
        }
    }
}
```

### Step 3: Show update notification in Prompts modal

When a prompt has an update available, show a banner above the textarea:

```html
<div class="charMemory_promptUpdateBanner">
    The default prompt was updated in v2.0. Your custom version is unchanged.
    <button id="charMemory_promptKeepMine">Keep mine</button>
    <button id="charMemory_promptUseNew">Use new default</button>
    <button id="charMemory_promptCompare">Compare & Edit →</button>
</div>
```

### Step 4: Implement Compare & Edit view

Replace the single textarea with two panes:
- Left: user's current prompt (editable)
- Right: new default prompt (read-only reference)

Reuse the side-by-side pattern from the conversion dialog (`.charMemory_consolidationPanes`).

### Step 5: Test manually

- Modify a prompt to make it "custom"
- Change the PROMPT_VERSIONS to simulate an update
- Open Prompts modal → update notification appears
- Keep mine → dismisses notification, stores current version
- Use new default → replaces with default, stores current version
- Compare & Edit → shows side-by-side view

### Step 6: Commit

```bash
git add index.js style.css
git commit -m "feat: add prompt version tracking with compare & edit

Track prompt versions, notify when defaults update.
Keep mine / Use new default / Compare & Edit options."
```

---

## Task 8: Cleanup & Polish

Remove old code, update documentation, final verification.

**Files:**
- Modify: `settings.html` (remove any remaining old tab HTML if not already)
- Modify: `style.css` (remove old tab/pill styles)
- Modify: `index.js` (remove old tab/pill handler code)
- Modify: `CLAUDE.md` (update architecture docs)
- Modify: `CHANGELOG.md` (add v2.0 changelog)
- Modify: `manifest.json` (bump version to 2.0.0)

### Step 1: Remove dead CSS

Search for and remove styles that are no longer referenced:
- `.charMemory_tabs`, `.charMemory_tab`
- `.charMemory_tabContent`
- `.charMemory_toolPill`, `.charMemory_toolPills`, `.charMemory_toolContent`
- `.charMemory_miniLog` (replaced by dashboard activity)
- `.charMemory_bottomDiagnostics` (replaced by dashboard diagnostics + troubleshooter)

### Step 2: Remove dead JS

- Old tab switching handler in `setupLogControls()`
- Old pill switching handler in `setupToolControls()`
- Old mini-log visibility logic
- Any `loadSettings()` code that sets old tab/pill state

### Step 3: Update CLAUDE.md

Update the File Structure, Key Architecture, and Common Tasks sections to reflect:
- New file: `editor.js`
- Settings moved to modal
- Prompts moved to modal
- Log moved to drawer
- Sidebar is now a dashboard
- Setup wizard for first-run

### Step 4: Update CHANGELOG.md

Add v2.0.0 section covering all UX changes.

### Step 5: Bump version

```json
"version": "2.0.0"
```

### Step 6: Full regression test

Test every feature end-to-end:
1. Fresh install → wizard triggers
2. Provider setup → connect → model select
3. Extraction → memories created
4. Dashboard shows stats, activity, diagnostics
5. Settings modal → all sections work
6. Prompts modal → edit and save all 4 prompts
7. Log drawer → shows activity, verbose, clear, save
8. Troubleshooter → health checks, data bank browser, diagnostic report
9. Consolidation → preview dialog → save
10. Conversion → preview dialog → save
11. Batch extraction → select chats → run
12. Injection Viewer → syringe icon → drawer shows injected data
13. Memory Manager → view/edit/delete memories

### Step 7: Commit

```bash
git add -A
git commit -m "chore: v2.0.0 cleanup — remove old tab UI, update docs

Remove dead CSS/JS from old tab-based layout.
Update CLAUDE.md and CHANGELOG.md for v2.0."
```

---

## Summary

| Task | What | Risk | Depends on |
|------|------|------|------------|
| 1 | Settings Modal | Medium | — |
| 2 | Prompts Modal | Low | Task 1 |
| 3 | Log Drawer | Low | — |
| 4 | Troubleshooter | Medium | — |
| 5 | Sidebar Dashboard | **High** | Tasks 1-4 |
| 6 | Setup Wizard | Medium | Task 5 |
| 7 | Prompt Version Tracking | Low | Task 2 |
| 8 | Cleanup & Polish | Low | Tasks 1-7 |

**After all tasks:**
- Sidebar is a single-view dashboard (no tabs)
- All configuration in center-screen Settings modal with left-nav
- All prompts in dedicated Prompts modal with full-width editor
- Activity log in slide-out Log Drawer
- First-run Setup Wizard with smart triggering
- Troubleshooter with Data Bank browser and diagnostic report
- Prompt version tracking with compare & edit
- Zero features removed — everything reorganized for discoverability
