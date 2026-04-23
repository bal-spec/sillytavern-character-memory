# Chunked Consolidation — Design Spec

**Date:** 2026-04-23
**Issue context:** follow-up to issue #13 (fixed 2026-03-30 in commit 700a1b4).
**User report:** a user consolidating a 4000+ message roleplay chat (96 memory blocks, 36.5 MB JSONL) reports truncated consolidation output on multiple LLMs even after the 2026-03-30 max_tokens fix. The 4k token floor helps but does not scale to very long chats.

## Problem

`runConsolidationLLM()` in `index.js` is a **single-shot map**: all memory blocks are serialized into one prompt, sent in one LLM call, and the response is parsed in one pass. Both the prompt size and the required output size grow linearly with block count. On very long chats this exceeds the output-token ceiling of real LLMs (Gemini, OpenAI, DeepSeek via NanoGPT), producing responses that end mid-block with no closing `</memory>` tag.

Raising `max_tokens` helps marginally (the 2026-03-30 fix took it from `responseLength * 2` to `Math.max(responseLength * 4, 4000)`) but does not scale. The architectural fix is to split the work into multiple LLM calls.

## Goal

Enable consolidation on arbitrarily large memory sets while preserving output quality (cross-chunk deduplication) and the existing preview/edit/apply/undo UX.

## Non-goals

- Recursive reduce (reduce → reduce → reduce) — deferred to v2 pending real-world evidence it is needed.
- Reformat/convert chunking — tracked as a follow-up; same pattern applies but simpler (no reduce pass needed).
- Semantic clustering of blocks before chunking — deferred to v2.
- Parallel map execution — deferred; single-threaded sequential calls are simpler and avoid rate-limit spikes.
- Cancellation mid-chunk — requires plumbing `AbortController` through `callLLM`, which is invasive. v1 cancels between chunks only.

## Design

### High-level approach: map-reduce with auto-activation

Replace the single-shot consolidation path with a **size-aware dispatcher**. Small memory sets continue to run the existing single-call code path unchanged. Large sets (where estimated output char count exceeds a configurable threshold) route to a new map-reduce orchestrator that:

1. **Packs** memory blocks into char-budgeted chunks (greedy, in order).
2. **Maps** — runs the existing `runConsolidationLLM()` once per chunk.
3. **Reduces** — parses all map outputs into a combined block set and runs `runConsolidationLLM()` one final time to deduplicate across chunks.

The existing preview editor flow (`createMemoryEditor()`) wraps the final output, unchanged.

### Components

Pure functions in `lib.js` (unit-testable, ES-module exported):

| Function | Signature | Purpose |
|---|---|---|
| `estimateConsolidationSize` | `(memories, promptTemplateLength) => { promptChars, outputCharsEstimate }` | Decides whether to chunk. `outputCharsEstimate = memoriesChars * consolidationOutputRatio`. |
| `packBlocksIntoChunks` | `(memories, budgetChars) => MemoryBlock[][]` | Greedy packer. Iterates blocks in order, maintains a running char count, starts a new chunk when the next block would exceed budget. A block whose own char count exceeds budget goes into a chunk alone (no mid-block splitting). |

Orchestration in `index.js`:

| Function | Purpose |
|---|---|
| `runChunkedConsolidation(memories, charName)` | Drives map → reduce. Returns serialized memory text matching `runConsolidationLLM`'s contract. |
| `consolidateMemories()` (modified) | Calls `estimateConsolidationSize()`, dispatches to single-call or chunked path based on threshold. |

State:

| Field | Purpose |
|---|---|
| `consolidationCancelRequested` (module-scoped `let`) | Cancel flag. Set by Cancel-button click. Checked between chunks. |
| `extension_settings.charMemory.consolidationChunkChars` (new) | Default `24000`. Input char budget per chunk. Visible in Settings Modal → Advanced. |
| `extension_settings.charMemory.consolidationOutputRatio` (new) | Default `0.5`. Expected output/input char ratio used by the packer for sanity-checking per-chunk output pressure. Hidden (no UI); editable only via dev console for power-user tuning. Not involved in trigger decision. |

Trigger condition: chunked mode activates when `memoriesChars > consolidationChunkChars`. The `consolidationOutputRatio` does **not** affect the trigger — it only influences packer math (specifically, how much output pressure a given chunk is expected to produce, used as a sanity check for per-chunk sizing).

### Data flow

