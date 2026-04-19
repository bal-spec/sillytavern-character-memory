# Issue #16 Item 2: "Mark Chat as Fully Extracted" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a one-click way to tell CharMemory "this chat is already fully captured in the memory file — don't re-extract." This recovers cleanly from the fork-chat scenario the reporter described in issue #16 item 2, where restoring a Data Bank file to a forked chat leaves `lastExtractedIndex` at -1 and forces full re-extraction.

**Architecture:** Add a new button **"Mark as Fully Extracted"** to the Reset / Clear section of the Troubleshooter modal, alongside the existing "Reset This Chat" button. The button sets `chat_metadata[MODULE_NAME].lastExtractedIndex = context.chat.length - 1` (the opposite of "Reset This Chat", which sets it to -1). Pattern mirrors the existing `resetCurrentChatTracking()` function at `index.js:7917`.

**Tech Stack:** Vanilla JS (ES modules), jQuery, SillyTavern's `callGenericPopup` / `POPUP_TYPE` / `toastr`, `chat_metadata` persistence.

---

## File Map

| File | Change |
|------|--------|
| `index.js` | Add new helper `markChatAsFullyExtracted()` near `resetCurrentChatTracking()` at line 7917; add button HTML in Troubleshooter Reset section near line 6189; add click handler near line 6546 |
| `CHANGELOG.md` | Entry under the in-progress 2.2.0 heading |
| `docs/getting-started.md` | Short note under the Troubleshooter / Reset section explaining when to use the button |

---

## Task 1: Add the `markChatAsFullyExtracted()` helper function

**Files:**
- Modify: `index.js` — add a new function immediately after `resetCurrentChatTracking()` at `index.js:7917-7927`

- [ ] **Step 1: Locate the existing reset helper**

Run: `grep -n "function resetCurrentChatTracking" index.js`
Expected: one match around `index.js:7917`. The function ends with a `}` around line `7927`.

- [ ] **Step 2: Add the new helper right after `resetCurrentChatTracking`**

Insert immediately after the closing `}` of `resetCurrentChatTracking` (around `index.js:7928`):

```javascript
/**
 * Mark the active chat as fully extracted — sets `lastExtractedIndex` to the
 * last message index, so auto-extraction and "Extract Now" treat the chat as
 * caught up. Useful after importing a Data Bank file into a forked chat where
 * the memories already exist but the pointer has been reset.
 */
function markChatAsFullyExtracted() {
    ensureMetadata();
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) {
        toastr.info(t`No messages in this chat to mark as extracted.`, 'CharMemory');
        return;
    }
    const lastIdx = chat.length - 1;
    chat_metadata[MODULE_NAME].lastExtractedIndex = lastIdx;
    chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
    saveMetadataDebounced();
    updateStatusDisplay();
    const msg = isGroupChat()
        ? t`This group chat marked as fully extracted (pointer set to message ${lastIdx}). All members share one pointer.`
        : t`Chat marked as fully extracted (pointer set to message ${lastIdx}). Auto-extraction will resume from the next new message.`;
    toastr.success(msg, 'CharMemory');
    logActivity(`Marked chat as fully extracted: lastExtractedIndex=${lastIdx}`);
}
```

- [ ] **Step 3: Verify the helper compiles by running tests**

Run: `npm test`
Expected: all existing tests still pass (the new helper isn't tested directly, but a parse error would fail the test loader).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(extraction): add markChatAsFullyExtracted helper"
```

---

## Task 2: Add the button + click handler to the Troubleshooter

**Files:**
- Modify: `index.js` — add button HTML around `index.js:6194` (after the Reset This Chat `</div>`)
- Modify: `index.js` — add click handler around `index.js:6558` (after the Reset This Chat handler)

- [ ] **Step 1: Find the Reset This Chat button block**

Run: `grep -n "cm_ts_resetThisChat" index.js`
Expected: two matches — one around `6189` (HTML) and one around `6546` (handler).

- [ ] **Step 2: Insert the new button HTML**

Find the closing `</div>` of the "Reset This Chat" section at `index.js:6194`:

```javascript
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_resetThisChat" data-i18n="Reset This Chat">Reset This Chat</button>
                    <small class="charMemory_helperText">
                        Resets the extraction pointer for the active chat. Next "Extract Now" will re-read all messages in this chat from the first.
                        ${isGroupChat() ? '<br><i class="fa-solid fa-people-group fa-xs"></i> <em>Group chat:</em> all members share one extraction pointer, so this resets all of them at once.' : ''}
                    </small>
                </div>
```

Immediately after this block (before the "Reset Batch Progress" block at `index.js:6195`), insert:

```javascript
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_markFullyExtracted" data-i18n="Mark as Fully Extracted">Mark as Fully Extracted</button>
                    <small class="charMemory_helperText" data-i18n="Tells CharMemory this chat's messages are already captured in the memory file. Useful after importing an existing memory file into a forked chat — prevents full re-extraction.">Tells CharMemory this chat's messages are already captured in the memory file. Useful after importing an existing memory file into a forked chat — prevents full re-extraction.</small>
                </div>
```

- [ ] **Step 3: Insert the click handler**

Find the Reset This Chat handler at `index.js:6546-6558`:

```javascript
    $('#cm_ts_resetThisChat').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const isGroup = isGroupChat();
        const scopeNote = isGroup
            ? `<br><small>${t`This is a group chat — all members share one extraction pointer and will all be reset together.`}</small>`
            : '';
        const confirmed = await callGenericPopup(
            t`The extraction pointer for the active chat will be reset for <strong>${escapeHtml(charName)}</strong>. Next "Extract Now" will re-read all messages in this chat from the first.${scopeNote}`,
            POPUP_TYPE.CONFIRM, t`Reset This Chat`,
        );
        if (!confirmed) return;
        resetCurrentChatTracking();
    });
