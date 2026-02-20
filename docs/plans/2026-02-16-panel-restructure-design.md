# Panel Restructure + Card-Based Consolidation Editor Design

**Date:** 2026-02-16
**Status:** Approved
**Branch:** consolidation-improvements (builds on existing consolidation UX work)

## Problem

1. Consolidation and batch extraction are buried as a button and a sub-tab. They should be first-class tools.
2. Consolidation config (strategy, prompt) is buried in Settings, separate from where consolidation happens.
3. The consolidation preview shows nicely formatted cards on the left but raw `<memory>` tags on the right, which is jarring.

## Design

### 1. Top-Level Tab Layout

The extension panel becomes tab-based. Stats bar and auto-extraction toggle stay above.

```
Character Memory
  Stats bar (file, count, progress, cooldown)
  Enable auto-extraction checkbox

  [Main] [Consolidate] [Batch Extract] [Settings] [Log]

  Main tab (default):
    [Extract Now]  [View / Edit]
    Diagnostics section (collapsed)

  Consolidate tab:
    Strategy dropdown (conservative/balanced/aggressive/custom)
    Custom prompt textarea (when custom) or preset description
    [Consolidate]  [Undo Consolidation]

  Batch Extract tab:
    Same content as current batch extract tab

  Settings tab:
    LLM/Provider config
    Auto-Extraction sliders
    Extraction Settings (chunk size, response length)
    Storage (per-chat, filename)
    Extraction prompt
    Reset/Clear buttons

  Log tab:
    Activity Log with verbose toggle, clear, save
```

### 2. Card-Based Consolidation Editor (Popup)

Clicking "Consolidate" runs the LLM and opens a full-width popup:

**Layout:**
- Top: Stats bar ("Original: 47 memories -> Consolidated: 23")
- Below stats: Strategy dropdown + Re-run button + Undo button + spinner
- Main area: Two-pane side-by-side
  - Left: Original memories as read-only cards (same as current)
  - Right: Consolidated memories as editable cards
- Bottom: Accept / Cancel buttons (from CONFIRM popup type)

**Editable card structure:**
- Each block is a card matching the left pane's visual style
- Each bullet is an always-editable text input with a trash icon button
- "Add memory" button at the bottom of each card to add a new bullet
- "Delete block" button to remove the entire card
- "Add Block" button at the very bottom to create a new empty block

**Data model:**
- Editor operates on an in-memory array of block objects: `[{ chat, date, bullets }]`
- Same structure as `parseMemories()` output
- Add/delete/edit mutate this array directly (via data attributes on DOM elements)
- On Accept: `serializeMemories(blocks)` to save
- Live bullet count updates as blocks are modified

**Version stack:**
- Re-run pushes deep copy of current blocks array
- Undo pops from stack
- Same behavior as current, but operating on block arrays instead of text

### 3. What Changes From Current Implementation

- `settings.html`: Complete restructure to tab layout
- `buildConsolidationDialog()`: Rewrite right pane from textarea to card-based editor
- `consolidateMemories()`: Work with block arrays instead of raw text for the editor
- `countConsolidatedText()`: Replace with counting from the block array
- CSS: New tab styles, editor input styles
- Consolidation strategy UI moves from Settings drawer to Consolidate tab

### 4. What Stays The Same

- `runConsolidationLLM()` helper (returns serialized text, parsed by caller)
- `CONSOLIDATION_PRESETS` and `buildConsolidationPrompt()`
- `consolidationBackup` / Undo Consolidation mechanism
- Settings persistence
- Slash commands
- Memory manager popup (View/Edit) — unchanged
- All extraction logic — unchanged
