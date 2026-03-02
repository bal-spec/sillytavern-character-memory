# Architecture

A technical overview for anyone who wants to understand how CharMemory works or modify it.

---

## How it fits into SillyTavern

CharMemory is a third-party extension loaded via `manifest.json`. It runs entirely in the browser as an ES module — no server-side component. It uses three SillyTavern systems:

- **Data Bank** — file storage per character (where memory files live)
- **Vector Storage** — embedding and retrieval (indexes Data Bank files automatically)
- **Event system** — hooks into chat events like `CHARACTER_MESSAGE_RENDERED` and `CHAT_CHANGED`

The extension writes memories as plain markdown files to the Data Bank. Vector Storage picks them up, vectorizes them, and retrieves relevant chunks at generation time. CharMemory doesn't handle retrieval — it only writes; SillyTavern handles the rest.

---

## File structure

| File | Lines | Role |
|------|------:|------|
| `index.js` | ~8200 | Main runtime: extraction pipeline, LLM dispatch, all UI (modals, drawers, sidebar), event handlers, provider API calls |
| `lib.js` | ~520 | Pure utility functions: parsing, serialization, text processing, format detection. Canonical source — `index.js` imports these at runtime |
| `editor.js` | ~110 | Memory block editor factory. Pure state management with undo stack — no DOM. Used by preview dialogs |
| `settings.html` | ~100 | Sidebar dashboard HTML: stats bar, tool buttons, activity log, diagnostics summary |
| `style.css` | ~1940 | All styling: dashboard, modals, drawers, wizard, troubleshooter, memory cards |
| `manifest.json` | 12 | Extension metadata: version, load order, entry points |

### Module relationships

```
index.js  (runtime, UI, LLM dispatch)
  ├── imports lib.js      (pure functions: parse, serialize, format, strip, find/replace)
  ├── imports editor.js   (state management for preview editors)
  ├── loads settings.html (sidebar dashboard)
  └── loads style.css     (all styling)
```

The split is intentional for testability: `lib.js` functions are pure (no DOM, no SillyTavern globals) and can be unit tested in isolation. `editor.js` manages state without rendering. `index.js` handles the messy integration with SillyTavern's DOM, popups, and APIs.

---

## index.js map

The file is large. This section-by-section map helps you navigate it. Line numbers are approximate — they shift as the file evolves.

| Lines | Section | What's there |
|------:|---------|-------------|
| 1–80 | **Constants & state** | Module metadata, `getMemoryFileName()`, global state variables (`inApiCall`, `lastExtractionTime`, etc.) |
| 82–125 | **Activity log** | `logActivity()`, in-memory log array (max 500 entries), sidebar display updates |
| 125–310 | **Default prompts** | `defaultExtractionPrompt`, `defaultGroupExtractionPrompt`, `defaultConversionPrompt` — the full prompt templates |
| 309–510 | **Provider & settings constants** | `EXTRACTION_SOURCE` enum, `PROVIDER_PRESETS` registry (12 providers), `defaultSettings`, `PROMPT_CONFIG` |
| 512–1052 | **Format & conversion** | `getFormatOptions()`, `serializeMemories()`, format detection, LLM-powered conversion, conversion preview dialog |
| 1053–1390 | **Provider UI helpers** | Model dropdowns, NanoGPT filters, provider settings display, chunk boundary UI |
| 1391–1715 | **Settings init & dashboard** | `loadSettings()`, health polling, `updateStatusDisplay()`, cooldown timer, character/group helpers |
| 1717–1890 | **Data Bank operations** | `readMemoriesForCharacter()`, `writeMemoriesForCharacter()`, attachment management, `collectRecentMessages()` |
| 1890–1955 | **Server API helpers** | `fetchCharacterChats()`, `fetchChatMessages()` |
| 1958–2450 | **Provider API** | `callLLM()` (single dispatch point), `generateOpenAICompatibleResponse()`, `generateAnthropicResponse()`, model fetching, connection testing |
| 2452–2838 | **Extraction core** | `buildExtractionPrompt()`, `extractMemories()` — the main pipeline |
| 2840–2940 | **Event handlers** | `onCharacterMessageRendered()`, `onChatChanged()` |
| 2942–3380 | **Health & diagnostics** | `computeHealthScore()` (8-point checklist), `updateHealthIndicator()`, vectorization status checks |
| 3382–4015 | **Settings modal** | `showSettingsModal()` — Connection, Extraction, Storage, Advanced sections |
| 4016–4520 | **Prompts modal** | `showPromptsModal()` — 4-tab prompt editor with version tracking |
| 4523–5300 | **Setup wizard** | `showSetupWizard()` — 3-step first-run flow |
| 5306–5935 | **Troubleshooter** | `showTroubleshooter()` — health checks, Data Bank browser, diagnostic report |
| 5938–6250 | **Memory Manager** | `showMemoryManager()` — browse/edit/delete individual memories |
| 6254–6340 | **Find & Replace** | `buildFindReplaceBar()`, `wireFindReplaceEvents()`, `highlightText()` |
| 6344–6820 | **Consolidation** | Strategy presets (conservative/balanced/aggressive), LLM consolidation, preview dialog, undo |
| 6821–7138 | **Reformat** | Format migration preview dialog, LLM-powered reformat, undo |
| 7139–7355 | **Slash commands & wiring** | `registerSlashCommands()`, `setupToolControls()`, `setupLogControls()`, `setupListeners()` |
| 7360–7740 | **Per-message UI** | Extract Here / Pin Memory / View Injected buttons, injection drawer, log drawer |
| 7753–7960 | **Batch extraction** | `showBatchPopup()`, `runBatchExtraction()` — multi-chat extraction |
| 7963–8164 | **Initialization** | Extension entry point: loads HTML, calls `loadSettings()`, wires events, auto-triggers wizard on first run |

