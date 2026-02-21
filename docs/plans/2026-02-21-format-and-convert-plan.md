# Memory Format Options & Data Bank Converter — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add configurable memory file chunking format, restructure tabs into Main|Tools|Settings|Log with pill sub-nav, and build a Convert/Import tool for existing Data Bank files.

**Architecture:** Three independent feature areas layered in dependency order: (1) Tab restructure (UI-only, no logic), (2) Format settings extending `serializeMemories()`, (3) Convert tool using heuristic + LLM parsing. All three files (`settings.html`, `style.css`, `index.js`) are modified. No new files created.

**Tech Stack:** jQuery (ST convention), SillyTavern extension APIs (`callGenericPopup`, `uploadFileAttachment`, `getFileAttachment`, `extension_settings`), existing `callLLM()` dispatch.

---

## Important Context

- **Single-file architecture**: All JS logic is in `index.js` (~4210 lines). No modules.
- **No automated tests**: Testing is manual in SillyTavern. Each task includes manual verification steps.
- **UI IDs prefixed**: All element IDs use `charMemory_` prefix (project convention).
- **Settings pattern**: Default values in `defaultSettings` (line 371), loaded via `loadSettings()` (line 838), bound to UI there, saved via `saveSettingsDebounced()`.
- **Tab pattern**: Top-level tabs use `.charMemory_tab[data-tab]` buttons + `.charMemory_tabContent` divs. Switching logic at line 3815.
- **Consolidation prompt pattern**: Disclosure accordion `<details>` with textarea + Restore Default button (see `settings.html` lines 65-71).

---

### Task 1: Tab Restructure — HTML

**Files:**
- Modify: `settings.html:29-100` (tab buttons and tab content wrappers)

**Step 1: Replace the top-level tab buttons**

In `settings.html`, replace the existing tab row (lines 30-36):

```html
<!-- Top-level tabs -->
<div class="charMemory_tabs">
    <button class="charMemory_tab active" data-tab="main">Main</button>
    <button class="charMemory_tab" data-tab="consolidate">Consolidate</button>
    <button class="charMemory_tab" data-tab="batch">Batch Extraction</button>
    <button class="charMemory_tab" data-tab="settings">Settings</button>
    <button class="charMemory_tab" data-tab="log">Log</button>
</div>
```

With:

```html
<!-- Top-level tabs -->
<div class="charMemory_tabs">
    <button class="charMemory_tab active" data-tab="main">Main</button>
    <button class="charMemory_tab" data-tab="tools">Tools</button>
    <button class="charMemory_tab" data-tab="settings">Settings</button>
    <button class="charMemory_tab" data-tab="log">Log</button>
</div>
```

**Step 2: Wrap Consolidate + Batch + Convert in a Tools tab container**

Replace the separate Consolidate tab div (`id="charMemory_tabConsolidate"`, lines 54-77) and Batch tab div (`id="charMemory_tabBatch"`, lines 80-100) with a single Tools tab wrapper containing pill sub-navigation:

```html
<!-- Tools tab -->
<div class="charMemory_tabContent" id="charMemory_tabTools" style="display:none;">
    <div class="charMemory_toolPills">
        <button class="charMemory_toolPill active" data-tool="consolidate">Consolidate</button>
        <button class="charMemory_toolPill" data-tool="batch">Batch</button>
        <button class="charMemory_toolPill" data-tool="convert">Convert</button>
    </div>

    <!-- Consolidate tool -->
    <div class="charMemory_toolContent" id="charMemory_toolConsolidate">
        <!-- EXISTING consolidate content unchanged (lines 55-76) -->
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

    <!-- Batch tool -->
    <div class="charMemory_toolContent" id="charMemory_toolBatch" style="display:none;">
        <!-- EXISTING batch content unchanged (lines 81-99) -->
        <div class="charMemory_buttonRow">
            <input type="button" id="charMemory_batchRefresh" class="menu_button" value="Refresh" title="Load chat list for this character" />
            <input type="button" id="charMemory_batchExtract" class="menu_button" value="Extract Selected" title="Run extraction on all selected chats" disabled />
            <input type="button" id="charMemory_batchStop" class="menu_button" value="Stop" title="Cancel batch extraction" style="display:none;" />
        </div>
        <div id="charMemory_batchProgress" class="charMemory_batchProgress" style="display:none;">
            <div class="charMemory_batchProgressText"></div>
            <div class="charMemory_batchProgressBar"><div class="charMemory_batchProgressFill"></div></div>
        </div>
        <div class="charMemory_sectionHeader">
            <small><b title="Chat files attached to this character. Select which ones to extract memories from.">Character Attachments</b></small>
            <label class="checkbox_label">
                <input type="checkbox" id="charMemory_batchSelectAll" />
                <small>Select all</small>
            </label>
        </div>
        <div id="charMemory_batchChatList" class="charMemory_batchChatList">
            <div class="charMemory_diagEmpty">Click "Refresh" to load chats.</div>
        </div>
    </div>

    <!-- Convert tool -->
    <div class="charMemory_toolContent" id="charMemory_toolConvert" style="display:none;">
        <div class="charMemory_statusRow">
            <label for="charMemory_convertSource">
                <small>Source file</small>
            </label>
            <select id="charMemory_convertSource" class="text_pole">
                <option value="">— Select a Data Bank file —</option>
            </select>
            <small class="charMemory_helperText">Select any file from this character's Data Bank to convert into CharMemory format.</small>
        </div>

        <div class="charMemory_statusRow">
            <label class="checkbox_label" for="charMemory_convertUseLLM">
                <input type="checkbox" id="charMemory_convertUseLLM" />
                <span>Use LLM to restructure (for freeform text)</span>
            </label>
            <small class="charMemory_helperText">When the file has no clear structure, send it to the LLM for intelligent restructuring. Uses your configured extraction provider.</small>
            <details class="charMemory_promptDisclosure" id="charMemory_convertPromptDisclosure">
                <summary><small>Show prompt</small></summary>
                <textarea id="charMemory_convertPrompt" class="text_pole textarea_compact" rows="6" placeholder="Conversion prompt..."></textarea>
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_restoreConvertPrompt" class="menu_button" value="Restore Default" title="Reset conversion prompt to built-in default" />
                </div>
            </details>
        </div>

        <div class="charMemory_buttonRow">
            <input type="button" id="charMemory_convertPreview" class="menu_button" value="Preview Conversion" title="Parse the selected file and show a before/after preview" />
        </div>

        <div id="charMemory_convertPreviewArea" style="display:none;">
            <div class="charMemory_convertMeta">
                <small><b>Detected format:</b> <span id="charMemory_convertFormat">—</span></small>
                <small><b>Parse method:</b> <span id="charMemory_convertMethod">—</span></small>
                <small><b>Result:</b> <span id="charMemory_convertResultCount">—</span></small>
            </div>
            <div class="charMemory_convertColumns">
                <div class="charMemory_convertColumn">
                    <small><b>Before</b></small>
                    <div id="charMemory_convertBefore" class="charMemory_convertBox"></div>
                </div>
                <div class="charMemory_convertColumn">
                    <small><b>After</b></small>
                    <div id="charMemory_convertAfter" class="charMemory_convertBox"></div>
                </div>
            </div>
            <div class="charMemory_convertWarning">
                <i class="fa-solid fa-triangle-exclamation fa-sm"></i>
                The original file will <b>not</b> be deleted. Hide or remove it from the Data Bank to avoid duplicate memories.
            </div>
            <div class="charMemory_statusRow">
                <small><b>Output to:</b></small>
                <label class="radio_label">
                    <input type="radio" name="charMemory_convertDest" value="auto" checked />
                    <span>CharMemory file (<span id="charMemory_convertAutoName">—</span>)</span>
                </label>
                <label class="radio_label">
                    <input type="radio" name="charMemory_convertDest" value="custom" />
                    <span>Custom filename:</span>
                    <input type="text" id="charMemory_convertCustomName" class="text_pole" placeholder="my-memories.md" style="flex:1;" disabled />
                </label>
            </div>
            <div class="charMemory_buttonRow">
                <input type="button" id="charMemory_convertExecute" class="menu_button" value="Convert" title="Write converted memories to the chosen destination" />
                <input type="button" id="charMemory_convertCancel" class="menu_button" value="Cancel" title="Discard preview and start over" />
            </div>
        </div>
    </div>
</div>
```

**Step 3: Verify the HTML renders**

Manually: Restart SillyTavern, open the extension panel. Confirm:
- 4 top-level tabs: Main, Tools, Settings, Log
- Tools tab shows 3 pill buttons: Consolidate, Batch, Convert
- Consolidate pill shows existing consolidation UI
- Batch pill shows existing batch UI
- Convert pill shows the new convert form (empty dropdown, preview button)

**Step 4: Commit**

```bash
git add settings.html
git commit -m "refactor: restructure tabs into Main|Tools|Settings|Log with pill sub-nav"
```

---

### Task 2: Tab Restructure — CSS

**Files:**
- Modify: `style.css` (add pill button styles after line 161)

**Step 1: Add pill button styles**

After the existing `.charMemory_tab.active` rule (line 161), add:

```css
/* Tool pill sub-navigation */
.charMemory_toolPills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
}

.charMemory_toolPill {
    padding: 3px 10px;
    font-size: 0.8em;
    background: var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.15));
    border: 1px solid transparent;
    border-radius: 12px;
    cursor: pointer;
    opacity: 0.6;
    color: var(--SmartThemeBodyColor, #ccc);
    transition: opacity 0.15s, background 0.15s;
}

.charMemory_toolPill:hover {
    opacity: 0.85;
}

.charMemory_toolPill.active {
    opacity: 1;
    background: var(--SmartThemeQuoteColor, rgba(128, 128, 128, 0.3));
    border-color: var(--SmartThemeQuoteColor, #888);
}
```

**Step 2: Add Convert tool styles**

