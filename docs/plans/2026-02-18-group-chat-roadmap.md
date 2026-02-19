# Roadmap: Group Chat Memory Support

**Date**: 2026-02-18
**Status**: Future roadmap item

## Problem

SillyTavern group chats present a memory challenge. CharMemory stores memories as Data Bank files and relies on Vector Storage for retrieval. In group chats:

- **Per-character Data Bank files exist** — SillyTavern switches `this_chid` for each character's turn, so each character's attachments load correctly.
- **Vector Storage queries once for the whole group** — it does NOT re-query per character. All group members get the same retrieved chunks injected, regardless of whose memories they are.
- **Character lorebooks DO work per-character in groups** — SillyTavern reloads each character's bound lorebook for their turn.

This means Data Bank + Vector Storage gives no character-level scoping in group chats. Character A's private memories could be injected into Character B's generation.

## Requirements for Group Memory

1. **Private memories** — things only that character knows (backstory reveals, private conversations)
2. **Shared memories** — events that happened in the group that everyone witnessed
3. **Partial knowledge** — Character A and B were in a scene but C wasn't

## Approach: Dual-Write (Data Bank + Lorebook)

Keep the Data Bank as the primary storage (proven, simple, works for 1:1 chats). Add optional lorebook dual-write that unlocks group chat compatibility.

### How It Works

- **Data Bank** (existing): CharMemory writes memories to character Data Bank files as it does today. Vector Storage handles retrieval for 1:1 chats.
- **Lorebook** (new, opt-in): When enabled, CharMemory also writes each memory block as a lorebook entry. Since SillyTavern's lorebook system is per-character in group chats, each character only sees their own memory entries during their generation turn.

### User Setting

A toggle in Settings: "Also write to lorebook" (default: off). When enabled, every extraction writes to both Data Bank and lorebook. The Data Bank file remains the source of truth; lorebook entries are a derived copy for retrieval.

## MemoryBooks Compatibility

The [SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) extension uses lorebook entries for memory storage. CharMemory's lorebook entries should be compatible with MemoryBooks' format so the two extensions can coexist.

### MemoryBooks Entry Format

MemoryBooks identifies its entries with:
- `stmemorybooks: true` flag
- Numbered titles: `[001] - Title`
- Keywords array for activation
- `vectorized: true`, `selective: true` for retrieval
- Standard lorebook fields (`position: 0`, `depth: 4`, `probability: 100`, etc.)

### Mapping CharMemory Blocks to Lorebook Entries

| CharMemory | Lorebook entry field |
|---|---|
| `block.chat` (theme/chat name) | `comment` (entry title, with `[NNN]` prefix) |
| `block.bullets.join('\n')` | `content` |
| Block index | `[001]`, `[002]`, etc. numbering |
| `block.date` | Could include in title template |
| TBD | `key` (activation keywords) |

### SillyTavern APIs Needed

```javascript
import { createWorldInfoEntry, saveWorldInfo, loadWorldInfo } from '../../../world-info.js';
```

These are the same APIs MemoryBooks uses. CharMemory would call them after its existing `writeMemories()` to Data Bank.

## Open Questions

### Keyword Extraction

MemoryBooks entries use keyword arrays for lorebook activation. CharMemory doesn't extract keywords today. Options to explore later:
1. Add keyword extraction to the extraction prompt
2. Auto-derive keywords from bullet text (no extra LLM call)
3. Rely on vectorized mode only (keywords optional)

### Private vs Shared Memories in Groups

When extracting from a group chat, how to determine which memories are private to one character vs shared knowledge:
- All memories from group chat could be shared (simplest)
- Character-specific memories could be tagged by who was "speaking" when the event occurred
- User could manually scope memories after extraction

### Consolidation Sync

When the user consolidates memories (which modifies the Data Bank file), the lorebook entries would need to be regenerated to stay in sync. Options:
- Re-sync lorebook entries after every consolidation
- Treat lorebook as append-only and only sync on explicit user action
- Delete and recreate lorebook entries from the Data Bank file on demand

### Existing CharMemory Data Bank Files

Users with existing memories in Data Bank files would need a migration path:
- "Sync to Lorebook" button that reads all current memories and creates lorebook entries
- Could be one-time or repeatable

## What We Can Reuse

The entire extraction pipeline is storage-agnostic:
- Provider system and all supported APIs
- Extraction prompt and chunk processing
- Consolidation (themed blocks, presets, preview/undo)
- Batch extraction
- Activity log, diagnostics, settings UI
- Memory format (`<memory>` blocks with bullets) as internal representation

Only the storage layer needs a new backend. The extraction pipeline produces structured memory blocks — it doesn't care where they end up.
