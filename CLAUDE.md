# CharMemory — SillyTavern Extension

## Git / GitHub

This repo belongs to the `bal-spec` GitHub account. The `.envrc` file (via direnv) automatically sets `GH_TOKEN` for `bal-spec` when working in this directory — no manual `gh auth switch` needed.

## What This Is

A SillyTavern extension that automatically extracts structured character memories from chat messages, stores them as markdown in the character's Data Bank, and relies on Vector Storage for retrieval at generation time.

## File Structure

```
index.js        — All extension logic: extraction, consolidation, provider API calls, UI controllers, event handlers, modals (~8660 lines)
lib.js          — Pure utility functions imported by index.js at runtime and used by tests (parsing, serialization, formatting, stripping)
editor.js       — Shared memory block editor factory (createMemoryEditor) with state management and undo
settings.html   — Sidebar dashboard HTML (stats bar, extraction controls, tool launchers, activity, diagnostics)
style.css       — All styling (dashboard, modals, drawers, wizard, troubleshooter)
manifest.json   — ST extension manifest (version, loading order, author)
README.md       — User-facing documentation (getting started guide + technical reference, combined)
CHANGELOG.md    — Version history
images/         — Screenshots for documentation
test/           — Vitest test suites (unit, integration/snapshot, integration/live)
```

`index.js` is the main runtime module. `lib.js` is the canonical source for pure utility functions — `index.js` imports them via ES modules. Only `serializeMemories()` is kept local in `index.js` because it uses `getFormatOptions()` for runtime settings.

## Key Architecture

### Extraction Pipeline

1. Extension listens for `CHARACTER_MESSAGE_RENDERED` events
2. Counts messages against a configurable interval (default 20)
3. Collects unprocessed messages in chunks ("Messages per LLM call", default 50)
4. Strips non-diegetic content (code blocks, tables, HTML tags) from messages
5. Sends existing memories + recent messages + character card to the LLM with the extraction prompt
6. Parses `<memory>` blocks from response, appends to Data Bank file
7. Vector Storage handles vectorization and retrieval automatically

### Provider System (v1.2.0)

Three extraction sources: `EXTRACTION_SOURCE.MAIN_LLM`, `EXTRACTION_SOURCE.WEBLLM`, `EXTRACTION_SOURCE.PROVIDER`.

The "Dedicated API" source uses `PROVIDER_PRESETS` — a registry of named presets (OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, Mistral, xAI, NanoGPT, Ollama, Pollinations, Custom). Each preset defines: `baseUrl`, `authStyle` (`'bearer'` | `'x-api-key'` | `'none'`), `modelsEndpoint` (`'standard'` | `'custom'` | `'none'`), `requiresApiKey`, `extraHeaders`, `defaultModel`.

All providers except Anthropic use the OpenAI-compatible `/chat/completions` endpoint via `generateOpenAICompatibleResponse()`. Anthropic has its own adapter `generateAnthropicResponse()` that converts to the Messages API format.

Per-provider settings (API key, model, system prompt, custom URL) are stored in `extension_settings.charMemory.providers[key]`.

### LLM Dispatch

`callLLM(userPrompt, maxTokens, defaultSystemPrompt)` is the single dispatch point used by extraction, consolidation, and connection testing. It branches on `extension_settings.charMemory.source`.

### Memory Format

```markdown
<memory chat="main_chat_abc123" date="2024-01-15 14:30">
- Bullet point memories
- One block per extraction/encounter
</memory>
```

### UI Layout (v2.0)

The sidebar (`settings.html`) is a single-view dashboard — no tabs. All complex UI is in center-screen modals and drawers built dynamically in `index.js`:

- **Dashboard** (sidebar): Stats bar, file info, extraction toggle, Extract Now, tool launcher buttons (Consolidate, Batch, Format), mini activity log, diagnostics summary
- **Settings Modal** (`showSettingsModal()`): Left-nav with sections — Connection, Extraction, Storage, Advanced. Uses `cm_modal_*` prefixed IDs to avoid conflicts with sidebar elements.
- **Prompts Modal** (`showPromptsModal()`): Full-width editor for extraction/consolidation prompts with version tracking and update banners
- **Log Drawer** (`toggleLogDrawer()`): Slide-out right-side drawer for the full activity log with verbose toggle and export
- **Troubleshooter Modal** (`showTroubleshooter()`): Health checks, Data Bank file browser, diagnostic report, reset/clear tools
- **Setup Wizard** (`showSetupWizard()`): 3-step first-run flow — LLM Connection, Vector Storage, Ready

### Settings Storage

All settings live under `extension_settings.charMemory`. Key fields:
- `source` — extraction source enum
- `selectedProvider` — active provider preset key
- `providers` — per-provider settings objects
- `extractionPrompt` — customizable prompt template
- `interval`, `cooldownMinutes`, `chunkSize`, `responseLength` — extraction tuning
- `perChat`, `fileName` — storage options
- `promptVersions` — tracks which prompt versions the user has seen (for update notifications)

## Conventions

- All UI element IDs are prefixed with `charMemory_`
- jQuery is used for DOM manipulation (ST convention)
- `LOG_PREFIX = '[CharMemory]'` for all console output
- `logActivity()` for user-visible activity log entries
- `escapeHtml()` for all user-generated content rendered as HTML
- Settings are saved via `saveSettingsDebounced()` (ST global) after any change
- The extraction prompt uses `{{charName}}`, `{{charCard}}`, `{{existingMemories}}`, `{{recentMessages}}` template variables

