# Panel Restructure + Card-Based Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the extension panel to use top-level tabs (Main, Consolidate, Batch Extract, Settings, Log) and replace the raw-text consolidation editor with a card-based editor matching the left pane's visual style.

**Architecture:** Promote the existing sub-tab system to the top level of the panel. Move consolidation config into its own tab. Rewrite the consolidation dialog's right pane from a textarea to an interactive card editor backed by an in-memory block array. Reuse existing `charMemory_card` styling and `parseMemories`/`serializeMemories` for data flow.

**Tech Stack:** jQuery (ST convention), `callGenericPopup` for the consolidation popup, existing `charMemory_tab` CSS system.

**Design doc:** `docs/plans/2026-02-16-panel-restructure-design.md`

---

### Task 1: Restructure settings.html to top-level tabs

**Files:**
- Modify: `settings.html` (complete restructure)

This is the biggest single change. The entire panel HTML gets reorganized from drawers to tabs. No JS logic changes — just HTML structure.

**Step 1: Rewrite settings.html**

Replace the entire contents of `settings.html` with this structure. The content within each section is moved from the existing drawers — nothing is invented, just relocated.

```html
<div class="charMemory_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Character Memory</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <!-- Stats bar — always visible -->
            <div class="charMemory_statsBar">
                <div class="charMemory_statItem" title="The Data Bank file where memories are stored for this character">
                    <i class="fa-solid fa-file-lines fa-sm"></i>
                    <span id="charMemory_statFile">No character</span>
                </div>
                <div class="charMemory_statItem" title="Total number of individual memory bullets stored">
                    <i class="fa-solid fa-brain fa-sm"></i>
                    <span id="charMemory_statCount">0 memories</span>
                </div>
                <div class="charMemory_statItem" title="New messages since last extraction / auto-extraction threshold">
                    <i class="fa-solid fa-arrows-rotate fa-sm"></i>
                    <span id="charMemory_statProgress">0/10 msgs</span>
                </div>
                <div class="charMemory_statItem" title="Time remaining before the next auto-extraction is allowed">
                    <i class="fa-solid fa-clock fa-sm"></i>
                    <span id="charMemory_statCooldown">Ready</span>
                </div>
            </div>

            <div class="charMemory_statusRow">
                <label class="checkbox_label" for="charMemory_enabled" title="When enabled, memories are extracted automatically after a set number of new messages">
                    <input type="checkbox" id="charMemory_enabled" />
                    <span>Enable automatic extraction</span>
                </label>
            </div>

            <!-- Top-level tabs -->
            <div class="charMemory_tabs">
                <button class="charMemory_tab active" data-tab="main">Main</button>
                <button class="charMemory_tab" data-tab="consolidate">Consolidate</button>
                <button class="charMemory_tab" data-tab="batch">Batch Extract</button>
                <button class="charMemory_tab" data-tab="settings">Settings</button>
                <button class="charMemory_tab" data-tab="log">Log</button>
            </div>

            <!-- Main tab (default) -->
            <div class="charMemory_tabContent" id="charMemory_tabMain">
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_extractNow" class="menu_button" value="Extract Now" title="Extract memories from unprocessed messages. If all messages have been processed, use 'Reset Extraction State' first to re-read from the beginning." />
                    <input type="button" id="charMemory_manageMemories" class="menu_button" value="View / Edit" title="Browse, edit, and delete individual stored memories" />
                </div>
                <hr class="charMemory_separator" />
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_refreshDiag" class="menu_button" value="Refresh Diagnostics" title="Capture current diagnostics (lorebook entries, extension prompts, memory file status)" />
                </div>
                <div id="charMemory_diagnosticsContent" class="charMemory_diagnosticsContent">
                    <div class="charMemory_diagEmpty">Click "Refresh Diagnostics" after a generation to see diagnostics.</div>
                </div>
            </div>

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
                        <option value="custom">Custom prompt</option>
                    </select>
                    <textarea id="charMemory_consolidationPrompt" class="text_pole textarea_compact" rows="6" placeholder="Enter custom consolidation prompt..." style="display:none;"></textarea>
                    <small id="charMemory_consolidationPreview" class="charMemory_helperText" style="font-style:italic;"></small>
                </div>
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_consolidate" class="menu_button" value="Consolidate" title="Use the LLM to merge duplicate and related memories into fewer, cleaner entries" />
                    <input type="button" id="charMemory_undoConsolidate" class="menu_button" value="Undo Consolidation" title="Restore memories from before the last consolidation (session only)" disabled />
                </div>
            </div>

            <!-- Batch Extract tab -->
            <div class="charMemory_tabContent" id="charMemory_tabBatch" style="display:none;">
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_batchRefresh" class="menu_button" value="Refresh" title="Load chat list for this character" />
                    <input type="button" id="charMemory_batchExtract" class="menu_button" value="Extract Selected" title="Run extraction on all selected chats" disabled />
                    <input type="button" id="charMemory_batchStop" class="menu_button" value="Stop" title="Cancel batch extraction" style="display:none;" />
                </div>
                <div class="charMemory_batchSelectRow">
                    <label class="checkbox_label">
                        <input type="checkbox" id="charMemory_batchSelectAll" />
                        <small>Select all</small>
                    </label>
                </div>
                <div id="charMemory_batchProgress" class="charMemory_batchProgress" style="display:none;">
                    <div class="charMemory_batchProgressText"></div>
                    <div class="charMemory_batchProgressBar"><div class="charMemory_batchProgressFill"></div></div>
                </div>
                <div id="charMemory_batchChatList" class="charMemory_batchChatList">
                    <div class="charMemory_diagEmpty">Click "Refresh" to load chats.</div>
                </div>
            </div>

            <!-- Settings tab -->
            <div class="charMemory_tabContent" id="charMemory_tabSettings" style="display:none;">

                <!-- LLM Used for Extraction -->
                <div class="charMemory_statusRow">
                    <label for="charMemory_source" title="Which LLM to use for memory extraction and consolidation">
                        <small>LLM Used for Extraction</small>
                    </label>
                    <select id="charMemory_source" class="text_pole">
                        <option value="provider">Dedicated API (recommended)</option>
                        <option value="webllm">WebLLM (browser-local)</option>
                        <option value="main_llm">Main LLM</option>
                    </select>
                    <small class="charMemory_helperText"><b>Dedicated API is recommended.</b> Main LLM pollutes the extraction prompt with chat context, system prompts, and other instructions that degrade memory quality.</small>

                    <div id="charMemory_providerSettings" style="display:none;">
                        <div class="charMemory_statusRow">
                            <label><small>Provider</small></label>
                            <select id="charMemory_providerSelect" class="text_pole">
                            </select>
                        </div>
                        <div class="charMemory_statusRow" id="charMemory_providerApiKeyRow">
                            <label><small>API Key <a id="charMemory_providerHelpLink" href="#" target="_blank" style="font-size:0.85em;">(get key)</a></small></label>
                            <div style="display:flex;gap:5px;align-items:center;">
                                <input type="password" id="charMemory_providerApiKey" class="text_pole" placeholder="Enter API key" style="flex:1;" />
                                <button type="button" id="charMemory_providerApiKeyReveal" class="menu_button" title="Show/hide API key" style="padding:3px 8px;">
                                    <i class="fa-solid fa-eye fa-sm"></i>
                                </button>
                                <input type="button" id="charMemory_providerConnect" class="menu_button" value="Connect" title="Fetch available models using your API key" />
                            </div>
                        </div>
                        <small id="charMemory_providerConnectStatus" class="charMemory_helperText" style="display:none;"></small>
                        <div class="charMemory_statusRow" id="charMemory_providerBaseUrlRow" style="display:none;">
                            <label><small>Base URL</small></label>
                            <input type="text" id="charMemory_providerBaseUrl" class="text_pole" placeholder="https://your-server.com/v1" />
                        </div>
                        <div class="charMemory_statusRow" id="charMemory_providerModelDropdownRow">
                            <label><small>Model</small></label>
                            <div id="charMemory_nanogptFilters" style="display:none;">
                                <div class="charMemory_filterRow" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;">
                                    <label class="checkbox_label"><input type="checkbox" id="charMemory_nanogptFilterSub" /> <small>Subscription</small></label>
                                    <label class="checkbox_label"><input type="checkbox" id="charMemory_nanogptFilterOS" /> <small>Open Source</small></label>
                                    <label class="checkbox_label"><input type="checkbox" id="charMemory_nanogptFilterRP" /> <small>Roleplay</small></label>
                                    <label class="checkbox_label"><input type="checkbox" id="charMemory_nanogptFilterReasoning" /> <small>Reasoning</small></label>
                                </div>
                            </div>
                            <div style="display:flex;gap:5px;align-items:center;">
                                <select id="charMemory_providerModel" class="text_pole" style="flex:1;">
                                    <option value="">-- Select model --</option>
                                </select>
                                <input type="button" id="charMemory_providerRefreshModels" class="menu_button" value="&#x21bb;" title="Refresh model list" />
                            </div>
                            <small id="charMemory_providerModelInfo" class="charMemory_helperText"></small>
                        </div>
                        <div class="charMemory_statusRow" id="charMemory_providerTestRow">
                            <div style="display:flex;gap:5px;align-items:center;">
                                <input type="button" id="charMemory_providerTest" class="menu_button" value="Test Model" title="Send a test prompt to the selected model and verify it responds correctly" />
                            </div>
                            <small id="charMemory_providerTestStatus" class="charMemory_helperText" style="display:none;"></small>
                        </div>
                        <div class="charMemory_statusRow" id="charMemory_providerModelInputRow" style="display:none;">
                            <label><small>Model ID</small></label>
                            <input type="text" id="charMemory_providerModelInput" class="text_pole" placeholder="Enter model identifier" />
                            <small class="charMemory_helperText">Enter the model ID manually (e.g. claude-sonnet-4-5-20250929).</small>
                        </div>
                        <div class="charMemory_statusRow">
                            <label><small>System prompt (optional)</small></label>
                            <textarea id="charMemory_providerSystemPrompt" class="text_pole" rows="3" placeholder="Override the default system prompt. Leave blank for default."></textarea>
                            <small class="charMemory_helperText">Prepended to extraction/consolidation calls. Use for jailbreaks or custom instructions.</small>
                        </div>
                    </div>
                </div>

                <!-- Auto-Extraction -->
                <hr class="charMemory_separator" />
                <small><b>Auto-Extraction</b></small>

                <div class="charMemory_sliderRow">
                    <label title="How many new messages trigger an automatic extraction.">
                        <small>Extract after every N messages</small>
                    </label>
                    <input class="neo-range-slider" type="range" id="charMemory_interval" min="3" max="100" step="1" value="20" />
                    <div class="wide100p">
                        <input class="neo-range-input" type="number" min="3" max="100" step="1"
                               data-for="charMemory_interval" id="charMemory_intervalCounter" />
                    </div>
                </div>

                <div class="charMemory_sliderRow">
                    <label title="Minimum time between auto-extractions, even if the message threshold is met.">
                        <small>Minimum wait between extractions (min)</small>
                    </label>
                    <input class="neo-range-slider" type="range" id="charMemory_minCooldown" min="0" max="30" step="1" value="10" />
                    <div class="wide100p">
                        <input class="neo-range-input" type="number" min="0" max="30" step="1"
                               data-for="charMemory_minCooldown" id="charMemory_minCooldownCounter" />
                    </div>
                </div>

                <small class="charMemory_helperText">These settings only affect automatic extraction. Manual extraction and batch extraction ignore them.</small>

                <!-- Extraction Settings -->
                <hr class="charMemory_separator" />
                <small><b>Extraction Settings</b></small>

                <div class="charMemory_sliderRow">
                    <label title="How many messages to include in each LLM call.">
                        <small>Messages per LLM call</small>
                    </label>
                    <input class="neo-range-slider" type="range" id="charMemory_maxMessages" min="10" max="200" step="1" value="50" />
                    <div class="wide100p">
                        <input class="neo-range-input" type="number" min="10" max="200" step="1"
                               data-for="charMemory_maxMessages" id="charMemory_maxMessagesCounter" />
                    </div>
                </div>

                <div class="charMemory_sliderRow">
                    <label title="Maximum tokens the LLM can use for its response.">
                        <small>Max response length</small>
                    </label>
                    <input class="neo-range-slider" type="range" id="charMemory_responseLength" min="100" max="4000" step="50" value="1000" />
                    <div class="wide100p">
                        <input class="neo-range-input" type="number" min="100" max="4000" step="50"
                               data-for="charMemory_responseLength" id="charMemory_responseLengthCounter" />
                    </div>
                </div>

                <!-- Storage -->
                <hr class="charMemory_separator" />

                <div class="charMemory_statusRow">
                    <label class="checkbox_label" for="charMemory_perChat" title="When enabled, each chat gets its own memory file.">
                        <input type="checkbox" id="charMemory_perChat" />
                        <span>Separate memories per chat</span>
                    </label>
                    <small class="charMemory_helperText">Each conversation gets its own memory file instead of sharing one per character.</small>
                </div>

                <div class="charMemory_statusRow">
                    <label for="charMemory_fileName" title="Override the auto-generated file name.">
                        <small>File name override</small>
                    </label>
                    <input type="text" id="charMemory_fileName" class="text_pole" placeholder="(auto-generated from character name)" />
                    <small class="charMemory_helperText">Leave blank for auto-naming. Set a custom name to override.</small>
                </div>

                <!-- Extraction Prompt -->
                <hr class="charMemory_separator" />

                <div class="charMemory_promptSection">
                    <label for="charMemory_extractionPrompt" title="The prompt sent to the LLM for memory extraction. Uses {{charName}}, {{charCard}}, {{existingMemories}}, {{recentMessages}}, {{char}}, and {{user}} placeholders.">
                        <small>Extraction prompt</small>
                    </label>
                    <textarea id="charMemory_extractionPrompt" class="text_pole textarea_compact" rows="8" placeholder="Enter extraction prompt..."></textarea>
                    <input type="button" id="charMemory_restorePrompt" class="menu_button" value="Restore Default Prompt" title="Replace the current prompt with the built-in default" />
                </div>

                <!-- Reset / Clear -->
                <hr class="charMemory_separator" />

                <div class="charMemory_statusRow">
                    <input type="button" id="charMemory_resetTracking" class="menu_button" value="Reset Extraction State" title="Reset extraction tracking for the current character's chats" />
                    <small class="charMemory_helperText">Resets extraction tracking for the current character. Use before 'Extract Now' or 'Batch Extract' to re-process from the beginning.</small>
                    <input type="button" id="charMemory_resetExtraction" class="menu_button charMemory_dangerBtn" value="Clear All Memories" title="Delete the memory file and reset extraction state for the current character." />
                    <small class="charMemory_helperText">Deletes the memory file and resets extraction tracking for the current character. This cannot be undone.</small>
                </div>
            </div>

            <!-- Log tab -->
            <div class="charMemory_tabContent" id="charMemory_tabLog" style="display:none;">
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_clearLog" class="menu_button" value="Clear" title="Clear the activity log" />
                    <input type="button" id="charMemory_saveLog" class="menu_button" value="Save Log" title="Download the activity log as a text file" />
                    <label class="checkbox_label" for="charMemory_verboseLog" title="Show full LLM prompts and responses in the activity log">
                        <input type="checkbox" id="charMemory_verboseLog" />
                        <small>Verbose</small>
                    </label>
                </div>
                <div id="charMemory_activityLog" class="charMemory_activityLog" style="max-height:300px;overflow-y:auto;font-size:0.85em;font-family:monospace;">
                    <div class="charMemory_diagEmpty">No activity yet.</div>
                </div>
            </div>

        </div>
    </div>
</div>
```

