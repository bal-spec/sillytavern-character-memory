# Per-Message Injection Viewer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-message injection viewer that shows what memories, lorebook entries, and extension prompts were injected for each AI response — via indicator dots on messages and a persistent side drawer.

**Architecture:** Extend the existing `captureDiagnostics()` flow to snapshot injection data per message into `chat_metadata`. Add a third per-message button ("View Injected") and an indicator dot. Render a toggleable side drawer (appended to `document.body`) that displays the selected message's snapshot. Reuse existing diagnostics CSS classes.

**Tech Stack:** jQuery (ST convention), Font Awesome icons, SillyTavern event system, `chat_metadata` for persistence, `extension_settings` for drawer open/closed state.

---

### Task 1: Data Capture — Persist injection snapshots per message

**Files:**
- Modify: `index.js:1183-1189` (lastDiagnostics init area — add tracking variable)
- Modify: `index.js:1608-1615` (ensureMetadata — add injectionData init)
- Modify: `index.js:3040-3064` (captureDiagnostics — save snapshot to chat_metadata)

**Step 1: Add a variable to track the current generation's message index**

Near the `lastDiagnostics` declaration (~line 1183), add:

```js
let lastDiagnostics = {
    worldInfoEntries: [],
    extensionPrompts: {},
    timestamp: null,
};
let diagnosticsHistory = [];
let pendingDiagnosticsMessageIndex = null;
```

**Step 2: Initialize `injectionData` in chat_metadata**

In `ensureMetadata()` (~line 1608), add the `injectionData` field:

```js
function ensureMetadata() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {
            lastExtractedIndex: -1,
            messagesSinceExtraction: 0,
            injectionData: {},
        };
    }
    if (!chat_metadata[MODULE_NAME].injectionData) {
        chat_metadata[MODULE_NAME].injectionData = {};
    }
}
```

**Step 3: Capture the message index when CHARACTER_MESSAGE_RENDERED fires**

`captureDiagnostics` is registered on `CHARACTER_MESSAGE_RENDERED` which receives the message index as its argument. Update the function signature and persist the snapshot:

```js
function captureDiagnostics(messageIndex) {
    const context = getContext();
    lastDiagnostics.extensionPrompts = {};
    lastDiagnostics.timestamp = new Date().toLocaleTimeString();

    if (context.extensionPrompts) {
        for (const [key, value] of Object.entries(context.extensionPrompts)) {
            if (value && value.value) {
                const maxLen = key === '4_vectors_data_bank' ? 2000 : 300;
                lastDiagnostics.extensionPrompts[key] = {
                    label: key,
                    content: typeof value.value === 'string' ? value.value.substring(0, maxLen) : String(value.value).substring(0, maxLen),
                    position: value.position,
                    depth: value.depth,
                };
            }
        }
    }

    // Store in history (keep last 5)
    diagnosticsHistory.unshift({ ...lastDiagnostics, worldInfoEntries: [...lastDiagnostics.worldInfoEntries] });
    if (diagnosticsHistory.length > 5) diagnosticsHistory.pop();

    // --- NEW: Persist per-message injection snapshot ---
    if (typeof messageIndex === 'number' && messageIndex >= 0) {
        ensureMetadata();

        // Extract memory bullets from Data Bank vector injection
        const dbPrompt = lastDiagnostics.extensionPrompts['4_vectors_data_bank'];
        const memories = [];
        if (dbPrompt && dbPrompt.content) {
            const bullets = dbPrompt.content.split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('- '))
                .map(line => line.slice(2).trim())
                .filter(Boolean);
            for (const b of bullets) {
                memories.push({ text: b });
            }
        }

        const snapshot = {
            memories,
            worldInfo: lastDiagnostics.worldInfoEntries.map(e => ({
                comment: e.comment,
                keys: e.keys,
                content: e.content,
            })),
            extensionPrompts: Object.values(lastDiagnostics.extensionPrompts).map(p => ({
                label: p.label,
                content: p.content.substring(0, 500),
                position: p.position,
            })),
            timestamp: lastDiagnostics.timestamp,
        };

        chat_metadata[MODULE_NAME].injectionData[messageIndex] = snapshot;
        saveMetadataDebounced();
    }

    updateDiagnosticsDisplay();
}
```

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat(injection-viewer): capture per-message injection snapshots in chat_metadata"
```

---

### Task 2: Per-Message UI — Add indicator dot and "View Injected" button

**Files:**
- Modify: `index.js:4594-4605` (updateIndicatorForMessage — add injection indicator)
- Modify: `index.js:4661-4685` (onMessageRenderedAddButtons — add View Injected button)
- Modify: `index.js:4629-4655` (addButtonsToExistingMessages — add View Injected button)
- Modify: `index.js:4920-4924` (init — register click handler)
- Modify: `style.css` (append new styles)

**Step 1: Add injection indicator alongside extraction indicator**

In `updateIndicatorForMessage()` (~line 4594), add an injection indicator dot after the extraction indicator logic:

```js
function updateIndicatorForMessage(mesElement, messageIndex) {
    const $mes = $(mesElement);
    const $nameBlock = $mes.find('.ch_name');

    // Extraction indicator (existing)
    $nameBlock.find('.charMemory_extractedIndicator').remove();
    ensureMetadata();
    const lastIdx = chat_metadata[MODULE_NAME]?.lastExtractedIndex ?? -1;
    if (messageIndex <= lastIdx && messageIndex >= 0) {
        $nameBlock.append('<span class="charMemory_extractedIndicator" title="Memory extracted"><i class="fa-solid fa-brain fa-xs"></i></span>');
    }

    // Injection data indicator (new)
    $nameBlock.find('.charMemory_injectionIndicator').remove();
    const hasInjectionData = chat_metadata[MODULE_NAME]?.injectionData?.[messageIndex];
    if (hasInjectionData) {
        $nameBlock.append('<span class="charMemory_injectionIndicator" title="Click to view injected context" data-mesid="' + messageIndex + '"><i class="fa-solid fa-syringe fa-xs"></i></span>');
    }
}
```

**Step 2: Add "View Injected" button to onMessageRenderedAddButtons**

In `onMessageRenderedAddButtons()` (~line 4661), add the button for AI messages that have injection data:

```js
function onMessageRenderedAddButtons(messageIndex) {
    const context = getContext();
    if (context.characterId === undefined) return;

    const msg = context.chat[messageIndex];
    if (!msg || msg.is_system) return;

    const $mes = $(`#chat .mes[mesid="${messageIndex}"]`);
    if (!$mes.length) return;

    const $extraBtns = $mes.find('.extraMesButtons');
    if (!$extraBtns.length) return;

    // Remove existing extension buttons to prevent duplicates
    $extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn, .charMemory_viewInjectedBtn').remove();

    // Pin as memory — available on all non-system messages
    $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${messageIndex}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

    // Character messages only
    if (!msg.is_user) {
        // View injected context
        $extraBtns.prepend(`<div class="mes_button charMemory_viewInjectedBtn" data-mesid="${messageIndex}" title="View injected context"><i class="fa-solid fa-syringe"></i></div>`);

        // Extract from here
        $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${messageIndex}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);

        updateIndicatorForMessage($mes, messageIndex);
    }
}
```

**Step 3: Update addButtonsToExistingMessages to include View Injected**

In `addButtonsToExistingMessages()` (~line 4629), update the duplicate check and add the new button:

```js
function addButtonsToExistingMessages() {
    const context = getContext();
    if (context.characterId === undefined) return;

    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (isNaN(mesId)) return;

        const msg = context.chat[mesId];
        if (!msg || msg.is_system) return;

        const $extraBtns = $(this).find('.extraMesButtons');
        if (!$extraBtns.length) return;

        // Skip if already injected
        if ($extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn').length) return;

        // Pin as memory — all non-system messages
        $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${mesId}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

        // Character messages only
        if (!msg.is_user) {
            $extraBtns.prepend(`<div class="mes_button charMemory_viewInjectedBtn" data-mesid="${mesId}" title="View injected context"><i class="fa-solid fa-syringe"></i></div>`);
            $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${mesId}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
            updateIndicatorForMessage(this, mesId);
        }
    });
}
```

**Step 4: Register click handlers in init block**

In the init block (~line 4920), add handlers for the new button and indicator:

```js
// Per-message buttons and indicators
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
$(document).on('click', '.charMemory_extractHereBtn', onExtractHereClick);
$(document).on('click', '.charMemory_pinMemoryBtn', onPinMemoryClick);
$(document).on('click', '.charMemory_viewInjectedBtn', onViewInjectedClick);
$(document).on('click', '.charMemory_injectionIndicator', onViewInjectedClick);
```

**Step 5: Add the click handler function**

Add near the other per-message click handlers (~after onPinMemoryClick):

```js
/**
 * Click handler for "View Injected" button and injection indicator.
 */
function onViewInjectedClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;
    showInjectionDrawer(messageIndex);
}
```

**Step 6: Add CSS for the new button and indicator**

Append to `style.css`:

```css
/* Injection viewer — per-message button */
.charMemory_viewInjectedBtn {
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.15s;
}
.charMemory_viewInjectedBtn:hover {
    opacity: 1;
}

/* Injection data indicator (syringe icon next to char name) */
.charMemory_injectionIndicator {
    display: inline-flex;
    align-items: center;
    margin-left: 4px;
    opacity: 0.35;
    color: var(--SmartThemeQuoteColor, #e8a33d);
    font-size: 0.75em;
    vertical-align: middle;
    cursor: pointer;
    transition: opacity 0.15s;
}
.charMemory_injectionIndicator:hover {
    opacity: 0.8;
}
```

**Step 7: Commit**

```bash
git add index.js style.css
git commit -m "feat(injection-viewer): add per-message View Injected button and indicator dot"
```

---

### Task 3: Side Drawer — HTML, CSS, and render logic

**Files:**
- Modify: `index.js` (init block ~4908 — inject drawer HTML into DOM)
- Modify: `index.js` (new functions: `showInjectionDrawer`, `updateInjectionDrawer`, `toggleInjectionDrawer`)
- Modify: `style.css` (append drawer styles)

**Step 1: Inject drawer HTML into the DOM at init time**

In the init block (`jQuery(async function () { ... })` ~line 4908), after appending settings HTML, inject the drawer:

```js
// Injection viewer drawer — appended to body, outside extension panel
$('body').append(`
    <div id="charMemory_injectionDrawer" class="charMemory_injectionDrawer">
        <div class="charMemory_drawerHeader">
            <span class="charMemory_drawerTitle">Injected Context</span>
            <span class="charMemory_drawerMsgLabel" id="charMemory_drawerMsgLabel"></span>
            <div class="charMemory_drawerClose" id="charMemory_drawerClose" title="Close"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="charMemory_drawerBody" id="charMemory_drawerBody">
            <div class="charMemory_diagEmpty">Click the <i class="fa-solid fa-syringe"></i> icon on a message to view its injected context.</div>
        </div>
        <div class="charMemory_drawerFooter" id="charMemory_drawerFooter"></div>
    </div>
    <div id="charMemory_drawerToggle" class="charMemory_drawerToggle" title="Toggle injection viewer">
        <i class="fa-solid fa-syringe"></i>
    </div>
`);
```

**Step 2: Register drawer event handlers in init block**

```js
// Injection drawer controls
$('#charMemory_drawerClose').on('click', () => toggleInjectionDrawer(false));
$('#charMemory_drawerToggle').on('click', () => toggleInjectionDrawer());

// Restore drawer state from settings
if (extension_settings[MODULE_NAME].injectionDrawerOpen) {
    toggleInjectionDrawer(true);
}
```

**Step 3: Implement `toggleInjectionDrawer()`**

```js
/**
 * Toggle the injection viewer drawer open/closed.
 * @param {boolean} [forceState] If provided, force open (true) or closed (false).
 */
function toggleInjectionDrawer(forceState) {
    const $drawer = $('#charMemory_injectionDrawer');
    const $toggle = $('#charMemory_drawerToggle');
    const isOpen = $drawer.hasClass('open');
    const shouldOpen = forceState !== undefined ? forceState : !isOpen;

    $drawer.toggleClass('open', shouldOpen);
    $toggle.toggleClass('open', shouldOpen);

    // Persist state
    extension_settings[MODULE_NAME].injectionDrawerOpen = shouldOpen;
    saveSettingsDebounced();
}
```

**Step 4: Implement `showInjectionDrawer(messageIndex)`**

```js
/**
 * Show the injection drawer for a specific message.
 * @param {number} messageIndex The chat message index to display.
 */
function showInjectionDrawer(messageIndex) {
    ensureMetadata();
    const snapshot = chat_metadata[MODULE_NAME]?.injectionData?.[messageIndex];

    const $body = $('#charMemory_drawerBody');
    const $label = $('#charMemory_drawerMsgLabel');
    const $footer = $('#charMemory_drawerFooter');

    $label.text(`— Message #${messageIndex}`);

    if (!snapshot) {
        $body.html('<div class="charMemory_diagEmpty">No injection data recorded for this message.</div>');
        $footer.text('');
        toggleInjectionDrawer(true);
        return;
    }

    let html = '';

    // CharMemory section
    const memCount = snapshot.memories?.length || 0;
    html += `<div class="charMemory_drawerSection">`;
    html += `<div class="charMemory_drawerSectionHeader" data-section="memories">`;
    html += `<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> `;
    html += `<strong>CharMemory</strong> <span class="charMemory_drawerCount">(${memCount})</span>`;
    html += `</div>`;
    html += `<div class="charMemory_drawerSectionBody">`;
    if (memCount > 0) {
        for (const mem of snapshot.memories) {
            html += `<div class="charMemory_drawerBullet">- ${escapeHtml(mem.text)}</div>`;
        }
    } else {
        html += `<div class="charMemory_diagEmpty">No memories injected</div>`;
    }
    html += `</div></div>`;

    // Lorebook Entries section
    const wiCount = snapshot.worldInfo?.length || 0;
    html += `<div class="charMemory_drawerSection">`;
    html += `<div class="charMemory_drawerSectionHeader" data-section="worldinfo">`;
    html += `<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> `;
    html += `<strong>Lorebook Entries</strong> <span class="charMemory_drawerCount">(${wiCount})</span>`;
    html += `</div>`;
    html += `<div class="charMemory_drawerSectionBody">`;
    if (wiCount > 0) {
        for (const entry of snapshot.worldInfo) {
            html += `<div class="charMemory_drawerCard">`;
            html += `<div class="charMemory_drawerCardTitle">${escapeHtml(entry.comment)}</div>`;
            if (entry.keys?.length > 0) {
                html += `<div class="charMemory_drawerCardKeys">Keys: ${escapeHtml(entry.keys.join(', '))}</div>`;
            }
            if (entry.content) {
                html += `<div class="charMemory_drawerCardContent">${escapeHtml(entry.content)}${entry.content.length >= 200 ? '...' : ''}</div>`;
            }
            html += `</div>`;
        }
    } else {
        html += `<div class="charMemory_diagEmpty">No lorebook entries activated</div>`;
    }
    html += `</div></div>`;

    // Extension Prompts section
    const epCount = snapshot.extensionPrompts?.length || 0;
    html += `<div class="charMemory_drawerSection">`;
    html += `<div class="charMemory_drawerSectionHeader" data-section="prompts">`;
    html += `<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> `;
    html += `<strong>Extension Prompts</strong> <span class="charMemory_drawerCount">(${epCount})</span>`;
    html += `</div>`;
    html += `<div class="charMemory_drawerSectionBody">`;
    if (epCount > 0) {
        for (const prompt of snapshot.extensionPrompts) {
            html += `<div class="charMemory_drawerCard">`;
            html += `<div class="charMemory_drawerCardTitle">${escapeHtml(prompt.label)}</div>`;
            html += `<div class="charMemory_drawerCardContent">${escapeHtml(prompt.content)}${prompt.content.length >= 500 ? '...' : ''}</div>`;
            html += `</div>`;
        }
    } else {
        html += `<div class="charMemory_diagEmpty">No extension prompts active</div>`;
    }
    html += `</div></div>`;

    $body.html(html);
    $footer.text(`Captured at ${snapshot.timestamp}`);

    // Open the drawer
    toggleInjectionDrawer(true);

    // Highlight the selected message briefly
    $(`#chat .mes`).removeClass('charMemory_highlightMes');
    $(`#chat .mes[mesid="${messageIndex}"]`).addClass('charMemory_highlightMes');
    setTimeout(() => $(`#chat .mes[mesid="${messageIndex}"]`).removeClass('charMemory_highlightMes'), 1500);
}
```

**Step 5: Add collapsible section toggle handler in init block**

```js
// Drawer section collapse/expand
$(document).on('click', '.charMemory_drawerSectionHeader', function () {
    const $body = $(this).next('.charMemory_drawerSectionBody');
    const $chevron = $(this).find('.charMemory_drawerChevron');
    $body.slideToggle(150);
    $chevron.toggleClass('collapsed');
});
```

**Step 6: Auto-update drawer on new generation**

Modify `captureDiagnostics()` — at the end, after saving the snapshot, if the drawer is open, auto-show the new message:

```js
// At the end of captureDiagnostics, after the snapshot save block:
if ($('#charMemory_injectionDrawer').hasClass('open') && typeof messageIndex === 'number') {
    showInjectionDrawer(messageIndex);
}
```

**Step 7: Add drawer CSS**

Append to `style.css`:

```css
/* ===== Injection Viewer Drawer ===== */

.charMemory_injectionDrawer {
    position: fixed;
    top: 0;
    right: 0;
    width: 320px;
    height: 100vh;
    background: var(--SmartThemeBlurTintColor, #1a1a2e);
    border-left: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
    z-index: 1000;
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.2s ease;
    font-size: 0.9em;
}
.charMemory_injectionDrawer.open {
    transform: translateX(0);
}

.charMemory_drawerHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
    flex-shrink: 0;
}
.charMemory_drawerTitle {
    font-weight: bold;
    white-space: nowrap;
}
.charMemory_drawerMsgLabel {
    opacity: 0.6;
    font-size: 0.9em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
}
.charMemory_drawerClose {
    cursor: pointer;
    opacity: 0.6;
    padding: 4px;
    margin-left: auto;
    transition: opacity 0.15s;
}
.charMemory_drawerClose:hover {
    opacity: 1;
}

.charMemory_drawerBody {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
}

.charMemory_drawerFooter {
    padding: 6px 12px;
    font-size: 0.8em;
    opacity: 0.5;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
    flex-shrink: 0;
}

/* Drawer toggle button (visible when drawer is closed) */
.charMemory_drawerToggle {
    position: fixed;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: var(--SmartThemeBlurTintColor, #1a1a2e);
    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
    border-right: none;
    border-radius: 6px 0 0 6px;
    padding: 8px 6px;
    cursor: pointer;
    z-index: 999;
    opacity: 0.5;
    transition: opacity 0.15s, right 0.2s ease;
}
.charMemory_drawerToggle:hover {
    opacity: 0.9;
}
.charMemory_drawerToggle.open {
    right: 320px;
}

/* Drawer sections */
.charMemory_drawerSection {
    margin-bottom: 8px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.15));
    border-radius: 4px;
}
.charMemory_drawerSectionHeader {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: pointer;
    user-select: none;
    background: rgba(128, 128, 128, 0.05);
}
.charMemory_drawerSectionHeader:hover {
    background: rgba(128, 128, 128, 0.1);
}
.charMemory_drawerCount {
    opacity: 0.5;
    font-weight: normal;
    font-size: 0.9em;
}
.charMemory_drawerChevron {
    font-size: 0.7em;
    transition: transform 0.15s;
}
.charMemory_drawerChevron.collapsed {
    transform: rotate(-90deg);
}
.charMemory_drawerSectionBody {
    padding: 4px 8px 8px;
}