## Important Patterns

- **Never break the extraction prompt without testing** — the prompt has been iteratively refined to reduce card-trait leakage, meta-narration, and play-by-play. Changes should be tested against multiple characters with varied content.
- **Memory parsing is strict** — only `<memory>` blocks with `- ` bullet lines are recognized. Other formats will be silently ignored.
- **Provider settings are isolated** — switching providers preserves each provider's API key, model, and system prompt independently.
- **NanoGPT has special model fetching** — uses a custom endpoint with rich metadata (provider grouping, subscription/open-source/roleplay/reasoning filters). Other providers use the standard `/models` endpoint.
- **CORS matters** — this runs in a browser. Most providers support CORS but some (Ollama) require configuration (`OLLAMA_ORIGINS=*`).

## Testing

### Automated Tests

Vitest is the test framework. Three tiers:

```bash
npm test                # Unit tests (193 tests, ~300ms) — pure functions in lib.js
npm run test:snapshot   # Snapshot tests (6 tests) — extraction pipeline against 1000-message fixture
npm run test:live       # Live LLM tests (4 tests) — requires a running OpenAI-compatible server
```

**Unit tests** cover parsing, serialization, escaping, format detection, and the three extracted pipeline functions (`stripNonDiegetic`, `formatChatMessages`, `substitutePromptTemplate`).

**Snapshot tests** process real chat data from `test/fixtures/flux-chat.jsonl` through the pipeline and snapshot the output. Update snapshots with `npm run test:snapshot -- --update` after intentional changes.

**Live LLM tests** send extraction prompts to a real LLM and validate the response structure. All HTTP goes through `test/integration/llm-client.js` — add new live tests there rather than hand-rolling another `fetch`. Configured via env vars:

- `TEST_LLM_URL` — endpoint (default: `http://127.0.0.1:1234/v1`)
- `TEST_LLM_MODEL` — model name (default: auto-discover first available)
- `TEST_LLM_KEY` — API key for authenticated endpoints like OpenRouter (default: none)
- `TEST_LLM_MAX_TOKENS` — generation budget (default: 6000)
- `TEST_LLM_TIMEOUT` — per-request timeout in ms (default: 180000)
- `TEST_LLM_TEMPERATURE` — sampling temperature (default: 0.3; set to 0 when chasing a flaky failure)
- `TEST_LLM_NO_THINK` — set to `1` to ask reasoning models to skip thinking

Reasoning models (Qwen3, Gemma thinking variants) work, but need headroom: their chain of thought counts against `max_tokens`, and at a low budget they emit *nothing* visible. The client detects that case and says so explicitly rather than failing as a zero-block parse. It also falls back to `reasoning_content` when a provider returns the answer only there — mirroring `generateOpenAICompatibleResponse` in `index.js`.

Two caveats worth knowing:

- **These tests do not exercise the provider layer.** They call the endpoint directly and drive `lib.js` / `consolidation.js`. Everything in `index.js` — `callLLM`, `generateOpenAICompatibleResponse`, `generateAnthropicResponse`, provider presets — has no automated coverage, because `index.js` imports SillyTavern modules and can't be imported from a test. Changes there need manual verification in ST.
- **The chunked-consolidation test is inherently flaky** (~80% pass against a local reasoning model). It makes several sequential LLM calls and any one of them producing unparseable output aborts the run. On failure it prints the orchestrator's progress log, which identifies which of the null paths was taken. The tier runs with `--no-file-parallelism` so the suites don't contend over a single local model server.

### `lib.js` as Single Source of Truth

`lib.js` is the canonical source for pure utility functions. `index.js` imports them via ES modules (`import { ... } from './lib.js'`). When modifying these functions, edit `lib.js` only — `index.js` picks up changes automatically. Exception: `serializeMemories()` in `index.js` is a separate implementation that uses `getFormatOptions()` for runtime format settings.

### Manual Testing

For UI and integration testing that requires SillyTavern:
1. Install in SillyTavern's `public/scripts/extensions/third-party/CharMemory` (symlink or clone)
2. Restart SillyTavern
3. Test extraction with different providers
4. Check Activity Log (verbose mode via Log Drawer) for LLM prompts/responses
5. Open Troubleshooter to verify health checks and injected memories

## Common Tasks

- **Adding a new provider**: Add entry to `PROVIDER_PRESETS`, no other changes needed if it's OpenAI-compatible with standard `/models` endpoint
- **Modifying the extraction prompt**: Edit `defaultExtractionPrompt` constant. Bump `PROMPT_VERSIONS.extraction` to trigger update notifications for existing users. Users can also customize via the Prompts modal, so changes to the default only affect new installations or users who click "Restore Default"
- **Adding dashboard UI elements**: Add HTML to `settings.html`, add event handler in the appropriate `setup*Controls()` function. Follow the `charMemory_` ID prefix convention
- **Adding modal UI elements**: Build the HTML dynamically in the modal's show function (e.g., `showSettingsModal()`). Use `cm_modal_*` or `cm_ts_*` prefixed IDs to avoid conflicts with sidebar elements
