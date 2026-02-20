# Consolidation UX Improvement Design

**Date:** 2026-02-16
**Status:** Approved

## Problem

Memory consolidation is currently all-or-nothing with no user control over strategy, no ability to edit results before saving, and no way to iterate on LLM output.

## Design

### 1. Strategy Presets + Custom Prompt

Add a **Consolidation Strategy** dropdown to the Settings drawer with 4 options:

- **Conservative** — only merge near-exact duplicates, preserve everything else
- **Balanced** (default) — merge duplicates + combine related facts (refined version of current behavior)
- **Aggressive** — compress heavily, summarize themes, minimize bullet count
- **Custom** — reveals an editable textarea for a fully custom consolidation prompt

When a preset is selected, its prompt text is shown read-only. "Custom" makes the field editable. A "Restore Default" link resets to Balanced.

Persisted in `extension_settings.charMemory.consolidationStrategy` and `extension_settings.charMemory.consolidationPrompt`.

### 2. Iterative Preview Dialog

The consolidation preview becomes an interactive workspace:

**Layout:**
- Left pane: "Original" — read-only display of current memories
- Right pane: "Consolidated" — editable textarea showing the LLM's output
- Top bar: Stats ("Original: 47 memories in 12 blocks -> Consolidated: 23 in 4 blocks")
- Bottom toolbar: Re-run, Undo, Accept, Cancel buttons

**Version stack:** Each re-run pushes the current right-pane content onto an in-memory stack. Undo pops from the stack. No persistence needed.

**Flow:**
1. User clicks Consolidate -> LLM runs -> preview opens with result (v1)
2. User can edit bullets directly in the textarea
3. User can change strategy -> click Re-run -> new result (v2), old saved to stack
4. User can Undo to go back to previous version (including their edits)
5. User clicks Accept -> parsed and saved to file

The textarea uses plain text in `<memory>` block format. On Accept, content is parsed through `parseMemories()` -> `serializeMemories()` to normalize.

### 3. Preset Prompt Text

**Conservative:**
> Merge ONLY near-exact duplicate memories. If two bullets say essentially the same thing, keep the more detailed version. Do NOT combine loosely related facts. Do NOT summarize. Preserve every distinct piece of information.

**Balanced (default):**
> Merge duplicate or near-duplicate memories into one. Combine closely related facts about the same event or topic. Preserve all unique information — do NOT discard distinct memories. Summarize in third person.

**Aggressive:**
> Aggressively consolidate these memories into the fewest possible entries. Group by theme or topic. Summarize rather than listing individual events. It's OK to lose minor details if the key facts are preserved. Aim for a compact overview.

All presets share the structural rules: use `<memory>` tags, bullet format, no emojis, no commentary.

### 4. Unchanged

- Undo Consolidation button in main panel (session-only restore of pre-consolidation state)
- `/consolidate-memories` slash command (opens the same dialog)
- WebLLM truncation logic
- Activity log entries for consolidation