Append to end of `style.css`:

```css
/* Convert tool */
.charMemory_convertMeta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 8px;
    padding: 6px 8px;
    background: var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.1));
    border-radius: 4px;
    font-size: 0.85em;
}

.charMemory_convertColumns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 8px;
}

.charMemory_convertBox {
    max-height: 200px;
    overflow-y: auto;
    padding: 6px 8px;
    font-size: 0.8em;
    font-family: monospace;
    white-space: pre-wrap;
    background: var(--black30, rgba(0, 0, 0, 0.15));
    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
}

.charMemory_convertWarning {
    padding: 6px 8px;
    margin-bottom: 8px;
    font-size: 0.85em;
    color: var(--SmartThemeQuoteColor, #e8a33d);
    background: rgba(232, 163, 61, 0.1);
    border-radius: 4px;
}
```

**Step 3: Verify styling**

Manually: Reload SillyTavern. Confirm pill buttons look visually subordinate to top-level tabs (smaller, rounded, different style). Confirm Convert preview area has proper columns and warning styling.

**Step 4: Commit**

```bash
git add style.css
git commit -m "style: add pill sub-nav and convert tool styles"
```

---

### Task 3: Tab Restructure — JS Event Handlers

**Files:**
- Modify: `index.js:3815-3823` (tab switching logic in `setupListeners()`)

**Step 1: Update tab switching logic**

Replace the existing tab click handler at line 3815:

```js
// Tab switching for top-level panel tabs
$('.charMemory_tab').off('click').on('click', function () {
    const tab = $(this).data('tab');
    $('.charMemory_tab').removeClass('active');
    $(this).addClass('active');
    $('.charMemory_tabContent').hide();
    const capName = tab.charAt(0).toUpperCase() + tab.slice(1);
    $(`#charMemory_tab${capName}`).show();
    if (tab === 'batch') loadBatchChatList();
});
```

With:

```js
// Tab switching for top-level panel tabs
$('.charMemory_tab').off('click').on('click', function () {
    const tab = $(this).data('tab');
    $('.charMemory_tab').removeClass('active');
    $(this).addClass('active');
    $('.charMemory_tabContent').hide();
    const capName = tab.charAt(0).toUpperCase() + tab.slice(1);
    $(`#charMemory_tab${capName}`).show();
    // Auto-load batch list when switching to Tools tab with Batch pill active
    if (tab === 'tools' && $('.charMemory_toolPill.active').data('tool') === 'batch') {
        loadBatchChatList();
    }
});

// Pill switching within Tools tab
$('.charMemory_toolPill').off('click').on('click', function () {
    const tool = $(this).data('tool');
    $('.charMemory_toolPill').removeClass('active');
    $(this).addClass('active');
    $('.charMemory_toolContent').hide();
    $(`#charMemory_tool${tool.charAt(0).toUpperCase() + tool.slice(1)}`).show();
    if (tool === 'batch') loadBatchChatList();
    if (tool === 'convert') populateConvertSourceDropdown();
});
```

**Step 2: Add a stub `populateConvertSourceDropdown()` function**

Add near the other UI helper functions (after `populateProviderDropdown`, around line 610):

```js
/**
 * Populate the Convert tool's source file dropdown with Data Bank files.
 */
function populateConvertSourceDropdown() {
    const $select = $('#charMemory_convertSource');
    $select.find('option:not(:first)').remove();

    const context = getContext();
    if (!context.characterId && context.characterId !== 0) return;

    const avatar = characters[context.characterId]?.avatar;
    if (!avatar) return;

    ensureCharacterAttachments(avatar);
    const attachments = extension_settings.character_attachments[avatar] || [];
    const charName = getCharacterName();
    const memoryFileName = getMemoryFileNameForCharacter(charName, avatar);

    for (const att of attachments) {
        // Skip the active CharMemory file
        if (att.name === memoryFileName) continue;
        const $opt = $(`<option></option>`).val(att.url).text(att.name || att.url);
        $select.append($opt);
    }

    // Show auto-name in output destination
    $('#charMemory_convertAutoName').text(memoryFileName);
}
```

Note: `getMemoryFileNameForCharacter` is the variant of `getMemoryFileName` that takes explicit args. Check if this exists — if not, use `getMemoryFileName()` directly. Look at line 1155 (`getMemoryFileNameForCharacter`).

**Step 3: Verify tab and pill switching works**

Manually: Restart SillyTavern. Confirm:
- Clicking Tools tab shows Tools content with pill sub-nav
- Clicking each pill shows the correct sub-content
- Clicking Batch pill triggers `loadBatchChatList()`
- Clicking Convert pill populates the source dropdown
- All other tabs (Main, Settings, Log) still work

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat: wire up Tools tab pill switching and convert dropdown"
```

---

### Task 4: Memory File Format — Settings & Defaults

**Files:**
- Modify: `index.js:371-397` (defaultSettings)
- Modify: `index.js:904-928` (loadSettings UI bindings)
- Modify: `settings.html` (add format section to Settings tab)