---

## Core data structure

Everything revolves around **memory blocks**:

```javascript
{ chat: "main_chat_abc123", date: "2025-01-15 14:30", bullets: ["Alex ordered coffee", "Discussed the weather"] }
```

Serialized as XML in the Data Bank file:

```xml
<memory chat="main_chat_abc123" date="2025-01-15 14:30">
- Alex ordered coffee
- Discussed the weather
</memory>
```

Parsing is strict: only `<memory>` tags with `- ` bullet lines are recognized. The first bullet in a block is typically a **topic tag** like `[Alex, Flux — coffee shop visit]` which improves Vector Storage's embedding discrimination for thematically similar memories.

Key functions: `parseMemories()` and `serializeMemories()` in `lib.js` handle the conversion. `index.js` has its own `serializeMemories()` that adds runtime format options.

---

## Extraction pipeline

The core data flow, end to end:

```
New message arrives
  → CHARACTER_MESSAGE_RENDERED event fires
  → onCharacterMessageRendered() increments counter
  → Counter hits interval (default 20) and cooldown has expired
  → extractMemories() called
    → Collect unprocessed messages via collectRecentMessages()
    → Chunk into batches (default 20 messages/call)
    → For each chunk: callLLM() with extraction prompt + existing memories + recent messages
    → Parse <memory> blocks from LLM response
    → Append to Data Bank file via writeMemoriesForCharacter()
    → Update chat_metadata.lastExtractedIndex
  → Vector Storage auto-vectorizes the updated file (async, not controlled by us)
  → At generation time, VS retrieves relevant chunks and injects them into the prompt
```

`callLLM()` (line ~2265) is the **single dispatch point** for all LLM calls — extraction, consolidation, and conversion all go through it. It branches on `extension_settings.charMemory.source` to route to the Main LLM, WebLLM, or a dedicated provider.

---

## Provider system

Twelve providers in the `PROVIDER_PRESETS` registry (line ~315). Each preset defines:

- `baseUrl` — API endpoint
- `authStyle` — `'bearer'`, `'x-api-key'`, or `'none'`
- `modelsEndpoint` — `'standard'` (/models), `'custom'` (NanoGPT), or `'none'` (Pollinations)
- `requiresApiKey`, `extraHeaders`, `defaultModel`

All providers except Anthropic use `generateOpenAICompatibleResponse()` which POSTs to `/chat/completions`. Anthropic has its own adapter `generateAnthropicResponse()` that converts to the Messages API format.

Per-provider settings (API key, model, system prompt, custom URL) are stored independently in `extension_settings.charMemory.providers[key]`. Switching providers preserves each one's configuration.

---

## Editor factory

`createMemoryEditor({ blocks })` in `editor.js` returns a pure state API (no DOM, no rendering):

```
getBlocks(), deleteBullet(), deleteBlock(), addBullet(), addBlock(),
updateBullet(), updateTheme(), undo(), canUndo(), replaceAll(),
toggleEdit(), isEditing(), getEditingSet(),
countMatches(), findAndReplaceAll()
```