Key changes from the original:
- The top-level button row (Extract Now, View/Edit, Consolidate, Undo) is split: Extract+View go to Main tab, Consolidate+Undo go to Consolidate tab
- The Settings drawer becomes the Settings tab (no longer a nested drawer)
- The Tools & Diagnostics drawer is removed; its contents are split: Batch Extract and Log become their own tabs, Diagnostics moves into Main tab
- Consolidation strategy/prompt controls move from Settings to the Consolidate tab
- All element IDs are unchanged so existing JS event handlers continue to work

**Step 2: Commit**

```bash
git add settings.html
git commit -m "refactor: restructure panel to top-level tab layout"
```

---

### Task 2: Update tab switching logic in index.js

**Files:**
- Modify: `index.js:2970-2979` (tab switching handler)

The existing tab handler uses a convention: `data-tab="batch"` maps to `#charMemory_tabBatch`. The new tabs follow the same convention (`main` -> `tabMain`, `consolidate` -> `tabConsolidate`, etc.), so the handler logic stays the same. But we need to update the old drawer-based handler since the Tools drawer is gone.

**Step 1: Update the tab handler**

The current handler at line 2971 already works generically:

```javascript
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

This already handles the new tabs correctly (the capitalization convention works for `main` -> `Main`, `consolidate` -> `Consolidate`, `settings` -> `Settings`, etc.). **No changes needed to the tab handler itself.**

However, the old `Tools & Diagnostics` drawer toggle no longer exists in the HTML. Check if there are any event listeners referencing it that need removal. Search for references to the old drawer structure.

**Step 2: Remove the old drawer-specific listener if any**

Search `index.js` for any `inline-drawer` or `Tools` references specific to the old Tools drawer. The generic SillyTavern drawer toggle is handled by ST core, not by our code, so there likely isn't anything to remove. Verify this.

**Step 3: Commit**

```bash
git add index.js
git commit -m "refactor: verify tab switching works with new layout"
```

If no JS changes were needed, skip this commit.

---

### Task 3: Rewrite buildConsolidationDialog for card-based editor

**Files:**
- Modify: `index.js:2366-2410` (replace `buildConsolidationDialog` and `countConsolidatedText`)
- Modify: `style.css` (add editor card styles, replace textarea styles)

This is the core UX improvement. Replace the textarea-based right pane with a card-based editor.

**Step 1: Replace `buildConsolidationDialog` and `countConsolidatedText`**

Replace lines 2366-2410 with:

```javascript
function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedBlocks) {
    const renderReadOnlyCards = (blocks) => {
        return blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${escapeHtml(b.chat)}</strong> <span class="charMemory_cardDate">${escapeHtml(b.date)}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
    };

    const renderEditableCards = (blocks) => {
        return blocks.map((b, bi) => {
            const bullets = b.bullets.map((bullet, bui) =>
                `<div class="charMemory_editorBulletRow" data-block="${bi}" data-bullet="${bui}">
                    <span class="charMemory_editorDash">-</span>
                    <input type="text" class="charMemory_editorBulletInput" value="${escapeHtml(bullet)}" data-block="${bi}" data-bullet="${bui}" />
                    <button class="charMemory_editorDeleteBullet menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete memory"><i class="fa-solid fa-trash fa-xs"></i></button>
                </div>`
            ).join('');
            return `<div class="charMemory_card charMemory_editorCard" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <span class="charMemory_cardTitle">${escapeHtml(b.chat)}</span>
                    <span class="charMemory_cardTimestamp">${escapeHtml(b.date)}</span>
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorDeleteBlock menu_button menu_button_icon" data-block="${bi}" title="Delete block"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                <div class="charMemory_editorBullets">${bullets}</div>
                <button class="charMemory_editorAddBullet menu_button" data-block="${bi}"><i class="fa-solid fa-plus fa-xs"></i> Add memory</button>
            </div>`;
        }).join('');
    };

    const afterCount = countBlocksBullets(consolidatedBlocks);

    return `<div class="charMemory_consolidationDialog">
        <div class="charMemory_consolidationStats" id="charMemory_consolidationStats">
            Original: ${beforeCount} memories in ${beforeBlocks.length} blocks &rarr; Consolidated: <span id="charMemory_afterCount">${afterCount}</span> memories
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
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4>Original</h4>
                <div class="charMemory_consolidationContent">${renderReadOnlyCards(beforeBlocks)}</div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4>Consolidated</h4>
                <div class="charMemory_consolidationContent" id="charMemory_editorPane">${renderEditableCards(consolidatedBlocks)}</div>
                <button class="charMemory_editorAddBlock menu_button" id="charMemory_editorAddBlock"><i class="fa-solid fa-plus fa-xs"></i> Add Block</button>
            </div>
        </div>
    </div>`;
}