**Step 1: Add default settings**

In `defaultSettings` (line 371), add before the closing `}`:

```js
    chunkBoundary: 'block',        // 'block' | 'bullet' | 'custom'
    customSeparator: '\\n\\n',
    chunkMetadata: false,
    conversionPrompt: '',
```

**Step 2: Add HTML for format settings**

In `settings.html`, inside the Settings tab content (`#charMemory_tabSettings`), after the "Extraction Settings" section (after the `mergeChunks` checkbox and helper text, around line 237) and before the "Storage" `<hr>` at line 239, add:

```html
                <!-- Memory File Format (advanced) -->
                <hr class="charMemory_separator" />
                <small><b>Memory File Format</b></small>

                <div class="charMemory_statusRow">
                    <label for="charMemory_chunkBoundary" title="Controls how memories are separated in the Data Bank file. Vector Storage splits on the separator to create individual retrievable chunks.">
                        <small>Chunk boundary</small>
                    </label>
                    <select id="charMemory_chunkBoundary" class="text_pole">
                        <option value="block">Block-level (default)</option>
                        <option value="bullet">Bullet-level</option>
                        <option value="custom">Custom</option>
                    </select>
                    <small class="charMemory_helperText">Controls how memories are separated in the file. Vector Storage splits on the separator to create retrievable chunks.</small>
                </div>

                <div class="charMemory_statusRow" id="charMemory_customSeparatorRow" style="display:none;">
                    <label for="charMemory_customSeparator" title="Characters inserted between chunks. Use \\n for newlines.">
                        <small>Custom separator</small>
                    </label>
                    <input type="text" id="charMemory_customSeparator" class="text_pole" placeholder="\\n\\n" />
                    <small class="charMemory_helperText">Characters inserted between chunks. Use \n for newlines. Default: \n\n (blank line).</small>
                </div>

                <div id="charMemory_chunkMetadataRow" style="display:none;">
                    <label class="checkbox_label" for="charMemory_chunkMetadata" title="When using bullet-level chunking, prefix each bullet with its date and chat ID so standalone bullets retain their context.">
                        <input type="checkbox" id="charMemory_chunkMetadata" />
                        <span>Include metadata in chunks</span>
                    </label>
                    <small class="charMemory_helperText">Prefix each bullet with [date | chat_id] so standalone chunks retain their provenance.</small>
                </div>
```

**Step 3: Bind UI in `loadSettings()`**

After the existing UI bindings (around line 922), add:

```js
    $('#charMemory_chunkBoundary').val(extension_settings[MODULE_NAME].chunkBoundary || 'block');
    $('#charMemory_customSeparator').val(extension_settings[MODULE_NAME].customSeparator || '\\n\\n');
    $('#charMemory_chunkMetadata').prop('checked', !!extension_settings[MODULE_NAME].chunkMetadata);
    toggleChunkBoundaryUI(extension_settings[MODULE_NAME].chunkBoundary || 'block');
    $('#charMemory_convertPrompt').val(extension_settings[MODULE_NAME].conversionPrompt || defaultConversionPrompt);
```

**Step 4: Add event handlers in `setupListeners()`**

Add in `setupListeners()`:

```js
    // Chunk boundary format controls
    $('#charMemory_chunkBoundary').off('change').on('change', async function () {
        const val = $(this).val();
        extension_settings[MODULE_NAME].chunkBoundary = val;
        saveSettingsDebounced();
        toggleChunkBoundaryUI(val);
        await offerReformat();
    });

    $('#charMemory_customSeparator').off('input').on('input', function () {
        extension_settings[MODULE_NAME].customSeparator = $(this).val();
        saveSettingsDebounced();
    });

    $('#charMemory_chunkMetadata').off('change').on('change', function () {
        extension_settings[MODULE_NAME].chunkMetadata = $(this).prop('checked');
        saveSettingsDebounced();
    });
```

**Step 5: Add `toggleChunkBoundaryUI()` helper**

```js
function toggleChunkBoundaryUI(value) {
    $('#charMemory_customSeparatorRow').toggle(value === 'custom');
    $('#charMemory_chunkMetadataRow').toggle(value === 'bullet' || value === 'custom');
}
```

**Step 6: Verify settings persist**

Manually: Change chunk boundary to Bullet-level, reload SillyTavern. Confirm dropdown still shows Bullet-level. Confirm custom separator and metadata rows show/hide correctly.

**Step 7: Commit**

```bash
git add index.js settings.html
git commit -m "feat: add chunk boundary format settings UI and persistence"
```

---

### Task 5: Memory File Format — Extend `serializeMemories()`

**Files:**
- Modify: `index.js:480-484` (serializeMemories function)

**Step 1: Add `getFormatOptions()` helper**

Add before `serializeMemories()`:

```js
/**
 * Get the current memory format options from settings.
 * @returns {{boundary: string, separator: string, metadata: boolean}}
 */
function getFormatOptions() {
    const s = extension_settings[MODULE_NAME] || {};
    const boundary = s.chunkBoundary || 'block';
    let separator = '\n\n';
    if (boundary === 'custom' && s.customSeparator) {
        separator = s.customSeparator.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return { boundary, separator, metadata: !!s.chunkMetadata };
}
```

**Step 2: Modify `serializeMemories()`**

Replace the current function (lines 480-484):

```js
function serializeMemories(blocks) {
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
        return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
    }).join('\n\n');
}
```

With:

```js
function serializeMemories(blocks, formatOverride) {
    const fmt = formatOverride || getFormatOptions();

    if (fmt.boundary === 'block' || fmt.boundary === 'custom' && fmt.separator === '\n\n' && !fmt.metadata) {
        // Default block-level: unchanged behavior
        return blocks.map(b => {
            const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
            return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
        }).join(fmt.boundary === 'custom' ? fmt.separator : '\n\n');
    }

    if (fmt.boundary === 'bullet') {
        // Bullet-level: each bullet separated by \n\n (or custom separator)
        const sep = fmt.separator || '\n\n';
        const allBullets = [];
        for (const b of blocks) {
            for (const bullet of b.bullets) {
                if (fmt.metadata) {
                    allBullets.push(`[${b.date} | ${b.chat}] - ${bullet}`);
                } else {
                    allBullets.push(`- ${bullet}`);
                }
            }
        }
        return allBullets.join(sep);
    }

    // Custom boundary (block-level with custom separator and optional metadata)
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => {
            if (fmt.metadata) {
                return `[${b.date} | ${b.chat}] - ${bullet}`;
            }
            return `- ${bullet}`;
        }).join('\n');
        return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
    }).join(fmt.separator);
}
```

**Step 3: Verify serialization**

Manually: Set format to Bullet-level. Run Extract Now. Open the memory file in Data Bank and confirm each bullet is separated by `\n\n`. Switch back to Block-level. Run another extraction. Confirm the old format returns.

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat: serializeMemories respects chunk boundary format settings"
```

---

### Task 6: Memory File Format — Reformat Offer on Change

**Files:**
- Modify: `index.js` (add `offerReformat()` and `reformatExistingMemories()`)

**Step 1: Add `reformatExistingMemories()`**

Add after `serializeMemories()`:

```js
/**
 * Re-read, re-parse, and re-serialize the current memory file with the active format settings.
 * @param {string} avatar Character avatar filename.
 * @param {string} fileName Memory filename.
 * @returns {Promise<{blocks: number, bullets: number}|null>} Counts, or null if no file found.
 */
async function reformatExistingMemories(avatar, fileName) {
    const content = await readMemoriesForCharacter(avatar, fileName);
    if (!content || !content.trim()) return null;

    const blocks = parseMemories(content);
    if (blocks.length === 0) return null;

    const reformatted = serializeMemories(blocks);
    await writeMemoriesForCharacter(reformatted, avatar, fileName);
    logActivity(`Reformatted ${countMemories(blocks)} memories in ${blocks.length} blocks to ${extension_settings[MODULE_NAME].chunkBoundary} format`);
    return { blocks: blocks.length, bullets: countMemories(blocks) };
}
```

**Step 2: Add `offerReformat()`**

```js
/**
 * After a format setting change, offer to reformat existing memory files.
 */
async function offerReformat() {
    const targets = getMemoryTargets();
    if (targets.length === 0) return;

    // Count total memories across all targets
    let totalBullets = 0;
    let totalBlocks = 0;
    for (const target of targets) {
        const content = await readMemoriesForCharacter(target.avatar, target.fileName);
        if (content && content.trim()) {
            const blocks = parseMemories(content);
            totalBlocks += blocks.length;
            totalBullets += countMemories(blocks);
        }
    }

    if (totalBullets === 0) return;

    const result = await callGenericPopup(
        `Reformat existing memories to match the new format?\n\nThis will rewrite ${totalBullets} memories in ${totalBlocks} blocks.`,
        POPUP_TYPE.CONFIRM,
    );

    if (result) {
        for (const target of targets) {
            await reformatExistingMemories(target.avatar, target.fileName);
        }
        toastr.success(`Reformatted ${totalBullets} memories.`, 'CharMemory');
        updateStatusDisplay();
    }
}
```

**Step 3: Verify the reformat offer**

Manually: Have a character with existing memories. Change chunk boundary from Block-level to Bullet-level. Confirm popup appears with correct counts. Click Reformat. Open the Data Bank file and confirm the format changed. Click Skip instead — confirm the file is unchanged.

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat: offer to reformat existing memories when chunk format changes"
```

---

### Task 7: Convert Tool — Heuristic Parser

**Files:**
- Modify: `index.js` (add `detectFileFormat()` and `convertHeuristic()`)

**Step 1: Add the default conversion prompt constant**

Add near the other prompt constants (after `defaultGroupExtractionPrompt`, around line 240):

```js
const defaultConversionPrompt = `You are converting a text file into a structured memory format for {{charName}}.

