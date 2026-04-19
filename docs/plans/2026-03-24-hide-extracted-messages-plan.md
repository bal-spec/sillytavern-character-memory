# Hide Extracted Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in setting that hides extracted chat messages from the main LLM context, saving context window tokens while memories remain available via Vector Storage.

**Architecture:** After each successful extraction chunk, tag processed messages with `extra.charMemory_extracted = true` and optionally set `is_system = true` to hide them from the LLM prompt. Scoped to 1:1 chats only. Reversible via a Troubleshooter action.

**Tech Stack:** JavaScript (browser extension), jQuery, Vitest

**Spec:** `docs/plans/2026-03-24-hide-extracted-messages-design.md`

---

### Task 1: Add unit tests for `formatChatMessages` with hidden messages

Confirm that the extraction pipeline continues to process messages marked as `is_system: true` when they have a name or `is_user` flag — proving re-extraction safety.

**Files:**
- Modify: `test/unit/utils.test.js:159-165` (add tests after existing `'keeps system messages that have a name'` test)

- [ ] **Step 1: Write two failing tests**

Add these tests inside the existing `describe('formatChatMessages', ...)` block, after the test at line 164:

```js
it('keeps hidden user messages (is_system + is_user)', () => {
    const chat = [
        makeMsg('Human', 'I told you a secret', { is_system: true, is_user: true }),
        makeMsg('Alice', 'I remember'),
    ];
    const result = formatChatMessages(chat, 0, chat.length);
    expect(result.text).toContain('Human: I told you a secret');
    expect(result.messageCount).toBe(2);
});

it('keeps hidden character messages (is_system + name)', () => {
    const chat = [
        makeMsg('Alice', 'She whispered softly', { is_system: true }),
        makeMsg('Human', 'I heard you', { is_user: true }),
    ];
    const result = formatChatMessages(chat, 0, chat.length);
    expect(result.text).toContain('Alice: She whispered softly');
    expect(result.messageCount).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they pass**

These should pass immediately — the existing `formatChatMessages` logic already handles this. We are confirming the safety property, not adding new behavior.

Run: `cd /Users/davidsayed/repos/sillytavern-character-memory && npm test`
Expected: All tests PASS, including the two new ones.

- [ ] **Step 3: Commit**

```bash
git add test/unit/utils.test.js
git commit -m "test: confirm formatChatMessages processes hidden named messages

Adds two tests verifying that messages with is_system=true are still
collected when they have a name or is_user flag. This is a safety
property for the hide-extracted-messages feature."
```

---

### Task 2: Add `hideExtractedMessages` setting with default

Register the new setting in `defaultSettings` so it initializes correctly for new and existing users.

**Files:**
- Modify: `index.js:483` (add to `defaultSettings` object, after `protectRecentMessagesCount`)

- [ ] **Step 1: Add the setting to `defaultSettings`**

In `index.js`, inside the `defaultSettings` object (around line 483), add after the `protectRecentMessagesCount: 4` line:

```js
    hideExtractedMessages: false,
```

- [ ] **Step 2: Verify no test regressions**

Run: `cd /Users/davidsayed/repos/sillytavern-character-memory && npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add hideExtractedMessages setting (default off)"
```

---

### Task 3: Add hiding logic to the extraction pipeline

After each successful extraction chunk, tag messages and optionally hide them. This is the core behavior change.

**Files:**
- Modify: `index.js:3014-3015` (add hiding logic after `lastExtractedIndex` advancement)

**Important context:**
- The extraction loop is at `index.js:2843`. Each iteration calls `collectRecentMessages()` which returns `{ text, startIndex, endIndex }` (line 2852).
- `currentLastExtracted` holds the previous chunk's end index (or the initial `lastExtractedIndex`). The new chunk starts at `currentLastExtracted + 1`.
- After extraction, `currentLastExtracted` is updated to `chunkEndIndex` at line 3008.
- `isActiveChat` is a boolean already computed above this loop — only true for the active chat.
- `chat` variable refers to `chatArray` parameter or `context.chat`.
- For saving the chat array, use `getContext().saveChat()` — this is the pattern ST's built-in memory extension uses. `saveMetadataDebounced()` only saves `chat_metadata`, not the message objects.

- [ ] **Step 1: Add the `hideExtractedChunk` helper function**

Add this function before the `extractMemories` function (around line 2700). It handles tagging and hiding for a range of messages:

```js
/**
 * Tag extracted messages and optionally hide them from the main LLM context.
 * Only applies to the active 1:1 chat. Group chats and batch extraction are skipped.
 * @param {Array} chatArray - The chat array to modify
 * @param {number} startIdx - First message index in the extracted chunk (inclusive)
 * @param {number} endIdx - Last message index in the extracted chunk (inclusive)
 * @param {boolean} isActiveChat - Whether this is the active chat (false for batch extraction)
 */
