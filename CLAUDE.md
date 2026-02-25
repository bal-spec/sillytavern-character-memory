# CharMemory — SillyTavern Extension

## Git / GitHub

This repo belongs to the `bal-spec` GitHub account. Before any `git push` or `gh` commands, run:

```
gh auth switch --user bal-spec
```

Do this at the start of every session — the active account resets to `dsayed` between sessions.

## What This Is

A SillyTavern extension that automatically extracts structured character memories from chat messages, stores them as markdown in the character's Data Bank, and relies on Vector Storage for retrieval at generation time.

## File Structure

```
index.js        — All extension logic: extraction, consolidation, provider API calls, UI controllers, event handlers (~3500 lines)
settings.html   — Extension panel UI (settings, memory manager, diagnostics, batch extract)
style.css       — All styling
manifest.json   — ST extension manifest (version, loading order, author)
README.md       — User-facing documentation (getting started guide + technical reference, combined)
CHANGELOG.md    — Version history
images/         — Screenshots for documentation
```

`index.js` is a single-file architecture. All logic lives there — there are no separate modules.

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

### Settings Storage

All settings live under `extension_settings.charMemory`. Key fields:
- `source` — extraction source enum
- `selectedProvider` — active provider preset key
- `providers` — per-provider settings objects
- `extractionPrompt` — customizable prompt template
- `interval`, `cooldownMinutes`, `chunkSize`, `responseLength` — extraction tuning
- `perChat`, `fileName` — storage options

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

There are no automated tests. Testing is manual:
1. Install in SillyTavern's `public/scripts/extensions/third-party/CharMemory` (symlink or clone)
2. Restart SillyTavern
3. Test extraction with different providers
4. Check Activity Log (verbose mode) for LLM prompts/responses
5. Use Diagnostics tab to verify injected memories

## Common Tasks

- **Adding a new provider**: Add entry to `PROVIDER_PRESETS`, no other changes needed if it's OpenAI-compatible with standard `/models` endpoint
- **Modifying the extraction prompt**: Edit `defaultExtractionPrompt` constant. Users can also customize via the UI, so changes to the default only affect new installations or users who click "Restore Default"
- **Adding UI elements**: Add HTML to `settings.html`, add event handler in `setupListeners()`, add controller logic. Follow the `charMemory_` ID prefix convention