The input contains facts, memories, or notes in an unstructured format. Your task is to restructure this into clean, organized memory blocks.

Rules:
1. Extract every distinct fact or piece of information as a bullet point starting with "- ".
2. Group related facts into <memory chat="[Topic Name]" date="[today]"> blocks where Topic Name is a short descriptive label (e.g. "Appearance", "Relationships", "Key Events").
3. Preserve ALL information — do not summarize, combine, or omit anything from the source.
4. Do not add facts, inferences, or details not explicitly stated in the source.
5. Clean up grammar and formatting, but do not change the meaning.
6. Skip formatting artifacts, HTML tags, and metadata that aren't actual memories.

Source text to restructure:
{{sourceText}}`;
```

**Step 2: Add `detectFileFormat()`**

```js
/**
 * Detect the format of a Data Bank file's content.
 * @param {string} content Raw file content.
 * @returns {'memory_tags'|'memory_headings'|'bullets'|'numbered'|'markdown_headings'|'freeform'}
 */
function detectFileFormat(content) {
    if (!content || !content.trim()) return 'freeform';
    if (/<memory\b[^>]*>/i.test(content)) return 'memory_tags';
    if (/^## Memory \d+/m.test(content)) return 'memory_headings';
    // Count lines starting with "- " — if majority are bullets, it's bullet format
    const lines = content.split('\n').filter(l => l.trim());
    const bulletLines = lines.filter(l => /^\s*- /.test(l));
    if (bulletLines.length > lines.length * 0.4) return 'bullets';
    const numberedLines = lines.filter(l => /^\s*\d+[\.\)]\s/.test(l));
    if (numberedLines.length > lines.length * 0.3) return 'numbered';
    if (/^#{1,3}\s+.+/m.test(content)) return 'markdown_headings';
    return 'freeform';
}
```

**Step 3: Add `convertHeuristic()`**

```js
/**
 * Convert file content to <memory> tag format using heuristic parsing.
 * @param {string} content Raw file content.
 * @param {string} format Detected format from detectFileFormat().
 * @returns {{blocks: {chat: string, date: string, bullets: string[]}[], warnings: string[]}}
 */
function convertHeuristic(content, format) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const warnings = [];

    if (format === 'memory_tags') {
        warnings.push('Already in CharMemory format — no conversion needed.');
        return { blocks: parseMemories(content), warnings };
    }

    if (format === 'memory_headings') {
        const migrated = migrateMemoriesIfNeeded(content);
        return { blocks: parseMemories(migrated), warnings };
    }

    if (format === 'bullets') {
        const lines = content.split('\n');
        const bullets = [];
        for (const line of lines) {
            const match = line.match(/^\s*[-*]\s+(.+)/);
            if (match) bullets.push(match[1].trim());
        }
        return {
            blocks: [{ chat: 'imported', date: today, bullets }],
            warnings,
        };
    }

    if (format === 'numbered') {
        const lines = content.split('\n');
        const bullets = [];
        for (const line of lines) {
            const match = line.match(/^\s*\d+[\.\)]\s+(.+)/);
            if (match) bullets.push(match[1].trim());
        }
        return {
            blocks: [{ chat: 'imported', date: today, bullets }],
            warnings,
        };
    }

    if (format === 'markdown_headings') {
        const blocks = [];
        let currentHeading = 'imported';
        let currentBullets = [];
        for (const line of content.split('\n')) {
            const headingMatch = line.match(/^#{1,3}\s+(.+)/);
            if (headingMatch) {
                if (currentBullets.length > 0) {
                    blocks.push({ chat: currentHeading, date: today, bullets: currentBullets });
                    currentBullets = [];
                }
                currentHeading = headingMatch[1].trim();
                continue;
            }
            const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
            if (bulletMatch) {
                currentBullets.push(bulletMatch[1].trim());
            } else if (line.trim()) {
                // Non-bullet non-heading line — treat as a bullet
                currentBullets.push(line.trim());
            }
        }
        if (currentBullets.length > 0) {
            blocks.push({ chat: currentHeading, date: today, bullets: currentBullets });
        }
        return { blocks, warnings };
    }

    // Freeform: split on sentences, warn that LLM may do better
    const sentences = content.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    if (sentences.length === 0) {
        warnings.push('File appears empty.');
        return { blocks: [], warnings };
    }
    warnings.push('Freeform text detected — results may be rough. Consider using LLM restructuring for better quality.');
    return {
        blocks: [{ chat: 'imported', date: today, bullets: sentences }],
        warnings,
    };
}
```

**Step 4: Verify heuristic detection**

Manually: Prepare a test Data Bank file with bullet content. Run `detectFileFormat()` from console. Confirm it returns `'bullets'`. Test with a numbered list file. Test with freeform paragraphs.

**Step 5: Commit**

```bash
git add index.js
git commit -m "feat: add heuristic file format detection and conversion"
```

---

### Task 8: Convert Tool — LLM Conversion

**Files:**
- Modify: `index.js` (add `convertWithLLM()`)