function hideExtractedChunk(chatArray, startIdx, endIdx, isActiveChat) {
    if (!isActiveChat || isGroupChat()) return;

    const shouldHide = extension_settings[MODULE_NAME].hideExtractedMessages;
    let taggedCount = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const msg = chatArray[i];
        if (!msg) continue;

        // Don't re-tag messages that were already extracted and manually unhidden
        if (msg.extra?.charMemory_extracted) continue;

        if (!msg.extra) msg.extra = {};
        msg.extra.charMemory_extracted = true;
        taggedCount++;

        if (shouldHide) {
            msg.is_system = true;
            // Update DOM if the message element exists
            $(`.mes[mesid="${i}"]`).attr('is_system', 'true');
        }
    }

    if (taggedCount > 0) {
        if (shouldHide) {
            logActivity(`Tagged and hid ${taggedCount} extracted message(s) (indices ${startIdx}-${endIdx})`);
        } else {
            logActivity(`Tagged ${taggedCount} extracted message(s) (indices ${startIdx}-${endIdx})`);
        }
    }
}
```

- [ ] **Step 2: Call `hideExtractedChunk` after each chunk's index advancement**

In the extraction loop, after line 3014 (`logActivity('Advanced lastExtractedIndex to ...')`), add:

```js
                // Tag/hide extracted messages in this chunk
                const chunkStartIdx = Math.max(0, (chunk === 0 ? (lastExtractedIdx ?? meta.lastExtractedIndex ?? -1) : prevChunkEnd) + 1);
```

Wait — the chunk start is simpler to derive. Looking at the loop: `collectRecentMessages` is called with `lastExtractedIdx: currentLastExtracted`. So the chunk starts at `currentLastExtracted + 1` *before* the update at line 3008. We need to capture this before the update.

Insert **before** line 3008 (`currentLastExtracted = chunkEndIndex ...`):

```js
            const chunkStartIdx = Math.max(0, currentLastExtracted + 1);
```

Then **after** line 3014 (the `logActivity` for advancing index), add:

```js
                hideExtractedChunk(chatArray || getContext().chat, chunkStartIdx, currentLastExtracted, isActiveChat);
```

- [ ] **Step 3: Add `saveChat` call after extraction completes**

In the "Final status updates" section (around line 3034-3038), after `saveMetadataDebounced()`, add a chat save to persist the `extra.charMemory_extracted` tags and any `is_system` changes:

```js
            // Save chat to persist extraction tags and hidden state
            if (extension_settings[MODULE_NAME].hideExtractedMessages || totalMemories > 0) {
                getContext().saveChat();
            }
```

This goes after line 3037 (`saveMetadataDebounced()`), inside the `if (isActiveChat)` block.

- [ ] **Step 4: Verify no test regressions**

Run: `cd /Users/davidsayed/repos/sillytavern-character-memory && npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: tag and hide extracted messages in the extraction pipeline

After each successful extraction chunk, messages are tagged with
extra.charMemory_extracted=true. When hideExtractedMessages is enabled,
they are also marked is_system=true to exclude them from LLM context.

Scoped to active 1:1 chats only. Already-tagged messages (e.g. manually
unhidden) are not re-tagged or re-hidden."
```

---

### Task 4: Add checkbox to Settings Modal Advanced section

Add the UI control for the `hideExtractedMessages` setting.

**Files:**
- Modify: `index.js` — the `advancedHtml` template string (around line 4048-4050, between the chunk metadata controls and the `<hr>` before the Reset section)

- [ ] **Step 1: Add the checkbox HTML**

In the `advancedHtml` template string, after the `cm_modal_chunkMetadataRow` div (line 4048) and before the `<hr class="charMemory_separator" />` at line 4050, add:

```js
        <div class="charMemory_statusRow" style="margin-top:8px;">
            <label class="checkbox_label" for="cm_modal_hideExtracted">
                <input type="checkbox" id="cm_modal_hideExtracted" ${s.hideExtractedMessages ? 'checked' : ''} />
                <span data-i18n="Hide extracted messages from context">Hide extracted messages from context</span>
            </label>
            <small class="charMemory_helperText" data-i18n="After extraction, hides processed messages from the main LLM so they don't consume context tokens. Memories are still retrieved via Vector Storage. Use &quot;Unhide&quot; in the Troubleshooter to reverse.">After extraction, hides processed messages from the main LLM so they don't consume context tokens. Memories are still retrieved via Vector Storage. Use "Unhide" in the Troubleshooter to reverse.</small>
        </div>