/* Drawer content cards */
.charMemory_drawerBullet {
    padding: 2px 0;
    font-size: 0.9em;
    line-height: 1.4;
}
.charMemory_drawerCard {
    padding: 6px 8px;
    margin: 4px 0;
    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.15));
    border-radius: 4px;
    font-size: 0.85em;
}
.charMemory_drawerCardTitle {
    font-weight: bold;
    margin-bottom: 2px;
}
.charMemory_drawerCardKeys {
    opacity: 0.6;
    font-size: 0.9em;
}
.charMemory_drawerCardContent {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow-y: auto;
}

/* Message highlight when selected in drawer */
.charMemory_highlightMes {
    outline: 2px solid var(--SmartThemeQuoteColor, #e8a33d);
    outline-offset: -2px;
    transition: outline-color 1.5s ease;
}
```

**Step 8: Commit**

```bash
git add index.js style.css
git commit -m "feat(injection-viewer): add toggleable side drawer with collapsible sections"
```

---

### Task 4: Integration — Wire drawer to chat lifecycle

**Files:**
- Modify: `index.js:2962` (onChatChanged — clear drawer on chat switch)
- Modify: `index.js` (loadSettings — add injectionDrawerOpen default)

**Step 1: Clear drawer content on chat switch**

In `onChatChanged()` (~line 2962), add drawer cleanup:

```js
// Add at the top of onChatChanged(), after the logging:
$('#charMemory_drawerBody').html('<div class="charMemory_diagEmpty">Click the <i class="fa-solid fa-syringe"></i> icon on a message to view its injected context.</div>');
$('#charMemory_drawerMsgLabel').text('');
$('#charMemory_drawerFooter').text('');
```

**Step 2: Add default setting for drawer state**

In `loadSettings()`, ensure `injectionDrawerOpen` has a default:

```js
// Add alongside other defaults in loadSettings():
if (extension_settings[MODULE_NAME].injectionDrawerOpen === undefined) {
    extension_settings[MODULE_NAME].injectionDrawerOpen = false;
}
```

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat(injection-viewer): wire drawer to chat lifecycle and settings defaults"
```

---

### Task 5: Manual testing and polish

**Step 1: Test the full flow manually**

1. Open SillyTavern, load a character chat
2. Generate a message — verify the syringe indicator appears on the new AI message
3. Click the syringe indicator — verify the drawer opens with correct data
4. Check CharMemory section shows injected memory bullets
5. Check Lorebook Entries section shows activated WI entries
6. Check Extension Prompts section shows all active prompts
7. Click a different message's indicator — verify drawer updates
8. Generate another message — verify drawer auto-updates to the new message
9. Close and reopen drawer — verify state persists
10. Switch chats — verify drawer clears
11. Open a chat with old messages — verify "No injection data recorded" message shows for pre-feature messages

**Step 2: Test collapsible sections**

1. Click section headers — verify sections collapse/expand
2. Verify chevron rotates on collapse

**Step 3: Test edge cases**

1. Message with no memories injected but lorebook entries present
2. Message with no injections at all (first message of a new chat)
3. Swipe/regenerate — verify snapshot updates for that message index

**Step 4: Fix any issues found during testing**

**Step 5: Final commit**

```bash
git add index.js style.css
git commit -m "fix(injection-viewer): polish and edge case fixes from manual testing"
```

---

### Task 6: Version bump and changelog

**Files:**
- Modify: `manifest.json` (version bump)
- Modify: `CHANGELOG.md` (add entry)

**Step 1: Bump version**

Update `manifest.json` version field (e.g., `1.5.0` -> `1.6.0` or appropriate minor bump).

**Step 2: Add changelog entry**

Add to `CHANGELOG.md`:

```markdown
## [1.6.0] - 2026-02-22

### Added
- **Injection Viewer**: Per-message injection viewer showing what memories, lorebook entries, and extension prompts were injected for each AI response
  - Syringe indicator icon appears on AI messages with recorded injection data
  - "View Injected" button in message action menu
  - Toggleable side drawer with collapsible sections for CharMemory, Lorebook Entries, and Extension Prompts
  - Drawer auto-updates on new generations and persists open/closed state
  - Injection data is stored per-message in chat metadata for historical review
```

**Step 3: Commit**

```bash
git add manifest.json CHANGELOG.md
git commit -m "chore: bump version for injection viewer feature"
```