**Step 1: Add `convertWithLLM()`**

```js
/**
 * Convert file content to <memory> tag format using LLM.
 * @param {string} content Raw file content.
 * @param {string} charName Character name for prompt.
 * @returns {Promise<{blocks: {chat: string, date: string, bullets: string[]}[], warnings: string[]}>}
 */
async function convertWithLLM(content, charName) {
    const warnings = [];
    const prompt = (extension_settings[MODULE_NAME].conversionPrompt || defaultConversionPrompt)
        .replace(/\{\{charName\}\}/g, charName)
        .replace(/\{\{sourceText\}\}/g, content);

    const response = await callLLM(prompt, extension_settings[MODULE_NAME].responseLength || 2000, 'You are a text restructuring assistant. Preserve all information faithfully.');

    if (!response || !response.trim()) {
        warnings.push('LLM returned an empty response.');
        return { blocks: [], warnings };
    }

    const blocks = parseMemories(response);
    if (blocks.length === 0) {
        // LLM may have returned plain bullets without <memory> tags — wrap them
        const lines = response.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
        if (lines.length > 0) {
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            return {
                blocks: [{ chat: 'imported', date: today, bullets: lines.map(l => l.slice(2).trim()) }],
                warnings: ['LLM did not use <memory> tags — bullets wrapped automatically.'],
            };
        }
        warnings.push('LLM response could not be parsed into memories.');
    }

    return { blocks, warnings };
}
```

**Step 2: Verify LLM conversion**

Manually: Create a Data Bank file with freeform text. In Convert tool, check "Use LLM to restructure". Click Preview. Confirm the LLM is called and results appear in the After panel.

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add LLM-assisted conversion for freeform Data Bank files"
```

---

### Task 9: Convert Tool — Wire Up UI Events

**Files:**
- Modify: `index.js` (add event handlers in `setupListeners()` and preview/execute logic)

**Step 1: Add convert event handlers in `setupListeners()`**

```js
    // Convert tool
    $('#charMemory_convertPreview').off('click').on('click', () => previewConversion());
    $('#charMemory_convertExecute').off('click').on('click', () => executeConversion());
    $('#charMemory_convertCancel').off('click').on('click', () => {
        $('#charMemory_convertPreviewArea').hide();
        convertPreviewResult = null;
    });
    $('#charMemory_restoreConvertPrompt').off('click').on('click', () => {
        $('#charMemory_convertPrompt').val(defaultConversionPrompt);
        extension_settings[MODULE_NAME].conversionPrompt = '';
        saveSettingsDebounced();
    });
    $('#charMemory_convertPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].conversionPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('input[name="charMemory_convertDest"]').off('change').on('change', function () {
        $('#charMemory_convertCustomName').prop('disabled', $(this).val() !== 'custom');
    });
```

**Step 2: Add module-level state for convert preview**

Near the other module-level state variables (around line 57):

```js
let convertPreviewResult = null; // { blocks, warnings, sourceContent }
```

**Step 3: Add `previewConversion()`**

```js
/**
 * Parse the selected source file and show before/after preview.
 */
async function previewConversion() {
    const fileUrl = $('#charMemory_convertSource').val();
    if (!fileUrl) {
        toastr.warning('Select a source file first.', 'CharMemory');
        return;
    }

    const sourceContent = await getFileAttachment(fileUrl);
    if (!sourceContent) {
        toastr.error('Could not read the selected file.', 'CharMemory');
        return;
    }

    const format = detectFileFormat(sourceContent);
    const formatLabels = {
        memory_tags: 'CharMemory <memory> tags',
        memory_headings: 'Old CharMemory (## Memory N)',
        bullets: 'Bullet list',
        numbered: 'Numbered list',
        markdown_headings: 'Markdown with headings',
        freeform: 'Freeform text',
    };

    const useLLM = $('#charMemory_convertUseLLM').prop('checked');
    let result;

    if (useLLM && format !== 'memory_tags') {
        const charName = getCharacterName() || 'Character';
        toastr.info('Sending to LLM for restructuring...', 'CharMemory', { timeOut: 3000 });
        result = await convertWithLLM(sourceContent, charName);
    } else {
        result = convertHeuristic(sourceContent, format);
    }

    convertPreviewResult = { ...result, sourceContent };

    // Populate preview UI
    $('#charMemory_convertFormat').text(formatLabels[format] || format);
    $('#charMemory_convertMethod').text(useLLM && format !== 'memory_tags' ? 'LLM' : 'Heuristic');
    $('#charMemory_convertResultCount').text(`${countMemories(result.blocks)} memories in ${result.blocks.length} block(s)`);

    const beforeText = sourceContent.length > 1500 ? sourceContent.substring(0, 1500) + '\n...(truncated)' : sourceContent;
    const afterText = serializeMemories(result.blocks);
    const afterTruncated = afterText.length > 1500 ? afterText.substring(0, 1500) + '\n...(truncated)' : afterText;

    $('#charMemory_convertBefore').text(beforeText);
    $('#charMemory_convertAfter').text(afterTruncated);
    $('#charMemory_convertPreviewArea').show();

    for (const w of result.warnings) {
        toastr.warning(w, 'CharMemory');
    }

    if (format === 'memory_tags') {
        $('#charMemory_convertExecute').prop('disabled', true);
    } else {
        $('#charMemory_convertExecute').prop('disabled', false);
    }
}
```

**Step 4: Add `executeConversion()`**

```js
/**
 * Write converted memories to the chosen destination.
 */