function countBlocksBullets(blocks) {
    return blocks.reduce((sum, b) => sum + b.bullets.length, 0);
}
```

Key changes:
- Third parameter changes from `consolidatedText` (string) to `consolidatedBlocks` (array of block objects)
- Right pane renders editable cards with text inputs instead of a textarea
- Each bullet has an input field + delete button
- Each block has a delete-block button and "Add memory" button
- "Add Block" button at the bottom of the right pane
- `countConsolidatedText` (text-based) replaced with `countBlocksBullets` (block-based)
- Toolbar moved above the panes (between stats and panes) for better visibility

**Step 2: Add CSS for editor cards**

In `style.css`, replace the `.charMemory_consolidationEditor` block (the textarea styles, lines 405-416) with:

```css
.charMemory_editorBulletRow {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 2px;
}

.charMemory_editorDash {
    flex-shrink: 0;
    font-size: 0.85em;
    opacity: 0.5;
}

.charMemory_editorBulletInput {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    font-size: 0.85em;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.05));
    color: var(--SmartThemeBodyColor);
    border: 1px solid transparent;
    border-radius: 4px;
    transition: border-color 0.15s;
}

.charMemory_editorBulletInput:focus {
    border-color: var(--SmartThemeBorderColor, rgba(255,255,255,0.2));
    outline: none;
}

