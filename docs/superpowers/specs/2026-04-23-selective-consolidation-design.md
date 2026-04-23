# Selective Consolidation — Design Spec

**Date:** 2026-04-23
**Context:** follow-up to chunked consolidation (shipped same day). User feedback from long-roleplay user `sarawr18`:
> "When I consolidate, it has to consolidate everything, even the old stuff and the new. After a few consolidations, it's re-writes of re-writes of re-writes and sometimes the memories from the older stuff gets a bit off base… So would be cool if you could choose which chunks to consolidate."

## Problem

Every call to Consolidate passes all of a character's memory blocks to the LLM. Blocks that were produced by a previous consolidation get re-summarized each run, creating a lossy-compression ratchet: details drift further from the original with every pass. Users who consolidate regularly report that older memories eventually "get a bit off base."

## Goal

Let users consolidate only the parts of their memory file that need it — typically the newly-extracted blocks — while leaving previously-consolidated blocks verbatim. The default behavior should be "it just works" (no new UI step in the common case); an override surface should exist for edge cases.

## Non-goals

- **Persistent per-block "protected" flag** — schema change, migration, new Memory Manager UI surface. Defer to a follow-up if the heuristic turns out to be insufficient. v1 uses an ephemeral per-run classification.
- **Smart age-based heuristics** (e.g., "only blocks newer than N days") — the chat-attribute heuristic is enough for the reported case.
- **Reformat/convert parity** — reformat is a 1:1 transformation with no lossy compression, so it does not need selective treatment.
- **Changes to the consolidation prompt** — the prompt still receives a list of blocks, just a smaller one.

## Design

### Pipeline change: add a pre-LLM filter stage

```
consolidateMemories()
  │
  ├── readMemoriesForCharacter() → all blocks
  │
  ├── classifyBlocksForConsolidation(all) → { eligible, protected }
  │     └─ Pure heuristic, unit-testable.
  │
  ├── If protected.length > 0:
  │     show a brief confirm popup —
  │     "Protecting N previous consolidations. Consolidating M new blocks.
  │      [Change selection…] [Proceed]"
  │     └─ "Change selection…" → showBlockSelectionModal(all, eligible)
  │        returns user's final eligible set (ephemeral; no persistence)
  │
  ├── If eligible.length < 2 → toastr "Nothing new to consolidate" → abort
  │
  ├── Dispatch to existing single-call OR chunked consolidation
  │     (UNCHANGED — operates on eligible only)
  │
  ├── Receive newlyConsolidated from LLM
  │
  ├── finalBlocks = [...protected, ...newlyConsolidated]   // chronological
  │
  └── Open existing preview editor with finalBlocks
        │
        └── User Apply → write finalBlocks to memory file
```

This slots in at one point — between "read memories" and "dispatch to orchestrator." No changes to `consolidation.js`, the `lib.js` chunking helpers, the extraction prompt, or the preview editor infrastructure.

### Components

**New pure function in `lib.js`:**

| Function | Signature | Behavior |
|---|---|---|
| `classifyBlocksForConsolidation` | `(memories) => { eligible: MemoryBlock[], protected: MemoryBlock[] }` | Iterates blocks; each block goes to `protected` if its `chat` attribute **fails the ID pattern** `^[a-zA-Z0-9_-]+$` (i.e., empty, whitespace-containing, or contains non-ID punctuation), OR if the block is structurally invalid (missing `bullets` array). Otherwise it goes to `eligible`. The literal `"unknown"` placeholder inserted by `parseMemories()` for missing `chat` attributes is also treated as protected (defensive). Preserves block order within each bucket. Pure; no side effects. |

Rationale for the heuristic: SillyTavern chat IDs are URL-safe strings (alphanumeric + underscore + hyphen, no spaces or punctuation). Consolidation output uses themed labels like `"First vet visit"` or `"Adoption day at the apartment"` — these consistently contain characters that fail the ID regex. The heuristic is not bulletproof (a user could manually edit either type to defeat it), but it is the right default for 95%+ of cases. The override UI catches the remainder.

**Additions to `index.js`:**

- **`consolidateMemories()` modifications:** after parsing memories, call the classifier; show the confirm popup if any protected blocks exist; run the LLM on the eligible set; assemble the final file.
- **`showBlockSelectionModal(allBlocks, initialEligible, charName)` (new helper):** opens a modal with a list of every block. Each row: checkbox + chat label + first bullet (truncated) + heuristic-assigned status badge (`Protected` / `Will consolidate`). Master checkboxes: `Select all` / `Select none`. Footer: `[Cancel] [Run consolidation]`. Returns a Promise that resolves to the user's final eligible set (or `null` on cancel).

**Preview editor integration:**

The existing `createMemoryEditor()` flow already opens after the LLM finishes. It will now receive `[...protected, ...newlyConsolidated]` as its initial blocks. Protected blocks get a visual marker (CSS class `charMemory_protectedBlock`) — dimmed card background plus a small `Protected — unchanged` badge — so users can see at a glance which blocks weren't touched by the LLM.

### UX

**Default path (first-time user / fully-new memory file, no protected blocks):**