async function executeConversion() {
    if (!convertPreviewResult || convertPreviewResult.blocks.length === 0) {
        toastr.warning('No memories to convert. Run Preview first.', 'CharMemory');
        return;
    }

    const context = getContext();
    const avatar = characters[context.characterId]?.avatar;
    if (!avatar) {
        toastr.error('No character selected.', 'CharMemory');
        return;
    }

    const destType = $('input[name="charMemory_convertDest"]:checked').val();
    let destFileName;
    if (destType === 'custom') {
        destFileName = $('#charMemory_convertCustomName').val().trim();
        if (!destFileName) {
            toastr.warning('Enter a filename for custom output.', 'CharMemory');
            return;
        }
    } else {
        const charName = getCharacterName();
        destFileName = getMemoryFileNameForCharacter(charName, avatar);
    }

    // If destination file already exists, append
    const existingContent = await readMemoriesForCharacter(avatar, destFileName);
    let existingBlocks = [];
    if (existingContent && existingContent.trim()) {
        existingBlocks = parseMemories(existingContent);
    }

    const allBlocks = [...existingBlocks, ...convertPreviewResult.blocks];
    await writeMemoriesForCharacter(serializeMemories(allBlocks), avatar, destFileName);

    const count = countMemories(convertPreviewResult.blocks);
    toastr.success(`Converted ${count} memories to ${destFileName}. Remember to hide or remove the original file from Data Bank to avoid duplicates.`, 'CharMemory', { timeOut: 8000 });
    logActivity(`Converted ${count} memories from Data Bank file to ${destFileName}`);

    // Reset preview
    $('#charMemory_convertPreviewArea').hide();
    convertPreviewResult = null;
    updateStatusDisplay();
}
```

Note: `getMemoryFileNameForCharacter` — verify this exists at line 1155. If it doesn't exist by that name, check what function provides the same capability with explicit character args. It may just be `getMemoryFileName()` since that reads from the current context. If needed, call `getMemoryFileName()` directly — it already uses current context.

**Step 5: Verify full convert flow**

Manually:
1. Create a test character with a freeform Data Bank file
2. Go to Tools > Convert
3. Select the file from dropdown
4. Click Preview — confirm before/after appears
5. Click Convert — confirm file is created
6. Check Data Bank — original file still exists, new file has converted content

**Step 6: Commit**

```bash
git add index.js
git commit -m "feat: wire up convert tool preview and execute flow"
```

---

### Task 10: Final Integration & Manual Testing

**Files:**
- Possibly all three files for minor fixes

**Step 1: End-to-end test — Tab restructure**

1. Open SillyTavern with a character loaded
2. Confirm Main tab works (Extract Now, View/Edit)
3. Click Tools — confirm pill sub-nav appears
4. Click each pill — confirm Consolidate, Batch, Convert content shows
5. Click Settings — confirm all settings including new Format section
6. Click Log — confirm activity log works

**Step 2: End-to-end test — Format settings**

1. Extract memories with Block-level (default) — verify file format unchanged
2. Switch to Bullet-level — accept Reformat
3. Open Data Bank file — confirm each bullet is separated by \n\n
4. Check "Include metadata in chunks" — reformat again — confirm `[date | chat]` prefix
5. Switch to Custom with separator `---\n\n` — verify custom separator appears in file
6. Switch back to Block-level — accept Reformat — verify `<memory>` block format returns

**Step 3: End-to-end test — Convert tool**

1. Upload a file with plain bullet points to a character's Data Bank
2. Tools > Convert > select the file > Preview — confirm heuristic detection
3. Convert — confirm output appears in CharMemory file
4. Upload a freeform paragraph file
5. Preview (heuristic) — confirm freeform warning
6. Check "Use LLM" > Preview — confirm LLM restructuring
7. Convert — confirm append to existing CharMemory file

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes from end-to-end testing"
```

---

## Dependency Graph

```
Task 1 (HTML) ──┐
Task 2 (CSS)  ──┼── Task 3 (JS tab events) ── Task 4 (Format settings) ── Task 5 (serializeMemories)
                │                                                             │
                │                                                             ├── Task 6 (Reformat offer)
                │                                                             │
                └── Task 7 (Heuristic parser) ── Task 8 (LLM conversion) ── Task 9 (Convert UI wiring)
                                                                               │
                                                                         Task 10 (Integration testing)
```

Tasks 1+2 can be done in parallel. Tasks 7+8 depend on Task 3 (for the convert UI to exist) but are independent of Tasks 4-6 (format settings).
