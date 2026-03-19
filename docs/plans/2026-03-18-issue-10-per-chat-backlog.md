# Issue #10: Per-Chat Memory Storage — Backlog Analysis

**Date:** 2026-03-18
**Status:** Backlog
**Issue:** https://github.com/bal-spec/sillytavern-character-memory/issues/10
**Prior design:** `2026-03-06-per-chat-isolation-revised.md`

---

## Summary

User request: memories should be stored per-chat rather than per-character, so different storylines/chats don't share memories.

The extension author's preference is character-level memories (the current default), but some users want per-chat isolation. The solution should support both as an optional setting.

## Proposed UX

Single dropdown in Settings > Storage:

```
Memory scope: [Character (default)] / [Chat]
```

- **Character** (default): Current behavior. Memories stored in Character Data Bank, shared across all chats, VS handles retrieval.
- **Chat**: Memories stored in Chat Attachments (`chat_metadata.attachments`), scoped to the active chat only. VS retrieves only from that chat's attachments.

## Architecture: Chat Attachments vs chat_metadata

Two storage options were analyzed:

### Option A: Chat Attachments (Recommended for simplicity)

Use ST's existing `chat_metadata.attachments` system — the same API as Character Attachments but scoped per-chat. VS already knows how to vectorize and retrieve from chat attachments.

**Pros:** Reuses existing ST infrastructure, visible in Data Bank UI, VS retrieval works automatically.
**Cons:** Cross-chat bleed still possible if VS retrieves from both character AND chat attachments simultaneously.

### Option B: chat_metadata direct storage + setExtensionPrompt injection

Store memories in `chat_metadata.charMemory.isolatedMemories` and inject via `setExtensionPrompt()`, bypassing VS entirely. Full design in `2026-03-06-per-chat-isolation-revised.md`.

**Pros:** Complete isolation guaranteed, no VS dependency.
**Cons:** Loses semantic retrieval, requires reimplementing injection, more code surface area.

## Risk Analysis

### Code Impact

48 references to the character attachment system (`extension_settings.character_attachments`, `getDataBankAttachments`, `writeMemoriesForCharacter`, etc.) would need branching to support chat-scoped storage. Key functions:

- `getMemoryFileName()` — currently uses character avatar; would need chat-scoped variant
- `writeMemoriesForCharacter()` — writes to Character Data Bank; needs Chat Data Bank path
- `readMemoriesForCharacter()` — reads from Character Data Bank; needs Chat Data Bank path
- All Troubleshooter file operations (view, edit, delete)
- Memory Manager, Consolidation, Format/Convert tools

### Known Bug: Batch Extraction in Per-Chat Mode

`getMemoryFileName()` uses `context.chatId` which is always the *active* chat's ID. Batch extraction iterates over multiple chats but the file name function doesn't accept a chat ID parameter. This means batch-extracted memories from non-active chats get written to the wrong file.

**Recommendation:** Disable batch extraction when chat-scoped mode is active, or fix `getMemoryFileName()` to accept an explicit chat ID parameter.

### Group Chats

Group chats add complexity — each character in the group has separate memories, but `chat_metadata` is shared across all group members. Data structure would need per-character keying within the chat metadata.

**Recommendation:** Scope initial implementation to 1:1 chats only. Show a warning if chat mode is enabled in a group chat.

## Testing Strategy

- **Automated (Playwright):** Storage mode switching, verify memories write to correct location (character vs chat attachments), verify isolation (chat A memories don't appear in chat B)
- **Manual:** Full extraction cycle in chat mode, verify VS retrieval scoping, test mode switching with existing memories

## Implementation Priority

Low-medium. The current character-level default works well for most users. This is an opt-in feature for users with specific multi-storyline use cases. No timeline set.

## Dependencies

- Fix `getMemoryFileName()` chat ID bug (regardless of this feature)
- Understand VS retrieval scoping for chat attachments vs character attachments
- Decide on migration path for users switching between modes