```
consolidateMemories()
  │
  ▼
 estimateConsolidationSize(memories)
  │
  ▼
 outputCharsEstimate > threshold ?
  │
  ├── no ──► runConsolidationLLM(memories)              [existing path, unchanged]
  │          │
  │          ▼
  │        preview editor → apply / undo
  │
  └── yes ──► runChunkedConsolidation(memories)
              │
              ├── packBlocksIntoChunks(memories, budget) → chunks[]
              │
              ├── MAP PHASE — for each chunk:
              │     ├── log "Consolidating chunk N/M via <source>…"
              │     ├── await runConsolidationLLM(chunk, charName)
              │     │     ├── on error: retry once
              │     │     │     └── on 2nd failure → abort with null
              │     │     └── on empty result: log warning, skip (don't abort)
              │     ├── check consolidationCancelRequested → abort if set
              │     └── collect → mapOutputs[]
              │
              ├── Parse all mapOutputs via parseMemories() (lib.js) → combinedBlocks
              │
              ├── REDUCE PHASE:
              │     └── await runConsolidationLLM(combinedBlocks, charName)
              │           └── on error or null → abort with null
              │
              └── return serializedMemories(reducedBlocks)
              │
              ▼
            preview editor → apply / undo
```

### Error handling

- **Per-chunk LLM error:** retry once. On second failure, log error to activity log, show toastr, return `null`. Caller (`consolidateMemories`) treats `null` identically to current single-call failure — no preview shown.
- **Cancellation:** `consolidationCancelRequested` flag, checked between chunks only. Current chunk always finishes. Partial results discarded. UI resets.
- **Reduce-pass failure:** return `null`. In verbose logging mode, log all map-phase outputs to the activity log so a user can recover manually.
- **Reduce-pass truncation:** the existing heuristic truncation detector (`<memory>` without closing `</memory>`) still fires a toastr warning. Recursive reduce is out of scope for v1; if real users hit this, add a third reduce pass behind the same threshold check.
- **Empty map output:** log warning, skip the empty chunk's contribution to reduce input. Do not abort — avoids one flaky LLM call killing the whole job.

### UX

- **Progress** (reuses existing batch-extraction pattern; no new UI surface):
  - Activity log: `"Consolidation: starting chunked mode (N chunks)"`, `"Consolidating chunk 3/7 via <source>… (X sec)"` per chunk, `"Running reduce pass…"` before final call, `"Consolidation complete: 96 blocks → 12 consolidated blocks"` at end.
  - Toastr: refreshes every 3 seconds with current chunk position.
- **Cancel:** `#charMemory_consolidateBtn` text changes to `"Cancel"` during chunked mode. Clicking sets `consolidationCancelRequested`. Reverts to `"Consolidate"` when done/cancelled/errored.
- **Preview/apply/undo:** unchanged. `createMemoryEditor()` receives the same serialized-blocks shape regardless of which path produced it.

### Settings UI

Add to Settings Modal → Advanced section one new row:

- **Label:** "Consolidation chunk size (chars)"
- **Input:** number, default 24000, min 4000
- **Helper text:** "Large memory sets are split into chunks of this size to avoid truncation. Lower values run more LLM calls but handle smaller output limits. Raise if your provider supports larger responses."

`consolidationOutputRatio` gets no UI — edit via dev console only.

### Testing

**Unit tests (`test/lib.test.js`):**
- `estimateConsolidationSize`: empty memories, small set, large set, various prompt template lengths.
- `packBlocksIntoChunks`:
  - small set fits in one chunk
  - large set splits into expected number of chunks
  - single oversize block → one-block chunk (no mid-block splitting)
  - empty input → empty output
  - block order preserved across chunks

**Integration test (`test/integration/chunked-consolidation.test.js`, new):**
- Inject a mock `callLLM` that echoes chunk contents deterministically.
- Verify:
  - chunk count matches `packBlocksIntoChunks` expectation
  - reduce phase triggered exactly once
  - `consolidationCancelRequested` flag aborts at next chunk boundary
  - single chunk error → retried once and succeeds
  - two consecutive errors on same chunk → abort with `null`
  - empty chunk output skipped, not aborted
  - reduce-pass error → abort with `null`

**Live LLM test (`test/live/consolidation.live.test.js`, new or extended):**
- Load flux-chat memories, duplicate/shuffle to produce ~90-block input (simulating long chat without needing a 36 MB fixture).
- Run full chunked consolidation.
- Assert: final output parses via `parseMemories`, block count is less than input, no truncation warning fires.

**Snapshot tests:** not appropriate — LLM output is non-deterministic.

## Rollout

- No migration needed. New settings default-initialize on first load via the existing pattern in `loadSettings()`.
- No breaking changes to existing settings or the consolidation preview/apply flow.
- Release note: mention in CHANGELOG.md under a new version (bump minor, e.g., 2.2.0) that chunked consolidation now handles long chats automatically.

## Open questions / deferred decisions

- Per-strategy output ratios (aggressive compresses more than gentle). Left at a single constant for v1; revisit if real users report imbalanced chunk sizes depending on strategy preset.
- Reformat/convert parity. Same pattern applies but no reduce pass needed (1:1 transformation). File as follow-up once chunked consolidation ships.
- Recursive reduce. Deferred until a real case appears where the reduce pass itself truncates.
