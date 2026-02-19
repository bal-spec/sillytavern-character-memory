# Design: Optional Merge Behavior & Date/Time in Extraction

**Date**: 2026-02-18
**Status**: Approved

## Problem

1. **mergeMemoryBlocks creates huge blocks**: For long chats (800+ messages), every extraction chunk's output shares the same chat ID and gets merged into a single block with 200+ bullets. This block is too large for the consolidation LLM to process, making consolidation unusable for the chats that need it most.

2. **Memories lack temporal context**: The extraction prompt doesn't encourage capturing dates and times. Memories like "She visited Paris" lose valuable temporal information that was present in the conversation.

## Change 1: Optional Merge Behavior

**Setting**: "Merge extraction chunks" checkbox in Settings tab under Extraction Settings.
- Stored as `extension_settings.charMemory.mergeChunks`
- **Default: off**

**Behavior when off**: After multi-chunk extraction, each chunk's `<memory>` block stays separate. Long chats produce multiple smaller blocks.

**Behavior when on**: Current behavior — `mergeMemoryBlocks` runs after multi-chunk extraction, combining blocks with the same chat ID.

**Helper text**: "When enabled, extraction results from the same chat are merged into a single block. Disable for long chats to keep blocks smaller for consolidation."

**Location in UI**: Settings tab, under "Extraction Settings" section, after the "Max response length" slider.

## Change 2: Date/Time Gentle Nudge

Add one line to the `WHAT TO EXTRACT` bullet list in `defaultExtractionPrompt`:

```
- Dates and times when mentioned or clearly implied in the conversation
```

This is a gentle nudge — the LLM includes temporal context when it naturally appears but doesn't force-prefix every bullet.

Only affects the default prompt. Users with customized prompts are not affected (their override is preserved).

## Files to Modify

- `index.js`: Add `mergeChunks: false` to defaultSettings, wrap `mergeMemoryBlocks` call in conditional, add date/time line to `defaultExtractionPrompt`
- `settings.html`: Add merge checkbox in Settings tab
