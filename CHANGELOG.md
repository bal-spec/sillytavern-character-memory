# Changelog

## 1.4.0

### New Features

- **Group chat support**: CharMemory now works in group chats. Each group member gets their own memory file, extracted individually. A new group chat only extraction prompt includes participant context so the LLM knows who is speaking and can attribute memories to the correct character.
- **Per-character memory manager for groups**: View/Edit in group chats shows per-character sections, each with their own cards, edit and delete controls.
- **Group-aware consolidation**: Consolidation in group chats shows a character picker — select which character's memories to consolidate.
- **Pin memory in group chats**: The bookmark button on group messages routes the pinned memory to the correct character's file based on the message sender.
- **Per-character filename config for groups**: Each group member can have a custom memory filename configured in Settings.
- **Reverse chronological memory display**: View/Edit now shows newest memory blocks first, so recent extractions appear at the top.

### Improvements

- **Unified code architecture**: All 1:1 and group chat code paths merged behind a single `getMemoryTargets()` abstraction. This eliminated 11 duplicate functions and reduced the codebase by ~400 lines. A 1:1 chat is internally treated as a group with one member.
- **Auto-detect existing memory files**: If a character already has a `*-memories.md` file in their Data Bank, CharMemory finds and uses it automatically instead of creating a new one.
- **Per-chat memories extended to groups**: When "Separate memories per chat" is enabled, group chat members also get per-chat memory files.
- **Context-aware settings**: Settings panel shows only the relevant section for the current chat type (1:1 or group).
- **Resolved filename display**: Settings now shows the resolved memory filename for the current character.
- **Graceful group extraction**: If the LLM call fails for one group member, extraction continues with the remaining members instead of aborting entirely.
- **Reset extraction in groups**: Reset Extraction State clears memory files and tracking for all group members, not just the active character.
- **Narrow viewport layout**: Button row splits into two rows on narrow viewports (iPad landscape and similar).
- **Context-aware prompt titles**: Extraction prompt section now shows "(1:1 chats)" or "(group chats)" so you always know which prompt you're editing.
- **Searchable model picker**: The model dropdown is now a searchable text input. Type to filter models by name — especially helpful for providers with 100+ models like NanoGPT. Supports keyboard navigation (arrow keys, Enter, Escape).
- **Group avatar thumbnails in stats bar**: In group chats, the stats bar shows small character avatars next to the character count. Hover for a tooltip showing each character's memory filename.

### Bug Fixes

- **Fix "Merge extraction chunks" setting**: The merge toggle was not being checked — multi-chunk extractions were always merged regardless of the setting. Now correctly respects the checkbox.
- **Remove placeholder group extraction mode dropdown**: The "Extraction mode" dropdown in group settings had only one option and did nothing. Removed.

## 1.3.0

### New Features

- **Consolidation strategy presets**: Choose between Conservative (only merge near-exact duplicates), Balanced (merge duplicates and related facts), or Aggressive (compress heavily, summarize themes). Each preset's prompt is viewable and editable.
- **Card-based consolidation editor**: Consolidated memories are shown as editable cards matching the original memories' formatting, instead of raw text with tags. Add, edit, and delete individual memories or entire blocks directly in the preview.
- **Re-run with version history**: Each re-run saves the previous version. Click Undo to step back through versions. The version stack lives within the dialog session.

### Improvements

- **Tabbed panel layout**: Extension panel reorganized into tabs (Main, Consolidate, Batch Extraction, Settings, Log) for better discoverability. Consolidation and batch extraction are now first-class tools with their own tabs.
- **Consolidation config in context**: Strategy selection and custom prompt moved to the Consolidate tab, right where you use them, instead of buried in Settings.
- **Read-only consolidation preview**: Consolidated memories now display as clean read-only cards by default, matching the original memories pane. Click the pencil icon on any block to enter edit mode for that block.
- **Themed block headers**: The LLM now groups consolidated memories by theme (e.g., "Relationship History", "Key Events"). Theme names are editable.
- **Editable strategy presets**: Each consolidation strategy (Conservative, Balanced, Aggressive) now has an expandable prompt viewer. Customize any preset's prompt and save it — with Restore Default to revert.
- **Consolidation busy indicator**: The Consolidate button shows "Consolidating…" and disables during LLM processing.
- **Persistent activity log**: A scrollable, resizable activity log is always visible at the bottom of the panel, regardless of which tab is active.
- **Always-visible diagnostics**: Diagnostics moved from the Main tab to a permanent pane at the panel bottom with its own Refresh button.
- **Cleaner panel layout**: Main tab shows "Memory Extraction" heading with automatic extraction toggle. Batch Extraction tab has "Character Attachments" header above the chat list.
- **Optional chunk merging**: Multi-chunk extractions no longer merge into a single block by default. This keeps blocks smaller for long chats, making consolidation viable for memory-dense characters. Enable "Merge extraction chunks" in Settings to restore the old behavior.
- **Date/time extraction**: The default extraction prompt now encourages capturing dates and times when mentioned in conversation, adding temporal context to memories.

## 1.2.1

### Bug Fixes

- **Remove auto-consolidation**: Auto-consolidation was left in and would silently run after bulk "Extract Now" without any user prompting or control. This could result in data loss. This feature has been removed entirely. Consolidation is now manual-only via the Consolidate button, which shows a before/after preview and supports undo.

### Documentation