```

Immediately after this block (before the `#cm_ts_resetBatchProgress` handler), insert:

```javascript
    $('#cm_ts_markFullyExtracted').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const context = getContext();
        const chatLen = context.chat ? context.chat.length : 0;
        if (chatLen === 0) {
            toastr.info(t`No messages in this chat to mark as extracted.`, 'CharMemory');
            return;
        }
        const confirmed = await callGenericPopup(
            t`This will mark all ${chatLen} messages in the active chat for <strong>${escapeHtml(charName)}</strong> as already extracted. Auto-extraction will only process new messages added after this point. Use this if you imported an existing memory file and don't want to re-extract.`,
            POPUP_TYPE.CONFIRM, t`Mark as Fully Extracted`,
        );
        if (!confirmed) return;
        markChatAsFullyExtracted();
    });
```

- [ ] **Step 4: Smoke-test in SillyTavern**

1. Start ST: `cd /Users/davidsayed/repos/SillyTavern && node server.js`
2. Open `http://127.0.0.1:8000`.
3. Load any chat with some messages.
4. Open CharMemory sidebar → click the health dot (or Troubleshooter button) → navigate to the "Reset / Clear" section.
5. Verify the new "Mark as Fully Extracted" button appears between "Reset This Chat" and "Reset Batch Progress".
6. Click it → confirm dialog appears showing the correct message count → click OK → toast shows success message with the last-index value.
7. Open Extract Now or check the status stat bar — should show `0/{interval} msgs` (no backlog).

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(ui): add 'Mark as Fully Extracted' button to Troubleshooter"
```

---

## Task 3: Document the new button

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/getting-started.md` (Troubleshooter section — confirm location first with grep)

- [ ] **Step 1: Locate the in-progress 2.2.0 heading in CHANGELOG**

Run: `grep -n "Extraction lag setting" CHANGELOG.md`
Expected: match inside the current in-progress section. The `### Added` list is where we append.

- [ ] **Step 2: Append a new bullet to the `### Added` list**

Add this line after the "Generation-aware extraction" bullet:

```markdown
- **Mark as Fully Extracted button**: New action in the Troubleshooter's Reset / Clear section that marks the active chat's messages as already extracted. Useful when you've imported an existing memory file into a forked chat and want to stop CharMemory from re-reading every message from the beginning.
```

- [ ] **Step 3: Find the Troubleshooter docs section**

Run: `grep -n "Reset This Chat\|Troubleshooter" docs/getting-started.md`
Expected: one or more matches identifying the Troubleshooter reference section. Read the surrounding lines to find the paragraph that lists reset actions.

- [ ] **Step 4: Add a paragraph describing the new button**

Near the "Reset This Chat" paragraph (or equivalent list item), insert:

```markdown
**Mark as Fully Extracted** — the inverse of "Reset This Chat". Sets the extraction pointer to the last message so CharMemory treats the chat as caught up. Primary use case: you forked a chat and restored its memory file, but the fork reset the extraction pointer; click this to tell CharMemory "don't re-read these messages, their memories are already in the file."
```

(Wording may be adapted slightly to match the surrounding section's tone — the important content is the description of the button and its primary use case.)

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/getting-started.md
git commit -m "docs: document 'Mark as Fully Extracted' button"
```

---

## Self-Review Notes

**Spec coverage:** Issue #16 item 2 — the reporter wants a way to "set the index so that it realized it was already caught up." This plan covers that exactly. No arbitrary-value setter is included (that would be a power-user feature with minimal incremental value); if a user needs to set the pointer to an intermediate value, they can edit `chat_metadata` directly or we can add a number input in a follow-up.

**Design decisions locked in:**
- Button, not a number input — matches how every other Reset/Clear action is a button.
- Placement between "Reset This Chat" and "Reset Batch Progress" — groups semantically with chat-pointer actions.
- Confirmation dialog shows the message count so the user knows exactly what they're committing to.
- Group chats: the helper's messaging acknowledges that the pointer is shared, matching the Reset This Chat pattern.

**Risk callouts:**
- `context.chat.length` can be `0` immediately after chat switch — the empty-chat guard in Task 1 step 2 handles this.
- `chat_metadata[MODULE_NAME]` must exist before we write to it — `ensureMetadata()` handles this (same pattern as `resetCurrentChatTracking`).
- No unit test in this plan — the helper is a thin wrapper around SillyTavern state that a Vitest mock wouldn't meaningfully exercise. Manual smoke-test in Task 2 step 4 covers the critical path.