```

- [ ] **Step 2: Wire the change handler**

Find where the other Advanced section handlers are wired (search for `cm_modal_chunkBoundary` or `cm_modal_displayMode` change handlers — they should be in a block starting around line 4300-4400). Add:

```js
    $('#cm_modal_hideExtracted').off('change').on('change', function () {
        extension_settings[MODULE_NAME].hideExtractedMessages = $(this).is(':checked');
        saveSettingsDebounced();
    });
```

- [ ] **Step 3: Verify no test regressions**

Run: `cd /Users/davidsayed/repos/sillytavern-character-memory && npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: add 'Hide extracted messages' checkbox to Settings Modal

Adds the toggle to the Advanced section. Default off. Persists via
saveSettingsDebounced()."
```

---

### Task 5: Add "Unhide Extracted Messages" to Troubleshooter

Add a reversibility action in the Troubleshooter's Reset / Clear section.

**Files:**
- Modify: `index.js` — the `showTroubleshooter` function, Reset section HTML (around line 6091-6094) and event handlers (after line 6115)

- [ ] **Step 1: Add the button HTML**

In the Troubleshooter's Reset / Clear section, after the "Reset Batch Progress" block (line 6089) and before the "Clear All Memories" block (line 6091), add a new reset section:

```js
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_unhideExtracted" data-i18n="Unhide Extracted Messages">Unhide Extracted Messages</button>
                    <small class="charMemory_helperText" data-i18n="Restores all messages that CharMemory hid after extraction. Makes them visible to the main LLM again and removes extraction tags.">Restores all messages that CharMemory hid after extraction. Makes them visible to the main LLM again and removes extraction tags.</small>
                </div>
```

- [ ] **Step 2: Wire the click handler**

After the existing Troubleshooter event handlers (search for `cm_ts_clearMemories` handler), add:

```js
    $('#cm_ts_unhideExtracted').off('click').on('click', async function () {
        const context = getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) {
            toastr.info(t`No chat loaded.`, 'CharMemory');
            return;
        }

        let count = 0;
        for (let i = 0; i < chat.length; i++) {
            if (chat[i].extra?.charMemory_extracted) {
                chat[i].is_system = false;
                delete chat[i].extra.charMemory_extracted;
                $(`.mes[mesid="${i}"]`).attr('is_system', 'false');
                count++;
            }
        }

        if (count === 0) {
            toastr.info(t`No hidden extracted messages found.`, 'CharMemory');
            return;
        }

        await context.saveChat();
        updateStatusDisplay();
        toastr.success(t`Unhid ${count} message(s).`, 'CharMemory');
        logActivity(`Unhid ${count} extracted message(s)`, 'success');
    });
```

- [ ] **Step 3: Verify no test regressions**

Run: `cd /Users/davidsayed/repos/sillytavern-character-memory && npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: add 'Unhide Extracted Messages' action to Troubleshooter

Scans chat for messages tagged with charMemory_extracted, removes the
tag, restores is_system to false, and saves. Provides full reversibility
for the hide-extracted-messages feature."
```

---

### Task 6: Add hidden message count to dashboard stats bar

Show users how many messages are currently hidden by CharMemory.

**Files:**
- Modify: `settings.html:44-45` (add a new stat item after the cooldown stat)
- Modify: `index.js:1573-1616` (update `updateStatusDisplay()` to populate the counter)

- [ ] **Step 1: Add the stat item to settings.html**

After the cooldown stat item (line 44-45, the `charMemory_statCooldown` span), and before the health stat item (line 46), add:

```html
                <div class="charMemory_statItem" id="charMemory_statHiddenWrap" style="display:none;" title="Messages hidden from context after extraction" data-i18n="[title]Messages hidden from context after extraction">
                    <i class="fa-solid fa-eye-slash fa-sm"></i>
                    <span id="charMemory_statHidden">0 hidden</span>
                </div>
```

Using `display:none` by default — it only shows when there are hidden messages (to avoid clutter when the feature is off).

- [ ] **Step 2: Add counter logic to `updateStatusDisplay()`**

In `index.js`, inside `updateStatusDisplay()`, after the cooldown display update (after line 1616 `startCooldownTimer()`), add:

```js
    // Stats bar: hidden extracted messages count
    const chat = getContext().chat;
    if (chat && chat.length > 0) {
        let hiddenCount = 0;
        for (const msg of chat) {
            if (msg.extra?.charMemory_extracted && msg.is_system) hiddenCount++;
        }
        if (hiddenCount > 0) {
            $('#charMemory_statHidden').text(t`${hiddenCount} hidden`);
            $('#charMemory_statHiddenWrap').show();
        } else {
            $('#charMemory_statHiddenWrap').hide();
        }
    } else {
        $('#charMemory_statHiddenWrap').hide();
    }