Every mutation calls `saveVersion()` first, pushing a deep clone onto the undo stack. This makes any operation (including Replace All) undoable as a single step.

Used by the Consolidation, Conversion, Reformat, and Data Bank editor dialogs. The Memory Manager uses its own standalone editing logic since it writes directly to disk per-bullet.

---

## UI architecture

The UI has four layers:

**Sidebar dashboard** — static HTML in `settings.html`, wired in `loadSettings()`. Stats bar, tool buttons, activity log, diagnostics summary. All IDs prefixed `charMemory_`.

**Center-screen modals** — built dynamically in `index.js` using SillyTavern's `callGenericPopup()`. Six major modals: Settings, Prompts, Setup Wizard, Troubleshooter, Memory Manager, Batch. Settings modal uses `cm_modal_*` prefixed IDs; troubleshooter uses `cm_ts_*`.

**Slide-out drawers** — the Injection Viewer and Activity Log drawer, toggled by sidebar buttons. Support touch swipe-to-close.

**Per-message buttons** — Extract Here (brain icon), Pin Memory (bookmark), View Injected (eye). Added to each message via `onMessageRenderedAddButtons()`.

jQuery is used throughout (SillyTavern convention). Event handlers are typically wired in `setupToolControls()` and `setupLogControls()`, called from `loadSettings()`.

---

## Health system

`computeHealthScore()` (line ~3073) runs an 8-point checklist:

1. Character selected
2. Data Bank file exists
3. File is not empty
4. File format is valid `<memory>` tags
5. File is vectorized in Vector Storage
6. Vector Storage chunk size is appropriate
7. Vector Storage retrieval is configured
8. Memories are being injected into context

Returns `{ level: 'green'|'yellow'|'red', checks: [...] }`. Displayed as a traffic-light dot in the sidebar. Updated from six trigger points: init, chat change, after extraction (with 4s recheck for VS race condition), 60s periodic poll (pauses when tab hidden via Page Visibility API), panel open, and troubleshooter close.

---

## Testing

Three tiers, all using Vitest:

```bash
npm test                # Unit tests (~136 tests, <1s) — pure functions in lib.js + editor.js
npm run test:snapshot   # Snapshot tests (6 tests) — extraction pipeline against 1000-message fixture
npm run test:live       # Live LLM tests (3 tests) — real LLM call, validates response structure
```

**Unit tests** cover parsing, serialization, escaping, format detection, find/replace, and the editor API. These are the primary safety net — run them after any change to `lib.js` or `editor.js`.

**Snapshot tests** process a real chat fixture through `stripNonDiegetic` → `formatChatMessages` → `substitutePromptTemplate` and snapshot the output. Update with `npm run test:snapshot -- --update` after intentional changes.

**Live tests** require a running OpenAI-compatible server. Configure with `TEST_LLM_URL`, `TEST_LLM_MODEL`, `TEST_LLM_KEY` env vars. Good local models: Gemma 2 9B, Qwen 2.5 7B.

UI and integration testing requires a running SillyTavern instance with the extension installed.

---

## Common modifications

**Adding a new provider** — Add an entry to `PROVIDER_PRESETS` (~line 315). If it's OpenAI-compatible with a standard `/models` endpoint, that's the only change needed. The settings UI, model fetching, and API dispatch all key off the preset.

**Modifying the extraction prompt** — Edit the `defaultExtractionPrompt` constant (~line 125). Bump `PROMPT_CONFIG.extraction.version` to trigger update notifications for existing users. Test against multiple characters — the prompt is carefully tuned to reduce card-trait leakage and meta-narration.

**Adding a sidebar UI element** — Add HTML to `settings.html`, add the event handler in `setupToolControls()` (~line 7189). Follow the `charMemory_` ID prefix convention.

**Adding a modal** — Build HTML dynamically in a new `show*()` function. Use `callGenericPopup(html, POPUP_TYPE.TEXT)` for display. Use `cm_modal_*` or `cm_[feature]_*` prefixed IDs to avoid conflicts with other surfaces.

**Adding a new tool dialog** — Follow the pattern of existing tools (Consolidation, Reformat): build dialog HTML, create a `createMemoryEditor()` instance for state management, render with `renderConsolidatedCards()`, wire find/replace with `wireFindReplaceEvents()`. The editor handles undo; you handle rendering and save.

**Adding a pure utility function** — Add it to `lib.js` and export it. `index.js` imports it automatically. Keep `lib.js` free of DOM and SillyTavern dependencies so it stays unit-testable.