.charMemory_editorBullets {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 4px;
}

.charMemory_editorAddBullet,
.charMemory_editorAddBlock {
    font-size: 0.8em;
    opacity: 0.7;
    padding: 2px 8px;
}

.charMemory_editorAddBullet:hover,
.charMemory_editorAddBlock:hover {
    opacity: 1;
}

.charMemory_editorAddBlock {
    margin-top: 8px;
}

.charMemory_editorCard {
    position: relative;
}
```

**Step 3: Commit**

```bash
git add index.js style.css
git commit -m "feat: replace textarea editor with card-based editor in consolidation dialog"
```

---

### Task 4: Rewrite consolidateMemories() for block-array data model

**Files:**
- Modify: `index.js:2552-2663` (rewrite `consolidateMemories`)

The function now works with block arrays instead of raw text. The version stack stores deep copies of block arrays. The editor is wired up via event delegation.

**Step 1: Replace `consolidateMemories()` entirely**

Replace lines 2552-2663 with:

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

    // Run initial consolidation — returns serialized text, parse to blocks
    const initialResult = await runConsolidationLLM(memories);
    if (!initialResult) return;

    let editorBlocks = parseMemories(initialResult);
    const versionStack = [];

    // Helper: deep copy blocks array
    const cloneBlocks = (blocks) => blocks.map(b => ({ ...b, bullets: [...b.bullets] }));

    // Helper: re-render the editor pane from editorBlocks
    const refreshEditor = () => {
        const renderEditableCards = (blocks) => {
            return blocks.map((b, bi) => {
                const bullets = b.bullets.map((bullet, bui) =>
                    `<div class="charMemory_editorBulletRow" data-block="${bi}" data-bullet="${bui}">
                        <span class="charMemory_editorDash">-</span>
                        <input type="text" class="charMemory_editorBulletInput" value="${escapeHtml(bullet)}" data-block="${bi}" data-bullet="${bui}" />
                        <button class="charMemory_editorDeleteBullet menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete memory"><i class="fa-solid fa-trash fa-xs"></i></button>
                    </div>`
                ).join('');
                return `<div class="charMemory_card charMemory_editorCard" data-block="${bi}">
                    <div class="charMemory_cardHeader">
                        <span class="charMemory_cardTitle">${escapeHtml(b.chat)}</span>
                        <span class="charMemory_cardTimestamp">${escapeHtml(b.date)}</span>
                        <span class="charMemory_cardActions">
                            <button class="charMemory_editorDeleteBlock menu_button menu_button_icon" data-block="${bi}" title="Delete block"><i class="fa-solid fa-trash"></i></button>
                        </span>
                    </div>
                    <div class="charMemory_editorBullets">${bullets}</div>
                    <button class="charMemory_editorAddBullet menu_button" data-block="${bi}"><i class="fa-solid fa-plus fa-xs"></i> Add memory</button>
                </div>`;
            }).join('');
        };
        $('#charMemory_editorPane').html(renderEditableCards(editorBlocks));
        $('#charMemory_afterCount').text(countBlocksBullets(editorBlocks));
    };

    // Build and show the interactive dialog
    const dialogHtml = buildConsolidationDialog(memories, beforeCount, editorBlocks);
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true });

    // Set up the strategy dropdown to match current setting
    const currentStrategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    $('#charMemory_consolidationDialogStrategy').val(currentStrategy);

    // === Event delegation for editor interactions ===

    // Sync bullet input changes back to editorBlocks
    $(document).off('input.charMemoryEditor').on('input.charMemoryEditor', '.charMemory_editorBulletInput', function () {
        const bi = Number($(this).data('block'));
        const bui = Number($(this).data('bullet'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets[bui] = $(this).val();
        }
    });

    // Delete bullet
    $(document).off('click.charMemoryEditorDelBullet').on('click.charMemoryEditorDelBullet', '.charMemory_editorDeleteBullet', function () {
        const bi = Number($(this).data('block'));
        const bui = Number($(this).data('bullet'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets.splice(bui, 1);
            // Remove block if no bullets left
            if (editorBlocks[bi].bullets.length === 0) {
                editorBlocks.splice(bi, 1);
            }
            refreshEditor();
        }
    });

    // Delete block
    $(document).off('click.charMemoryEditorDelBlock').on('click.charMemoryEditorDelBlock', '.charMemory_editorDeleteBlock', function () {
        const bi = Number($(this).data('block'));
        editorBlocks.splice(bi, 1);
        refreshEditor();
    });

    // Add bullet to block
    $(document).off('click.charMemoryEditorAddBullet').on('click.charMemoryEditorAddBullet', '.charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets.push('');
            refreshEditor();
            // Focus the new input
            $(`#charMemory_editorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
        }
    });

    // Add new block
    $(document).off('click.charMemoryEditorAddBlock').on('click.charMemoryEditorAddBlock', '#charMemory_editorAddBlock', function () {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        editorBlocks.push({ chat: 'consolidated', date: timestamp, bullets: [''] });
        refreshEditor();
        // Focus the new block's input
        $('#charMemory_editorPane .charMemory_editorCard:last .charMemory_editorBulletInput:last').focus();
    });

    // === Re-run button ===
    $('#charMemory_rerunConsolidation').off('click').on('click', async () => {
        if (inApiCall) return;

        const currentBlocks = cloneBlocks(editorBlocks);

        const dialogStrategy = $('#charMemory_consolidationDialogStrategy').val();
        extension_settings[MODULE_NAME].consolidationStrategy = dialogStrategy;
        updateConsolidationStrategyUI();
        saveSettingsDebounced();

        $('#charMemory_rerunSpinner').show();
        $('#charMemory_rerunConsolidation').prop('disabled', true);

        const newResult = await runConsolidationLLM(memories);

        $('#charMemory_rerunSpinner').hide();
        $('#charMemory_rerunConsolidation').prop('disabled', false);

        if (newResult) {
            versionStack.push(currentBlocks);
            $('#charMemory_undoRerun').prop('disabled', false);
            editorBlocks = parseMemories(newResult);
            refreshEditor();
        }
    });

    // === Undo button ===
    $('#charMemory_undoRerun').off('click').on('click', () => {
        if (versionStack.length === 0) return;
        editorBlocks = versionStack.pop();
        refreshEditor();
        if (versionStack.length === 0) {
            $('#charMemory_undoRerun').prop('disabled', true);
        }
    });

    // === Wait for Accept/Cancel ===
    const confirmed = await popup;

    // Clean up event delegation
    $(document).off('input.charMemoryEditor');
    $(document).off('click.charMemoryEditorDelBullet');
    $(document).off('click.charMemoryEditorDelBlock');
    $(document).off('click.charMemoryEditorAddBullet');
    $(document).off('click.charMemoryEditorAddBlock');

    if (!confirmed) {
        logActivity('Consolidation cancelled by user');
        toastr.info('Consolidation cancelled.', 'CharMemory');
        return;
    }

    if (inApiCall) {
        toastr.warning('Cannot save while a re-run is in progress.', 'CharMemory');
        return;
    }

    // Filter out empty bullets and empty blocks before saving
    const cleanBlocks = editorBlocks
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    if (cleanBlocks.length === 0) {
        toastr.warning('No memories to save. Memories unchanged.', 'CharMemory');
        return;
    }

    consolidationBackup = content;
    await writeMemories(serializeMemories(cleanBlocks));
    $('#charMemory_undoConsolidate').prop('disabled', false);

    const afterCount = countMemories(cleanBlocks);
    logActivity(`Consolidation complete: ${beforeCount} → ${afterCount} memories`, 'success');
    toastr.success(`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
    updateStatusDisplay();
}
```

Key changes from current:
- `editorBlocks` is an array of `{ chat, date, bullets }` objects instead of a text string
- `versionStack` stores deep copies of block arrays
- Event delegation handles bullet editing, deletion, addition, and block operations
- `refreshEditor()` re-renders the editor pane from `editorBlocks`
- On Accept, empty bullets/blocks are filtered before saving
- Event delegation is cleaned up when the popup closes

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: rewrite consolidateMemories() for card-based editor with block array data model"
```

---

### Task 5: Final integration, testing, and cleanup

**Files:**
- Modify: `index.js` (remove dead code, verify settings init)
- Modify: `style.css` (remove unused textarea styles)
- Modify: `CHANGELOG.md` (update for restructure)

**Step 1: Remove dead CSS**

Remove the `.charMemory_consolidationEditor` CSS block (the old textarea styles) if still present. It was defined around line 405 and should have been replaced in Task 3, but verify and remove any remnants.

**Step 2: Verify settings initialization**

In `loadSettings()`, verify that `updateConsolidationStrategyUI()` is still called and works (it was added in the original Task 2 and references `#charMemory_consolidationStrategy` which now lives in the Consolidate tab instead of Settings). The element IDs are unchanged, so no code changes should be needed.

**Step 3: Manual test checklist**

1. Open SillyTavern, switch to a character with existing memories
2. **Tab navigation**: Click each tab (Main, Consolidate, Batch Extract, Settings, Log) — verify correct content shows
3. **Main tab**: Extract Now and View/Edit work, Diagnostics refresh works
4. **Consolidate tab**: Strategy dropdown shows, custom prompt appears when "Custom" selected
5. **Consolidation dialog**:
   - Click Consolidate → LLM runs → popup opens
   - Left pane: read-only cards
   - Right pane: editable cards with text inputs
   - Edit a bullet → verify it persists in the card
   - Delete a bullet (trash icon) → card updates, count updates
   - Add a memory to a block → new input appears, focused
   - Delete a block → block removed, count updates
   - Add Block → new empty block appears at bottom
   - Re-run → new cards appear, undo button enabled
   - Undo → previous cards restored
   - Accept → memories saved to file
6. **Undo Consolidation**: Restores pre-consolidation state
7. **Batch Extract tab**: Refresh loads chats, extraction works
8. **Settings tab**: All settings persist, provider config works
9. **Log tab**: Activity log shows entries for extraction and consolidation

**Step 4: Update CHANGELOG.md**

Add entries under `## 1.3.0`:

```markdown
### Improvements

- **Tabbed panel layout**: Extension panel reorganized into tabs (Main, Consolidate, Batch Extract, Settings, Log) for better discoverability.
- **Card-based consolidation editor**: Consolidated memories are now shown as editable cards matching the original memories' formatting, instead of raw text with tags. Add, edit, and delete individual memories or entire blocks.
```

**Step 5: Commit**

```bash
git add index.js style.css CHANGELOG.md
git commit -m "feat: complete panel restructure with tabbed layout and card editor"
```

---

## Task Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Restructure settings.html to top-level tab layout | `settings.html` |
| 2 | Update tab switching logic (verify, likely no changes) | `index.js` |
| 3 | Rewrite buildConsolidationDialog for card-based editor | `index.js`, `style.css` |
| 4 | Rewrite consolidateMemories() for block-array data model | `index.js` |
| 5 | Final integration, testing, cleanup, changelog | `index.js`, `style.css`, `CHANGELOG.md` |