```

- [ ] **Step 3: Verify no test regressions**

Run: `cd /Users/davidsayed/repos/sillytavern-character-memory && npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add index.js settings.html
git commit -m "feat: show hidden message count in dashboard stats bar

Displays 'N hidden' with eye-slash icon when extracted messages are
hidden from context. Hidden when count is 0 to avoid clutter."
```

---

### Task 7: Add i18n strings to locale files

Add translatable strings for the new UI elements.

SillyTavern's i18n uses English text as the key directly (via `data-i18n` attributes). There is no `en.json` — English strings are the keys themselves. Locale files only contain translations for non-English languages.

**Files:**
- Modify: `locales/fr-fr.json` (add French translations)
- Modify: `locales/zh-tw.json` (add Traditional Chinese translations)
- Modify: `locales/your-lang.json` (add empty placeholders for the template)

- [ ] **Step 1: Add empty placeholder keys to `locales/your-lang.json`**

Add the following keys with empty string values (the template file for new translators):

```json
"After extraction, hides processed messages from the main LLM so they don't consume context tokens. Memories are still retrieved via Vector Storage. Use \"Unhide\" in the Troubleshooter to reverse.": "",
"Hide extracted messages from context": "",
"Messages hidden from context after extraction": "",
"No hidden extracted messages found.": "",
"Restores all messages that CharMemory hid after extraction. Makes them visible to the main LLM again and removes extraction tags.": "",
"Unhide Extracted Messages": ""
```

- [ ] **Step 2: Add French translations to `locales/fr-fr.json`**

Add translated strings (use existing file's translation style as reference). If uncertain about translations, add empty strings and mark with a `TODO` comment for a native speaker to review.

- [ ] **Step 3: Add Traditional Chinese translations to `locales/zh-tw.json`**

Same approach as Step 2.

- [ ] **Step 4: Commit**

```bash
git add locales/
git commit -m "i18n: add strings for hide-extracted-messages feature"
```

---

### Task 8: Manual integration testing in SillyTavern

Verify all behaviors work end-to-end in a real SillyTavern instance.

**Files:** None (testing only)

- [ ] **Step 1: Start SillyTavern**

Run: `cd /Users/davidsayed/repos/SillyTavern && node server.js`
Open: http://127.0.0.1:8000

- [ ] **Step 2: Test basic hide flow**

1. Open a 1:1 chat with enough unextracted messages
2. Open Settings Modal → Advanced → enable "Hide extracted messages from context"
3. Click "Extract Now" on the dashboard
4. Verify: extracted messages show ghost icon (👻) and "This message is invisible for the AI"
5. Verify: dashboard stats bar shows "N hidden" with eye-slash icon
6. Verify: Activity Log shows "Tagged and hid N extracted message(s)"

- [ ] **Step 3: Test unhide flow**

1. Open Troubleshooter → Reset / Clear tab
2. Click "Unhide Extracted Messages"
3. Verify: toast shows "Unhid N message(s)"
4. Verify: messages no longer show ghost icon
5. Verify: dashboard "hidden" counter disappears

- [ ] **Step 4: Test setting-off behavior**

1. Disable "Hide extracted messages from context" in Settings
2. Send enough messages to trigger auto-extraction
3. Verify: messages are NOT hidden after extraction (but `extra.charMemory_extracted` tag is still set — check via browser console: `chat[idx].extra`)

- [ ] **Step 5: Test re-extraction safety**

1. Enable "Hide extracted messages"
2. Run Extract Now (messages get hidden)
3. Open Settings Modal → Advanced → click "Reset This Chat"
4. Run Extract Now again
5. Verify: hidden messages are still extracted (check Activity Log for message count)

- [ ] **Step 6: Test manual unhide persistence**

1. Right-click a hidden message → click the eye icon to manually unhide it
2. Run another extraction (send more messages first)
3. Verify: the manually unhidden message stays visible (not re-hidden)

- [ ] **Step 7: Test group chat exclusion**

1. Open a group chat
2. Verify: the checkbox in Advanced is present but extraction does NOT hide messages (check Activity Log — no "Tagged and hid" entry)

- [ ] **Step 8: Test batch extraction exclusion**

1. Open a 1:1 chat with the setting enabled
2. Run Batch Extract from the dashboard
3. Verify: batch extraction does not hide any messages (it operates on offline chat files)
