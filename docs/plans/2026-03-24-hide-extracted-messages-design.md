# Hide Extracted Messages — Design Spec

**Date:** 2026-03-24
**Branch:** beta
**Scope:** 1:1 chats only (group chat support deferred)

## Problem

After CharMemory extracts memories from chat messages, the original messages remain in the LLM's context window. Since the important information is now stored in the Data Bank and retrieved via Vector Storage, these messages consume context tokens redundantly.

## Solution

Add an opt-in setting that marks extracted messages as hidden from the main LLM prompt after successful extraction. Uses SillyTavern's existing `is_system` visibility mechanism with a CharMemory-specific tag for clean reversibility.

## Data Model

### Per-message tag

```js
chat[i].extra.charMemory_extracted = true
```

Set on each message after successful extraction. This is the source of truth — `is_system` is the visibility effect controlled by the setting. Using `extra` follows ST convention for extension-specific message metadata.

### Setting

```js
extension_settings.charMemory.hideExtractedMessages = false  // default off
```

## Behavior

### On successful extraction (active chat, 1:1 only)

After each chunk is extracted and `lastExtractedIndex` is advanced:

1. Capture the chunk range: `chunkStart = previousLastExtracted + 1` through `chunkEnd = chunkEndIndex` (inclusive). These values must be captured *before* `currentLastExtracted` is updated at ~line 3008.
2. Tag each message in `chat[chunkStart..chunkEnd]` with `extra.charMemory_extracted = true`
3. If `hideExtractedMessages` is enabled, also set `is_system = true` on those messages and update the corresponding `.mes[mesid]` DOM elements' `is_system` attribute to `"true"`
4. Call `saveChatConditional()` to persist the chat array (not `saveMetadataDebounced()`, which only saves `chat_metadata` — the `is_system` and `extra` changes live on the message objects in the `chat[]` array)

**Partial hide on abort:** If multi-chunk extraction is aborted mid-way, chunks already processed will be tagged/hidden and saved. This is acceptable and consistent with the partial `lastExtractedIndex` advancement that already occurs.

**Extraction failure mid-chunk:** If the LLM call fails for a chunk, no messages in that chunk are tagged or hidden. Only successfully extracted chunks are tagged.

### What does NOT trigger hiding

- **Batch extraction** — operates on offline chat files, not the live chat array
- **Group chats** — skipped entirely (deferred scope)
- **Re-extraction after reset** — messages are still collected by `formatChatMessages()` because the filter only skips nameless, non-user system messages. Messages with `msg.name` set (all real chat messages) pass through regardless of `is_system`.
- **Previously unhidden messages** — if a user manually unhides a message (removes `is_system`), subsequent extractions do not re-hide it. Only newly extracted messages are hidden. Note: manual unhide via ST's eye button removes `is_system` but leaves `extra.charMemory_extracted` intact, so the dashboard counter may drift. The Troubleshooter "Unhide" action cleans up both.

### Toggling the setting

- **Turning ON**: Only affects future extractions. Does not retroactively hide already-extracted messages.
- **Turning OFF**: Only affects future extractions. Does not retroactively unhide previously hidden messages.
- **Unhide All**: Available in the Troubleshooter. Scans chat for `extra.charMemory_extracted === true`, sets `is_system = false`, removes the tag, saves. Note: removing the tag is a one-way operation — if the user later re-enables the setting, those messages will not be hidden again unless they fall after `lastExtractedIndex` and are re-extracted.

## UI Touchpoints

### 1. Settings Modal — Advanced section

Checkbox after existing "Memory File Format" controls:

```
[x] Hide extracted messages from context
    After extraction, hides processed messages from the main LLM
    so they don't consume context tokens. Memories are still
    retrieved via Vector Storage. Use "Unhide" in the
    Troubleshooter to reverse.
```

### 2. Troubleshooter — new action

**"Unhide Extracted Messages"** button in the reset/clear tools area:

- Scans `chat` array for messages with `extra.charMemory_extracted === true`
- Sets `is_system = false` on each
- Removes `extra.charMemory_extracted`
- Saves chat
- Shows toast with count: "Unhid N messages"
- Disabled/hidden when no extracted messages exist

### 3. Dashboard — stats indicator

Add hidden message count to the stats bar:

- Format: `"N hidden"` (or omitted if 0)
- Counts messages where `extra.charMemory_extracted === true && is_system === true`

## Safety Properties

| Property | Guarantee |
|----------|-----------|
| Re-extraction safe | `formatChatMessages()` only skips nameless non-user system messages; named messages pass through regardless of `is_system` |
| Reversible | Troubleshooter "Unhide" removes all tags and restores visibility |
| No manual-unhide clobbering | Only newly extracted messages are hidden; previously unhidden messages are not re-hidden |
| No batch interference | Batch extraction operates on disk files, hiding only applies to active chat |
| No group chat risk | Feature is disabled for group chats |
| Default off | No behavior change for existing users unless they opt in |

## Files to Modify

| File | Changes |
|------|---------|
| `index.js` | Add hiding logic after extraction chunk completion (~line 3014); add setting to Advanced section of `showSettingsModal()`; add unhide action to Troubleshooter; add counter to dashboard stats |
| `settings.html` | No changes (dashboard stats bar already exists, counter added dynamically) |
| `test/unit/utils.test.js` | Add test confirming `formatChatMessages` processes `is_system: true` messages with names |
| Locale files (`locales/*.json`) | Add new i18n strings: checkbox label, helper text, toast messages, dashboard indicator |

## Testing Plan

### Automated (Vitest)

- Confirm `formatChatMessages` collects messages with `is_system: true` + `name` set
- Confirm `formatChatMessages` collects messages with `is_system: true` + `is_user: true`

### Manual (SillyTavern)

1. Enable setting → Extract Now → messages get ghost icon
2. Disable setting → next extraction → no hiding
3. Troubleshooter Unhide → messages restored, tags removed
4. Reset extraction state → re-extract → hidden messages still processed
5. Manually unhide one message → auto-extract → stays unhidden
6. Group chat → verify hiding does not occur
7. Batch extraction → verify no hiding
8. Dashboard counter shows correct count
9. Extraction fails mid-chunk (e.g., LLM error) → verify only successfully extracted messages are tagged, not the entire planned range
10. Multi-chunk extraction aborted after first chunk → verify first chunk is hidden, remaining chunks are not
