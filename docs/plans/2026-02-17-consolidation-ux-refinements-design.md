# Consolidation Dialog UX Refinements — Design

**Date:** 2026-02-17
**Branch:** `consolidation-improvements`
**Status:** Approved

## Problem

After user testing the card-based editor and tabbed panel layout, several UX issues surfaced:

1. Left pane bullets are indented oddly (fixed — CSS committed)
2. Pane headings "Original" / "Consolidated" are too terse
3. Right pane is always editable — jarring compared to left pane's clean read-only cards
4. Block headers show "consolidated 2026-02-17 21:22" which is meaningless to users
5. Add Memory / Add Block buttons are confusing when always visible
6. Users can't see the actual consolidation prompt — only a preset name
7. Activity log is hidden behind the Log tab; users want persistent status visibility

## Design

### 1. Pane Headings

- "Original" → **"Original Memories"**
- "Consolidated" → **"Consolidated Memories"**

### 2. Read-Only Default with Per-Block Edit

Both panes render identically by default — read-only cards with bullet lists.

Each block in the right pane gets a pencil icon in its header. Clicking it switches **just that block** to edit mode:
- Bullets become text inputs with delete buttons
- "Add Memory" button appears at the bottom of the block
- The pencil icon becomes a checkmark; clicking it exits edit mode

The "Add Block" button at the bottom of the right pane only appears when any block is in edit mode.

### 3. Themed Numbered Block Headers

The consolidation prompt is updated to instruct the LLM: "Group memories by theme and name each group."

The LLM returns blocks with theme names. Headers display as: **"1. Relationship History"**, **"2. Character Background"**, etc.

In edit mode, the theme name is an editable text input.

**Data format:** The `chat` field in `<memory chat="..." date="...">` carries the theme name. Example: `<memory chat="Relationship History" date="2026-02-17 21:22">`. Original memories keep their existing chat/date headers unchanged.

### 4. Add Memory / Add Block — Edit Mode Only

- "Add Memory" button only visible inside blocks that are in edit mode
- "Add Block" button only visible when at least one block is in edit mode

### 5. Editable Presets with Expandable Prompt Viewer

Remove the "Custom" preset. Keep 3 presets: **Conservative**, **Balanced**, **Aggressive**.

Each preset has a collapsible "Show prompt" disclosure below the dropdown. Expanding it reveals the full prompt text in an editable textarea. Changes are saved per-preset. A "Restore Default" button resets to built-in text.

Same expandable prompt viewer appears in both:
- The **Consolidate tab** in the panel
- The **consolidation dialog** toolbar

**Storage:** `extension_settings.charMemory.consolidationPrompts.{conservative,balanced,aggressive}` — if present, overrides the built-in default for that preset. If absent or empty, the built-in default is used.

### 6. Persistent Activity Log at Panel Bottom

A compact log section at the bottom of the panel, **always visible regardless of active tab**.

- Shows 2-3 lines of recent activity by default
- Clickable/expandable — expands upward to show more history
- Uses the same `logActivity()` entries that go to the Log tab
- The full Log tab remains for verbose/complete history and log management (clear, save, verbose toggle)

## What Stays The Same

- `runConsolidationLLM()` — no changes to the LLM call mechanics
- `parseMemories()` / `serializeMemories()` — the `<memory>` tag format is unchanged, just the `chat` field carries theme names for consolidated blocks
- Tab layout (Main, Consolidate, Batch Extract, Settings, Log) — unchanged
- Stats bar, enable checkbox — unchanged
- Re-run / Undo version stack — unchanged (stores block arrays)
- Memory manager popup — unchanged
- Slash commands — unchanged

## What Changes

| Component | Before | After |
|-----------|--------|-------|
| Right pane default state | Always-editable inputs | Read-only cards, per-block edit toggle |
| Block headers (consolidated) | "consolidated 2026-02-17 21:22" | "1. Relationship History" (themed, numbered) |
| Add Memory / Add Block | Always visible | Only in edit mode |
| Preset system | 3 presets + Custom | 3 presets, each editable with expandable prompt viewer |
| Prompt visibility | Name only (dropdown) | Expandable disclosure shows full prompt text |
| Activity log | Log tab only | Persistent compact log at panel bottom + full Log tab |
| Pane headings | "Original" / "Consolidated" | "Original Memories" / "Consolidated Memories" |