- **Backup warning**: Added a "Before You Start" section to the README advising users to back up their Data Bank files before using the extension.
- **Consolidation docs updated**: Clarified that consolidation is manual-only, added backup advice, noted that the undo is session-only.

## 1.2.0

### New Features

- **NVIDIA provider**: Added NVIDIA as a built-in provider. NVIDIA's API doesn't support CORS, so requests are automatically routed through SillyTavern's server proxy — no extra setup needed.
- **xAI (Grok) provider**: Added xAI as a built-in provider with Grok models.
- **Pollinations provider**: Added Pollinations as a free, no-API-key provider for quick testing.
- **Reasoning/thinking model support**: Models that use reasoning tokens (e.g., GLM-4.7 on NVIDIA) put output in `reasoning_content` instead of `content`. CharMemory now reads this automatically — in both extraction and consolidation. Verbose logging shows `[reasoning: N chars]` when reasoning tokens are used. Some providers may support disabling reasoning via the system prompt field — see README for details.
- **API key reveal/hide toggle**: Eye icon button next to the API key field to show/hide the key. Auto-hides after 10 seconds for security.
- **Connect/Test Model flow**: Explicit Connect button fetches the model list with inline status feedback. Test Model button verifies the selected model responds correctly, showing model name, response time, and whether it followed the test instruction.
- **Verbose API response logging**: When verbose mode is enabled, the Activity Log shows HTTP status codes, finish reasons, token usage, and reasoning content length for all API calls.
- **Character card in extraction prompt**: The character card is now included as a bounded reference section so the LLM knows what baseline traits NOT to re-extract. This significantly reduces card-trait leakage.

### Improvements

- **Default chunk size reduced**: "Messages per LLM call" default changed from 50 to 20. Testing showed 50 caused timeouts with some providers, and 20 produces good results for most chat styles.
- **Response length slider max increased**: From 2000 to 4000 tokens, to accommodate reasoning/thinking models that need budget for both reasoning and output.
- **Default to Dedicated API via OpenRouter**: Extraction source now defaults to "Dedicated API" instead of "Main LLM", with OpenRouter as the default provider. Dedicated API produces better memories because the extraction prompt isn't polluted by chat context.
- **"Get key" links**: Each provider now shows a direct link to its API key management page next to the API Key field.
- **Clearer UI labels**: "API Provider" renamed to "Dedicated API", "LLM Provider" renamed to "LLM Used for Extraction".
- **Consolidation token budget**: Consolidation automatically uses 2x the configured "Max response length" to give the LLM enough room to process the full memory file.
- **Extraction prompt refinements**: Reduced card-trait leakage, meta-narration, and play-by-play through iterative prompt testing across multiple models.

### Bug Fixes

- **Detect proxy-forwarded API errors**: SillyTavern's proxy returns HTTP 200 even for upstream errors, wrapping them in `{ error: { message } }`. CharMemory now checks the response body for errors instead of relying solely on HTTP status.
- **Add CSRF token to proxy requests**: Proxy requests now include the CSRF token required by SillyTavern's server.
- **Clear stale test status on provider switch**: Test result text no longer persists when switching between providers.
- **Fix extraction counter display**: The progress counter in the stats bar now updates immediately when the interval slider changes.
- **Fix stuck "Testing..." button**: The Test button no longer gets stuck in the "Testing..." state on errors.
- **Guard model fetch when API key is missing**: No longer fires an API request with a blank key when the provider is selected before entering credentials.
- **Fix stale extraction state on chat switch**: When switching to a chat whose extraction index is set but no memories exist for that chat, the index is automatically reset. This prevents the "no unprocessed messages" dead state.
- **Seed message counter on chat switch**: When switching to a chat with unprocessed messages, the auto-extraction counter is seeded with the correct count so extraction fires at the right time.

### Documentation

- **Quick Start guide**: New 4-step minimal setup guide at the top of the README.
- **Full Setup Guide**: Detailed walkthrough with screenshots, separated from the Quick Start.
- **Reasoning model guidance**: New section explaining how thinking models work and how to configure response length.
- **"Why Local Vectorization Is Fine"**: New section explaining why local embedding models are adequate for CharMemory.
- **Extraction tuning guidance**: Advice on adjusting chunk size based on chat style, expectations for batch-extracting long chats.
- **NVIDIA provider notes**: Documentation for the transparent proxy routing.

## 1.1.0

### New Features

- **Injected memories diagnostics**: The diagnostics panel now shows which individual memory bullets were retrieved and injected by Vector Storage during the last generation. Shows bullet count and full text.
- **Character lorebooks**: Diagnostics shows a static list of lorebooks bound to the current character, including entry counts and trigger keys for each entry.
- **Vectorization source/model**: Vectorization status now displays the configured embedding source and model (e.g., "Yes (42 chunks) via transformers/nomic-embed-text").

### Bug Fixes

- **Fix vectorization status always showing "No"**: The vector API call was missing the `source` and `model` parameters, so it couldn't find the correct vector directory. Now reads these from `extension_settings.vectors`.
- **Separate static and runtime lorebook info**: World Info section split into "Character Lorebooks" (always shows bound books) and "Activated Entries — Last Generation" (shows what fired at runtime).

## 1.0.1

### Security

- **Fix XSS in consolidation preview**: Memory bullet text, chat IDs, and dates in the consolidation Before/After preview are now escaped with `escapeHtml()` to prevent script injection from crafted memory content.