1. Click Consolidate → no confirm popup (nothing was classified as protected) → LLM runs → preview → Apply.

Identical to the current behavior. Zero new friction for users whose memory file is all original extractions.

**Default path (user with prior consolidations):**

1. Click Consolidate.
2. Confirm popup appears: *"Protecting 45 blocks from prior consolidations. Consolidating 15 new blocks. [Change selection…] [Proceed]"*
3. User clicks Proceed (single click to continue with heuristic defaults).
4. LLM runs on the 15 eligible blocks (through existing path — single-call or chunked if that subset is large).
5. Preview opens showing all 60 final blocks: 45 dimmed/protected + 15 freshly consolidated.
6. User Apply → file is written.

**Override path:**

1. Click Consolidate → confirm popup as above.
2. Click "Change selection…" → modal with per-block checkboxes opens.
3. User adjusts. Clicking "Run consolidation" in the modal closes it, updates the eligible set, and proceeds as above (skipping the confirm popup the second time).

### Edge cases

- **All blocks look already-consolidated** (e.g., user imported a consolidated file; zero eligible): toastr *"All memories appear to be already consolidated — use the Memory Manager to mark some as eligible manually if you want to re-consolidate."* Abort.
- **Only one eligible block**: toastr *"Only 1 new block since last consolidation — not enough to consolidate (minimum 2)."* Abort.
- **User unchecks everything in the override modal**: the Proceed button disables until ≥2 blocks are selected.
- **Heuristic false-positive** (extraction block that happens to look themed): the override modal is the escape hatch.
- **Interaction with chunked consolidation**: the size threshold (`memoriesChars > consolidationChunkChars`) is computed against `eligible` only, not the full memory set. Chunked mode still activates naturally if the eligible set is large. No changes to the chunked orchestrator.
- **Group chats**: classifier runs per-character (same as current per-target consolidation). No new per-group logic needed.

### Ordering in the final file

`[...protected, ...newlyConsolidated]`. Protected blocks retain their original relative order. The newly consolidated blocks (which may be 1 or N blocks depending on the LLM's grouping) are appended after. This matches the natural "oldest → newest" chronology since extraction already appends chronologically and protected blocks are typically older than the newly-consolidated content.

### Error handling

- **Classifier failure**: the classifier is pure and synchronous; the only failure mode is input shape (e.g., undefined `bullets`). The function treats a malformed block as protected (safer default — preserve rather than mutate).
- **Modal cancel**: if the user clicks Cancel in the block selection modal, the entire consolidation aborts (returns to dashboard with no state change). Activity log: *"Consolidation cancelled — no changes made."*
- **LLM failure**: unchanged from current behavior — `runConsolidationLLM` returns null, `consolidateMemories()` aborts with no state change, the protected blocks are never written.

### What stays unchanged

- `consolidation.js` orchestrator
- `lib.js` chunking helpers (`estimateConsolidationSize`, `packBlocksIntoChunks`)
- The consolidation prompt template
- Cancel-button behavior during chunked mode
- Preview editor infrastructure (`createMemoryEditor` / `renderConsolidatedCards`)
- Extraction, reformat, convert, batch

## Testing

**Unit tests (`test/unit/classification.test.js`, new):**
- Empty input → `{ eligible: [], protected: [] }`
- All extraction-style chat IDs → all eligible
- All themed chat labels → all protected
- Mixed set → split correctly
- Chat label with spaces → protected
- Chat label with hyphens only → eligible (it matches `^[a-zA-Z0-9_-]+$`)
- Chat label with punctuation (em dash, apostrophe, period) → protected
- Chat label equal to literal `"unknown"` → protected (defensive — parseMemories default for missing attribute)
- Empty chat label → protected
- Order preservation within each bucket
- Malformed block (missing `bullets` array) → protected (defensive)

**No new integration test** — existing consolidation tests cover the pipeline after classification, treating the eligible set as the full input implicitly.

**Manual testing (tracked in the plan, executed in SillyTavern):**
- Fresh character with all-extraction blocks → no confirm popup, runs like before.
- Character with prior consolidation → confirm popup shows correct counts; Proceed consolidates only new blocks; preview shows protected + consolidated.
- Override modal: select-all, select-none, custom selection — each produces the expected final file.
- Cancel at the override modal aborts cleanly.
- Zero-eligible scenario shows the correct toastr.
- Group chat: verify per-character classification; confirm popup fires per character.

## Rollout

- No migration needed. Classification is runtime-only; no schema changes to memory files.
- Settings: no new defaults required.
- CHANGELOG entry in the existing 2.2.0 section (or a new 2.3.0 section if timing moves).
- Release note should emphasize: *"Repeated consolidations no longer degrade older memories — the extension now automatically protects previously-consolidated content."*

## Open questions / deferred decisions

- **Persistent protected flag**: revisit if users report the heuristic is wrong frequently enough to be annoying. Would require a new `protected="true"` attribute on `<memory>` tags and a "Pin" button in the Memory Manager.
- **Per-bullet granularity**: users might eventually ask "just re-consolidate these three bullets." Out of scope.
- **Diff-style preview**: showing "before and after" for the consolidated portion. Nice-to-have, not requested, out of scope.
