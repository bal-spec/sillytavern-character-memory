# Per-Chat Memory Isolation — Revised Design

**Date:** 2026-03-06
**Status:** Proposed — seeking feedback from The_Istar before implementation
**Trigger:** Reddit thread (The_Istar) — each chat should have its own memories with no cross-chat bleed

---

## Problem

When `perChat` mode is enabled, CharMemory writes a separate memory file per chat. However, Vector Storage retrieves from *all* files in the character's Data Bank simultaneously. A character with 10 chats has 10 memory files, and VS retrieves relevant chunks across all of them — so memories from one story bleed into unrelated chats.

The user wants: opening chat A should only surface memories from chat A. No manual file management.

---

## Why the `disabled_attachments` Toggle Approach Won't Work

We investigated automating the manual workaround (toggling file visibility on chat switch). Research into SillyTavern's internals revealed three structural blockers:

### 1. URL Volatility

`disabled_attachments` is a flat array of URL strings (e.g. `"DATA:/uploads/global/abc123.md"`). Lookup is strict URL equality — there is no name-based matching.

CharMemory's `writeMemoriesForCharacter()` deletes and re-uploads the memory file on every extraction, generating a **new server URL** each time. Any URL we add to the disabled list goes stale within one extraction cycle. The file reappears in VS retrieval silently.

We could work around this by resolving filenames to URLs on every chat switch, but this adds fragile coupling to SillyTavern's internal attachment URL format.

### 2. Race Conditions

On chat switch, `CHAT_CHANGED` fires and multiple extensions respond asynchronously with no ordering guarantee. Vector Storage runs as a `generate_interceptor` (called before prompt building, sorted by loading order). There is no safe hook where CharMemory can modify `disabled_attachments` and be guaranteed that VS will see the updated list before its next retrieval.

### 3. Shared Global State

`disabled_attachments` is used by Vector Storage, the Data Bank UI, the `/db-disable` slash command, and potentially other extensions. Silently modifying it on every chat switch risks:
- Overwriting user's manual visibility settings
- Files appearing greyed out in the Data Bank UI with no explanation
- Conflict loops if the user re-enables files that CharMemory keeps disabling

---

## Recommended Approach: `chat_metadata` Storage + Direct Injection

Bypass Data Bank and Vector Storage entirely for isolated per-chat memories.

### How It Works

1. **Storage:** Extracted memories are written to `chat_metadata[MODULE_NAME].isolatedMemories` (plain text, same markdown format as current memory files). Since `chat_metadata` is per-chat by definition, isolation is structural — no visibility management needed.

2. **Injection:** On `GENERATE_BEFORE_COMBINE_PROMPTS` (or similar pre-generation event), CharMemory calls `context.setExtensionPrompt()` to inject the current chat's memories into the prompt, up to a configurable token budget. This is the same stable API used by Author's Note, Summarize, and Vector Storage itself.

3. **Extraction:** The extraction pipeline reads existing memories from `chat_metadata` instead of the Data Bank file, so it avoids re-extracting what's already captured.

### Trade-offs

| | Current (VS-based) | Isolated mode |
|---|---|---|
| Retrieval | Semantic — top-N relevant chunks | All memories up to token budget |
| Isolation | Cross-chat bleed | Fully isolated per-chat |
| Storage | Data Bank file (visible in UI) | `chat_metadata` field (travels with chat) |
| VS required | Yes | No |
| Consolidation | Works (operates on Data Bank file) | Works (operates on `chat_metadata` text) |
| Data Bank visible | Yes | No (viewable via CharMemory UI) |

**Losing semantic search:** For the isolation use case, this is acceptable. Per-chat memory pools are smaller than all-chats-pooled. The user wants *all* memories from this chat available, not a filtered subset. A token budget replaces relevance filtering.

### Setting Hierarchy

```
perChat: false                         → single file per character, VS retrieval (unchanged)
perChat: true                          → separate file per chat, VS retrieval (unchanged, current behavior)
perChat: true + isolatePerChat: true   → per-chat storage in chat_metadata, direct injection, no VS
```

`isolatePerChat` is only available when `perChat` is enabled.

---

## Open Questions for Discussion

### 1. Token Budget

What's the right default for how much memory text to inject? Memory files can grow large over long chats. A configurable character limit (e.g. 4000 chars default) would cap injection size. Should it inject the most recent memories, or truncate from the oldest?

### 2. Injection Position

Where in the prompt should isolated memories appear? Options:
- Same position as VS injection (consistent with current behavior)
- Author's Note style depth-based positioning
- A dedicated configurable position in Settings

### 3. What Happens to Existing Per-Chat Data Bank Files?

Enabling isolation mode does NOT delete existing Data Bank files. They remain visible to VS and could still cause bleed. Options:
- Show a warning explaining this when the setting is enabled
- Offer a one-click "migrate and clean up" tool in the Troubleshooter that imports existing per-chat files into `chat_metadata` and removes them from the Data Bank
- Do both

### 4. Migration Path

Users switching from regular `perChat` mode to isolated mode should be able to import their existing memories. A migration tool could:
- Scan Data Bank for per-chat files matching the naming pattern
- Import each file's content into the corresponding chat's `chat_metadata`
- Optionally delete the Data Bank files after import

### 5. Viewing and Editing

Memories stored in `chat_metadata` aren't visible in the Data Bank UI. CharMemory needs:
- Memory Manager already works (it calls `readMemoriesForCharacter` — just needs to branch to read from `chat_metadata` in isolated mode)
- A "View isolated memories" section in the Troubleshooter for debugging
- Export capability (download as .md)

### 6. Group Chats

In group chats, each character has separate memories. Proposed data structure:

```js
// 1:1 chat
chat_metadata.charMemory.isolatedMemories = "<memory> blocks as plain text"

// Group chat (keyed by avatar filename)
chat_metadata.charMemory.isolatedMemories = {
  "character-a.png": "<memory> blocks...",
  "character-b.png": "<memory> blocks..."
}
```

---

## Implementation Scope (When Ready)

1. Add `isolatePerChat: false` to default settings
2. Add UI toggle in Settings > Storage (shown only when `perChat` is on), with warning about existing Data Bank files
3. Branch `readMemoriesForCharacter()` and `writeMemoriesForCharacter()` to use `chat_metadata` in isolated mode
4. Add injection hook via `setExtensionPrompt()` with configurable token budget
5. Update extraction pipeline to read existing memories from `chat_metadata`
6. Add "View isolated memories" to Troubleshooter
7. Build migration tool for importing existing per-chat Data Bank files
8. Update Memory Manager, Consolidation, and other tools to work with `chat_metadata` source
