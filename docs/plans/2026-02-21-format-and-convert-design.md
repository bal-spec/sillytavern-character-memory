# Memory Format Options & Data Bank Converter

**Date:** 2026-02-21
**Status:** Design approved

## Problem

SillyTavern's Vector Storage splits Data Bank files into chunks at `\n\n` boundaries. The current `serializeMemories()` format places `\n\n` between `<memory>` blocks but uses single `\n` between bullets within a block. Depending on the user's VS chunk size settings, this can cause the entire file to land in one chunk — defeating per-memory retrieval.

Separately, many users have existing Data Bank files in non-standard formats (freeform paragraphs, other extensions' output, older CharMemory `## Memory N` format) that would benefit from conversion into CharMemory's `<memory>` tag format.

## Changes

### 1. Tab Restructure

**Before:** Main | Consolidate | Batch Extraction | Settings | Log (5 tabs)

**After:** Main | Tools | Settings | Log (4 top-level tabs)

The **Tools** tab contains pill-button sub-navigation:

```
(Consolidate)  (Batch)  (Convert)
```

- Consolidate and Batch content moves as-is under their respective pills
- Convert is new (Section 3 below)
- Diagnostics and Mini Activity Log remain always-visible at bottom (unchanged)

**Pill button styling:** Smaller/subtler than top-level tabs — visually subordinate to make the hierarchy clear. Same active/inactive toggle pattern but with reduced padding and font size.

### 2. Memory File Format Settings

**Location:** Settings tab, new section between "Extraction Settings" and "Storage".

#### UI Elements

| Element | Type | Details |
|---------|------|---------|
| Chunk boundary | Dropdown | Block-level (default) / Bullet-level / Custom |
| Custom separator | Text input | Shown only when Custom selected. Default: `\n\n` |
| Include metadata in chunks | Checkbox | Shown only when Bullet-level or Custom selected |

#### Behavior

**Block-level (default):** Current behavior. `<memory>` blocks separated by `\n\n`. No change from today's format.

**Bullet-level:** Each `- bullet` line is separated by the chunk separator (default `\n\n`). The `<memory>` tags are still used for internal parsing but the serialized file output inserts the separator between each bullet.

**Custom:** User defines the separator string inserted between chunks. The chunk unit is determined by a sub-option (block or bullet level).

**Include metadata in chunks:** When bullet-level chunking is active, prefix each bullet with its provenance: `[2024-01-15 | main_chat_abc123] - bullet text`. Without this, individual bullets lose their timestamp and chat context when split apart.

#### On Format Change

When the user changes the chunk boundary setting, show a confirmation popup:

> **Reformat existing memories to match the new format?**
> This will rewrite N memories in M blocks.
>
> [Reformat] [Skip]

"Reformat" reads the current file, parses it, and re-serializes with the new format settings. "Skip" saves the setting for future writes only (existing file keeps its current format).

#### Implementation

`serializeMemories()` gains a `format` parameter (or reads from settings) that controls:
- Separator string between chunks
- Whether chunks are blocks or individual bullets
- Whether to include inline metadata

All write paths already go through `serializeMemories()` (extraction, consolidation, edit, import), so the format change propagates automatically.

### 3. Convert / Import Tool

**Location:** Tools tab > Convert pill

#### Purpose

Convert any existing Data Bank file into CharMemory's `<memory>` tag format. Non-destructive: writes to a new/separate file, original is untouched.

#### UI Layout

```
Source file:  [── Select a Data Bank file ── v]
  helper: "Select any file from this character's Data Bank."

[Preview Conversion]

┌─ Preview ──────────────────────────────────────┐
│ Detected format: [format type]                 │
│ Parse method: Heuristic / LLM (N bullets)      │
│                                                │
│ BEFORE:                 │ AFTER:               │
│ ┌─────────────────────┐ │ ┌──────────────────┐ │
│ │ [raw content]       │ │ │ [converted]      │ │
│ └─────────────────────┘ │ └──────────────────┘ │
│                                                │
│ ! The original file will NOT be deleted.       │
│   Hide or remove it from the Data Bank to      │
│   avoid duplicate memories.                    │
│                                                │
│ Output to:                                     │
│ (*) CharMemory file (CharName-memories.md)     │
│ ( ) Custom filename: [________________]        │
└────────────────────────────────────────────────┘

[Convert]  [Cancel]

[ ] Use LLM to restructure (for freeform text)
  helper: "When the file has no clear structure, send it
  to the LLM for intelligent restructuring."

  > Show prompt
  ┌──────────────────────────────────────────────┐
  │ [textarea]                                   │
  └──────────────────────────────────────────────┘
  [Restore Default]
```

#### Heuristic Parser

Detects and handles these formats in priority order:

1. **`<memory>` tags** — Already in CharMemory format. Show message: "Already in CharMemory format, no conversion needed."
2. **`## Memory N` headings** — Old CharMemory format. Uses existing `migrateMemoriesIfNeeded()` logic.
3. **`- ` bullet lines** — Extract bullets, group into `<memory>` blocks (one block per contiguous group, or all in one block).
4. **`1. ` / `a. ` numbered lists** — Convert to bullet format.
5. **Markdown headings** — Use headings as `<memory chat="heading">` block labels, content under each heading becomes bullets.
6. **Freeform paragraphs** — Heuristic splits on sentence boundaries. Results may be poor; prompt user to try LLM restructuring.

#### LLM Conversion Prompt

**Default prompt:**

```
You are converting a text file into a structured memory format for {{charName}}.

The input contains facts, memories, or notes in an unstructured format. Your task is to restructure this into clean, organized memory blocks.

Rules:
1. Extract every distinct fact or piece of information as a bullet point starting with "- "
2. Group related facts into <memory chat="[Topic Name]" date="[today]"> blocks where Topic Name is a short descriptive label (e.g. "Appearance", "Relationships", "Key Events")
3. Preserve ALL information — do not summarize, combine, or omit anything from the source
4. Do not add facts, inferences, or details not explicitly stated in the source
5. Clean up grammar and formatting, but do not change the meaning
6. Skip formatting artifacts, HTML tags, and metadata that aren't actual memories

Source text to restructure:
{{sourceText}}
```

**Template variables:** `{{charName}}`, `{{sourceText}}`

**Configurable:** Yes — disclosure accordion with textarea and Restore Default button, matching the Consolidation prompt pattern.

**Key difference from other prompts:** This prompt is conservative (preserve everything, don't interpret). Extraction encourages emotional salience filtering. Consolidation encourages merging. Conversion is faithful restructuring.

#### Output Behavior

1. Converted content is written to the chosen destination file via `writeMemoriesForCharacter()`
2. Original file is **not** modified or deleted
3. Post-convert toast: "Converted N memories. Remember to hide or remove the original file from Data Bank to avoid duplicates."
4. If output destination is the existing CharMemory file and it already has content, **append** the converted memories (don't overwrite)

#### Source File Dropdown

Lists all files in `extension_settings.character_attachments[avatar]` for the current character, excluding:
- The active CharMemory memory file itself (no point converting your own output)
- Files that already contain `<memory>` tags (already in format — though we could show these with a "(already converted)" label)

### 4. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Duplicate memories from old + new file | Warning in preview, post-convert toast reminder |
| LLM hallucination during conversion | LLM is opt-in, preview required before commit |
| Format change breaks existing memories | Reformat confirmation popup with Skip option |
| Metadata loss in bullet-level chunking | "Include metadata in chunks" checkbox |
| Mixed formats after setting change + skip | Reformat offer appears on each format change |
| Token cost from LLM conversion | LLM explicitly opt-in with helper text |
| VS stale embeddings after reformat/convert | Log reminder to user; investigate if ST has a re-vectorize API we can call |
| Large files exceed LLM context | Chunk the source text into segments, convert each separately, merge results |

### 5. Settings Storage

New fields under `extension_settings.charMemory`:

```js
chunkBoundary: 'block',        // 'block' | 'bullet' | 'custom'
customSeparator: '\n\n',       // string, used when chunkBoundary is 'custom'
chunkMetadata: false,           // boolean, include [date|chat] prefix in bullet chunks
conversionPrompt: '',           // custom conversion prompt (empty = use default)
```

### 6. New Functions

| Function | Purpose |
|----------|---------|
| `serializeMemories(blocks, formatOptions?)` | Extended to accept format config |
| `detectFileFormat(content)` | Returns detected format type for heuristic parser |
| `convertHeuristic(content, format)` | Heuristic conversion pipeline |
| `convertWithLLM(content, charName, prompt)` | LLM-assisted conversion via `callLLM()` |
| `reformatExistingMemories(avatar, fileName)` | Reads, parses, re-serializes with current format |
