# Changelog

## 2.2.0

### New Features

- **Hide extracted messages from context**: New opt-in setting (Settings → Advanced) that marks extracted messages as hidden from the main LLM after each extraction. Saves context window tokens since the important information is already stored in the Data Bank and retrieved via Vector Storage. Hidden messages show SillyTavern's ghost icon and a dashboard counter shows the hidden count. Fully reversible via "Unhide Extracted Messages" in the Troubleshooter. Scoped to 1:1 chats; group chats and batch extraction are unaffected. Default off.
- **Internationalization (i18n) support**: The extension now uses SillyTavern's native i18n system, allowing the UI to be translated into any language ST supports. All user-facing strings — toastr messages, button labels, tooltips, modal headings, status text, health check labels, and form fields — are wrapped with ST's `t` tagged template literal or `data-i18n` HTML attributes. Locale files are registered via `manifest.json` and loaded automatically by ST's extension loader.
- **Traditional Chinese (zh-tw) locale**: 243 translated strings covering the sidebar dashboard, Settings Modal, Setup Wizard, Troubleshooter, Prompts Modal, consolidation/conversion dialogs, Memory Manager, and all toastr notifications. Based on translations contributed by [@Minijinai75](https://github.com/Minijinai75) in [#12](https://github.com/bal-spec/sillytavern-character-memory/pull/12).
- **French (fr-fr) locale**: Complete French translation — all 420 translatable strings.
- **Translation guide and tooling**: New `docs/translating.md` explains how to create a locale file, the interpolation placeholder format, pluralization patterns, and how to contribute. New `scripts/extract-strings.js` audits translation coverage — run `node scripts/extract-strings.js` for a summary or `--missing-json` to generate a template of untranslated strings.
- **Extraction lag setting**: New "Extraction lag" slider in Settings → Extraction. Set how many additional messages to wait past the interval before automatic extraction fires. Useful on single-GPU local-inference setups — a lag of `2` means extraction runs while you read the reply rather than competing for the same GPU as the next response.
- **Generation-aware extraction**: Automatic extraction now waits until the primary LLM finishes generating, then runs during the natural idle window before your next message. This prevents extraction and reply generation from contending for the same model on local inference setups. If a message arrives during generation, extraction is deferred and fires automatically once generation ends (unless the user aborted the generation).
- **Mark as Fully Extracted button**: New action in the Troubleshooter's Reset / Clear section that marks the active chat's messages as already extracted. Useful when you've imported an existing memory file into a forked chat and want to stop CharMemory from re-reading every message from the beginning.

### Bug Fixes

- **Translate diagnostic report**: The diagnostic report (Troubleshooter → Diagnostic Report) now uses `t`-tagged strings for all section headings, field labels, and status text, so it renders fully in the active language instead of mixing translated health check content with English scaffolding.
- **Fix extraction script generating incomplete translation templates**: `extract-strings.js --missing-json` without `--locale` was comparing against `zh-tw.json` by default, outputting only the keys missing from that locale instead of all translatable strings. New translations started from this template would be missing every key that zh-tw already had. Now `--missing-json` without `--locale` outputs all keys as a complete template; use `--missing-json --locale <file>` to find gaps in a specific locale.

## 2.1.10

### Bug Fixes

- **Fix consolidation and reformat silently dropping last memory blocks**: Consolidation was capped at `responseLength * 2` output tokens (2000 at default), and Reformat at `responseLength` (1000 at default). With large memory sets (40+ blocks), the LLM would hit this limit mid-response and stop, silently discarding the last 2–4 blocks. Both now use `Math.max(responseLength * 4, 4000)` and `Math.max(responseLength * 2, 4000)` respectively, guaranteeing at least 4000 output tokens. A truncation warning is also shown in the activity log and as a notification if the response appears cut off. Fixes [#13](https://github.com/bal-spec/sillytavern-character-memory/issues/13).

### Other

- Enable auto-update: ST's extension manager will now automatically check for and notify you of new versions.

## 2.1.9

### Improvements

- **Setup Wizard connection type selector**: The wizard's Step 1 now lets you choose between **Dedicated API** (default) and **Connection Profile** before configuring the LLM connection. Previously, Connection Profile was only available in the Settings Modal after completing the wizard.
- **Documentation**: Added Connection Profile docs to providers.md, getting-started.md, README.md, and architecture.md. New screenshots for Settings Modal tabs and Connection Profile creation. Documented "Protect Recent Messages" feature in managing-memories.md.

### Bug Fixes

- **Fix message swipes counting toward extraction interval**: Swiping to a different AI response variant was incrementing the extraction counter as if a new message had been sent, causing extraction to trigger sooner than the configured interval. The `CHARACTER_MESSAGE_RENDERED` event handler now checks the `type` argument ST passes and returns early when `type === 'swipe'`. Fixes [#9](https://github.com/bal-spec/sillytavern-character-memory/issues/9).
- **Fix Settings and Troubleshooter modals cramped on mobile**: The left-nav layout used a fixed-width sidebar that consumed nearly half the popup width on narrow screens, leaving the content panel too narrow for readable text. In phone mode, the nav now switches to horizontal tabs above the content panel, giving it the full popup width.
- **Fix tooltip**: Injection Viewer button tooltip said "Toggle Injection Sidebar" — corrected to "Toggle Injection Viewer".

## 2.1.8

### New Features

- **Connection Profile extraction source**: New "Connection Profile" option in Settings → Connection lets you reuse saved SillyTavern connection profiles for memory extraction instead of configuring a dedicated API. Uses ST's ConnectionManagerRequestService — all credentials, model selection, and API routing are handled by the profile. Includes test connection button, system prompt override, and health check integration. The existing Dedicated API source is unchanged. Addresses [#7](https://github.com/bal-spec/sillytavern-character-memory/issues/7).

## 2.1.7

### Improvements

- **Convert button opens preview directly**: The convert button (rotate arrows) in the Troubleshooter's Data Bank file browser now opens the conversion preview dialog immediately, instead of showing a confusing toast asking the user to find the Convert section manually.

### Bug Fixes

- **Fix "Protect Recent Messages" not actually protecting**: The protection buffer calculated a reduced end boundary (`effectiveEnd`) but never passed it to `collectRecentMessages()`, which independently used `chat.length` — extracting the "protected" messages anyway. Now the collection boundary respects the protection, so the most recent N messages are genuinely excluded from auto-extraction. Fixes [#3](https://github.com/bal-spec/sillytavern-character-memory/issues/3) regression.
- **Fix 404 when custom base URL includes /chat/completions**: Users who pasted the full completions endpoint (e.g. `https://example.com/v1/chat/completions`) as their custom base URL would get a 404 on model fetching, since `/models` was appended to the completions path. The suffix is now stripped automatically.
- **NanoGPT model list CORS error**: Fixed "cross-origin request blocked" error when fetching NanoGPT models. Model list requests are now routed through the SillyTavern server proxy, matching the approach already used for local server providers.

## 2.1.6

### Improvements

- **Prompt Breakdown at top of injection viewer**: The injection viewer now opens with a "Prompt Breakdown" section at the top that loads automatically — no need to find or click a collapsed panel. Shows exact per-category token counts (System, Char card, Lorebook, Data Bank, Examples, Chat history) via ST's Prompt Itemization when available, or estimated injection-only numbers for snapshots from previous sessions.
- **Accurate Lorebook token estimates**: Previously token estimates were computed by summing truncated entry content (200 chars/entry from `WORLD_INFO_ACTIVATED`), causing large overestimates on multi-entry lorebooks. Estimates now use the actual injected `worldInfoString` and `dataBankVectorsString` from ST's prompt data, matching the Prompt Breakdown numbers.
- **Data Bank label consistency**: CharMemory's injected memories are now labelled "Data Bank" throughout — section header, breakdown rows, and tips popup — matching SillyTavern's own terminology.
- **Expanded "Optimize" tips popup**: The tips popup now covers all breakdown categories. A new "Char Card / System Prompt" section advises shortening the description, moving lore to the Lorebook, and trimming the system prompt. The intro text is updated to reflect that the breakdown now shows the full prompt, not injections only.

## 2.1.5

### Improvements

- **Unified Context section in injection viewer**: The previous "Context Budget" and "Prompt Breakdown" sections are now a single "Context" section at the top of each injection snapshot. The header shows a compact stacked bar and summary (e.g. `~1,200 / 32,768 tk (4%)`). Expanding loads the full token breakdown — exact per-category counts via ST's Prompt Itemization when available, or injection-only estimates for snapshots from previous sessions.
- **Accurate Lorebook token estimates**: The "Context Budget" section previously summed truncated entry content (200 chars/entry) from `WORLD_INFO_ACTIVATED`, causing large overestimates for lorebooks with many entries. Token estimates now use the actual injected `worldInfoString` from ST's prompt data, giving accurate numbers that match the Prompt Breakdown view.
- **Data Bank label consistency**: The injection viewer now labels CharMemory's injected memories as "Data Bank" throughout (section header, breakdown rows, tips popup), matching SillyTavern's own terminology.
- **Estimated fallback breakdown**: When exact Prompt Itemization data is unavailable (previous session or feature disabled), the Context section body shows an estimated injection-only breakdown using snapshot char counts, with a clear note that the numbers are approximate.
- **Tips to reduce link in full breakdown**: The "Tips to reduce" link (and tips popup) now appears in all breakdown views — both the exact Prompt Itemization breakdown and the estimated fallback.

## 2.1.4

### Improvements

- **Token budget panel in injection viewer**: The per-message injection viewer now shows a "Context Budget" section at the top of each snapshot. A compact horizontal stacked bar (collapsed by default) displays estimated token usage across three tracked sources — CharMemory (purple), Lorebook (amber), and other extension prompts (teal) — relative to the model's configured context limit. Expanding the section shows a per-source breakdown table. Token estimates (~4 chars/token) are labeled as approximate; char card, system prompt, and chat history are noted as not counted.
- **Context overflow and heavy injection warnings**: If tracked injections alone exceed the model context, a red health note flags the overflow. If they exceed 40% of context (leaving little room for char card and chat history), a yellow advisory note appears.
- **Token hints in section headers**: The CharMemory, Lorebook, and Extension Prompts section headers each show a faint `~N tk` estimate so token cost is visible without expanding the budget panel.
- **Token and position metadata in cards**: Each Extension Prompt card now shows its estimated token cost and injection position/depth (e.g. `~340 tk · in-chat @ depth 2`). Lorebook entry cards show estimated token cost. The snapshot now also captures injection `depth` for extension prompts, which was previously missing.
- **"Tips to reduce" popup**: A "Tips to reduce" link in the budget breakdown opens a popup with actionable guidance organized by source — Consolidate and Retrieve chunks for CharMemory, token budget and keyword specificity for Lorebook, per-extension settings for other extensions, and context window / response token tuning for overall budget.

## 2.1.3

### Improvements

- **Generation mode in group diagnostics**: The Group Debug section of the Diagnostic Report now shows the group's generation mode value. This is the key piece needed to diagnose issue #4 — groups using Append (with disabled) mode have all members in the disabled list by design, which was invisible in prior reports.
- **Clearer warning when all group members are disabled**: Instead of the generic "no targets found" message, the Activity Log now says "all group members are disabled in SillyTavern — re-enable at least one in the group settings" when a group has members but all are in the disabled list.
- **Clearer dialog buttons**: Consolidation, conversion, reformat, and Data Bank editor dialogs now show "Save" and "Cancel" buttons instead of ambiguous defaults, preventing accidental loss of edits.
- **Unified Memory Manager editor**: The View/Edit memories dialog now uses the same block editor as Consolidation, Conversion, and the Data Bank browser. Inline editing, undo, add/delete blocks and bullets, and find/replace — all consistent across every editing surface. In group chats, a character picker selects which member to edit.

### Bug Fixes

- **Consolidation dialog not appearing with some LLMs**: Models like GLM-4.7 produce self-closing `<memory chat="..."></memory>` tags with bullets placed after the closing tag instead of inside it. The parser now handles this pattern, recovering per-block structure instead of silently returning an empty result. The same fix is applied to the extraction pipeline.
- **Prompt update notifications silent after upgrading from 1.x**: Users who customized an extraction or consolidation prompt in 1.x and then upgraded to 2.x were never notified that the default prompts had changed. The version-tracking system introduced in 2.0 only ran on the second launch (after `promptVersions` was already initialized), so the first launch after upgrade silently marked all prompts as up-to-date — even customized ones. The check now detects a customized prompt with no prior version record and flags it for review. A toast notification also appears 2 seconds after load whenever any prompt has a pending update, directing users to Settings → Prompts.

## 2.1.2

### Bug Fixes

- **Extraction restarting from the beginning every session**: After running consolidation, `lastExtractedIndex` was reset to -1 on every SillyTavern restart. Consolidation replaces the original chat-ID labels on memory blocks with thematic labels (e.g. "First vet visit"), and the stale-metadata check incorrectly treated those as "no memories found for this chat." The check now resets only when the memory file is genuinely empty.
- **Group chat extraction discarded mid-flight**: If any group member sent a message during an LLM call, the extraction result was silently thrown away and the same messages re-extracted after cooldown — doubling API cost. The context-change guard now only checks for a chat switch in group chats; `characterId` flipping between members is expected and no longer triggers a discard. The discard event is also now visible in the Activity Log instead of being hidden in the browser console.

### Improvements

- **Group chat diagnostics in Troubleshooter**: The Diagnostic Report now includes a Group Debug section when in a group chat, showing member counts, how many resolved vs. unresolved, and any avatar strings that couldn't be matched to a loaded character. Helps diagnose issue #4 where group members aren't detected.

## 2.1.1

### New Features

- **Protect recent messages**: New toggle in Settings > Extraction that excludes the most recent messages from auto-extraction, preventing a feedback loop where just-extracted memories constrain swipes and regenerations. When enabled, a configurable buffer (default: 4 messages) keeps recent events out of memories until the next extraction cycle. Does not affect Extract Now or Extract Here.

### Bug Fixes

- **KoboldCPP vectorization check false negative**: The health check reported files as "not vectorized" when using KoboldCPP as the vectorization backend. KoboldCPP doesn't store its model name in Vector Storage settings — it's discovered dynamically from the API. The check now queries the KoboldCPP embed endpoint to discover the correct model name before looking up vector data.

## 2.1.0

### New Features

- **Tablet / Touch Mode**: On touch devices (iPad, tablets), the dashboard now opens as a centered floating panel instead of expanding in the narrow sidebar. All buttons are enlarged to 44px touch targets per Apple HIG. The panel is non-modal — tap outside or swipe down to dismiss, and tools like Settings and Troubleshooter open on top.
- **Display Mode setting**: The old Tablet/Touch Mode toggle (Auto/On/Off) is replaced with a unified Display Mode selector in Settings > Advanced. Four options: Auto (detect your device), Desktop (sidebar), Tablet (floating panel), Phone (panel + wider drawers). Forced overrides work regardless of actual viewport — useful when auto-detection gets it wrong.
- **Phone layout**: On narrow viewports (≤600px), the injection viewer and activity log drawers are widened to 85vw and raised above the SillyTavern sidebar (z-index 4000). Auto-detected in Auto mode, or force via the Phone display mode.

### Bug Fixes

- **Tablet panel off-screen on mobile**: SillyTavern sets `perspective` on `<html>`, which changes the containing block for `position: fixed` elements. The panel's `top: 50%` resolved to 0px on mobile. Fixed by using viewport units (`50vh`/`50vw`) instead of percentages.
- **Tablet panel hidden behind sidebar**: The panel's z-index (1002) was below SillyTavern's extensions drawer (3005). Raised to 5000.
- **Injection viewer and log drawer hidden on mobile**: Both drawers had z-index below the sidebar and were too narrow at phone widths (40vw = 157px on a 393px screen). Phone mode overrides fix both issues.
- **Nudge banner "Fix now" → "View"**: The warning banner button now says "View" since it opens the Troubleshooter for inspection — it doesn't auto-fix anything.

## 2.0.1

### Improvements

- **Topic tags now include character name**: All extraction, consolidation, and conversion prompts produce topic tags starting with the character's name (e.g., `[Flux, Alex — adoption day]` instead of `[Alex — adoption day]`). This improves vector embedding discrimination for retrieval. Prompt versions bumped to `2.0.1` — users with customized prompts will see an update notification.
- **Cross-chunk deduplication**: When extraction spans multiple chunks, each chunk's output is now fed forward as existing memories for subsequent chunks. This prevents duplicate memory blocks when a scene spans a chunk boundary.
- **Sanitized prompt examples**: DO NOT EXTRACT examples in extraction prompts now use neutral, non-explicit examples.

### Bug Fixes

- **False alarm: file vectorization on chat open**: The health check no longer shows a red error when opening an existing chat whose memory file hasn't been re-indexed yet by Vector Storage. Downgraded to a yellow note explaining it resolves automatically on the next message.
- **False alarm: "no memories injected"**: When no memories match the current conversation topic (score threshold filtering working correctly), the health check and injection viewer now show a yellow info note instead of a red error. Zero matches is a normal state, not a failure.
- **Consolidation {{charName}} substitution**: The consolidation pipeline now correctly substitutes the character's name into topic tag instructions. Previously, `{{charName}}` in consolidation prompts was not replaced because `buildConsolidationPrompt()` only called `substituteParamsExtended()` (which handles `{{char}}` but not `{{charName}}`).

## 2.0.0

### New Features

- **Find & Replace across all editing surfaces**: A compact find/replace bar is available in the Memory Manager, Consolidation, Conversion Preview, Reformat Preview, and Data Bank editor. Type to see matches highlighted with a live count. Replace All updates every occurrence at once. Supports case-sensitive matching. In block editor dialogs (Consolidation, Reformat, Conversion, Data Bank editor), Replace All is undoable.
- **Undo in Data Bank editor**: The Data Bank file editor now has an Undo button that reverts Replace All, delete, and add operations. Nothing is written to disk until you click Save.

### UX Redesign

Complete UI overhaul replacing the 4-tab sidebar (Main, Tools, Settings, Log) with a streamlined dashboard + modal architecture.

- **Single-view dashboard**: Sidebar is now a compact dashboard with stats bar, file info, extraction toggle, Extract Now button, tool launchers (Consolidate, Batch, Format), mini activity log, and diagnostics summary
- **Settings modal**: All settings moved to a center-screen modal with left-nav sections (Connection, Extraction, Storage, Advanced). Opens via gear icon in sidebar header
- **Prompts modal**: Dedicated full-width editor for extraction and consolidation prompts with prompt version tracking and update notifications when defaults change
- **Log drawer**: Activity log moved to a slide-out right-side drawer with verbose toggle, export, and swipe-to-close on touch devices
- **Troubleshooter modal**: Replaces the old Diagnostics panel. Includes automated health checks, Data Bank file browser with export/delete/convert actions, diagnostic report, and reset/clear tools. Opens via wrench icon in sidebar header
- **Setup wizard**: First-run 3-step flow (LLM Connection, Vector Storage, Ready) that guides new users through initial configuration. Detects unconfigured state and shows a nudge banner
- **Prompt version tracking**: When default prompts are updated between versions, users with customized prompts see an update banner with options to view changes, adopt the new default, or dismiss
- **Health indicator in stats bar**: Traffic-light dot showing injection health status — click to open Troubleshooter

### Developer

- Removed dead CSS for old tab/pill layout (`.charMemory_tabs`, `.charMemory_toolPills`, etc.)
- Removed dead JS handlers binding to old sidebar element IDs (`#charMemory_consolidate`, `#charMemory_undoConsolidate`, `#charMemory_verboseLog`, etc.)
- Removed unused `updateDiagnosticsDisplay()` function (~180 lines)
- Cleaned up `loadSettings()` — removed jQuery no-ops targeting elements that no longer exist in the sidebar HTML
- Settings modal uses `cm_modal_*` prefixed IDs to avoid conflicts with sidebar dashboard elements

## 1.8.0

### Developer

No user-facing changes. Internal refactoring to make the codebase maintainable ahead of the v2.0 UX redesign.

- **ES module imports from lib.js**: `index.js` now imports pure functions from `lib.js` instead of maintaining duplicate copies. `lib.js` is the single source of truth for parsing, escaping, formatting, and migration functions. The sync-check test that verified duplication consistency is removed.
- **Shared memory editor factory**: New `editor.js` module with `createMemoryEditor()` — encapsulates block state management, undo, and edit-mode tracking. Replaces ~300 lines of duplicated state management across the Consolidation, Conversion, and Reformat dialog editors.
- **Split setupListeners()**: The 527-line monolithic event-wiring function is now a 7-line coordinator calling `setupConnectionControls()`, `setupExtractionControls()`, `setupToolControls()`, `setupStorageControls()`, and `setupLogControls()`.
- **Utility extractions**: `getTimestamp()` and `cloneMemoryBlocks()` replace 9 inline timestamp constructions and 3 inline block-clone patterns.
- **Net result**: `index.js` reduced from ~6,086 to ~5,709 lines. Test count increased from 100 to 117.

## 1.7.0

### New Features

- **Retrieval-optimized memory format**: Extraction prompts now produce topic-tagged memory blocks with a `[Names — description]` tag as the first bullet. This improves vector search discrimination, allowing Vector Storage to retrieve only the most relevant memories instead of thematically similar ones.
- **Unified Convert tool**: The Convert and Reformat tools are merged into a single Convert tool with a source picker. Select "Current memories" to reformat existing memories to the new topic-tagged format, or "Data Bank file" to import from any file. The conversion prompt is always visible for easy iteration.
- **Recommended VS settings**: Diagnostics panel now includes a "Recommended Vector Storage Settings" card with optimal chunk size, retrieve chunks, score threshold, and other settings for CharMemory.

### Improvements

- **Tighter memory blocks**: Default bullet limit reduced from 8 to 5 per block (not counting the topic tag). Forces outcome-focused extraction rather than step-by-step narration.
- **Better consolidation labels**: Consolidation now uses encounter-specific labels (e.g., "Adoption day at the apartment") instead of broad categories (e.g., "Key Events"). Topic tags are preserved and updated during consolidation.
- **Improved health checks**: Chunk size recommendations now include specific guidance (800-1000 chars). New checks for retrieve chunks and score threshold.
- **Named participants**: Extraction and consolidation prompts now require specific names instead of generic labels like "a client" or "someone".
- **Multi-tag block splitting**: When the LLM produces a memory block with multiple topic tags, it is automatically split into separate blocks — one per topic. This ensures clean 1:1 mapping between topic tags and vector chunks.

### Bug Fixes

- **Fix parsing of attributed memory tags**: The LLM sometimes copies `<memory chat="..." date="...">` attributes from existing memories into its response. The extraction regex now handles both bare and attributed `<memory>` tags instead of silently falling through to a single-entry fallback.
- **Hide redundant mini-log on Log tab**: The always-visible activity log mini-bar is now hidden when the full Log tab is active, avoiding duplicate display.

### Migration

- Existing memories continue to work without changes. Use the **Convert** tool (source: "Current memories") to add topic tags to existing memory files for improved retrieval.
- Users with customized extraction prompts are unaffected — only the default prompt is updated. Click "Restore Default" to opt into the new format.

## 1.6.1

### New Features

- **Local Server provider preset**: New combined "Local Server" preset in the Provider dropdown supports Ollama, KoboldCpp, llama.cpp, and LM Studio out of the box. The Base URL field is shown automatically so you can point it at any local IP or port (e.g., `http://192.168.1.50:8080/v1`). No API key required. Requests are routed through SillyTavern's server proxy to avoid CORS issues.

### Improvements

- **Base URL helper text**: Shows the expected URL format (`http://IP:port/v1`) below the Base URL field, noting that the `/v1` suffix is required.
- **Connect button always visible**: The Connect button is no longer hidden when a provider doesn't require an API key. It appears after the Base URL field for a natural top-to-bottom flow: URL → Connect → Model.
- **Clean provider switching**: Switching providers clears stale model names from the previous provider and prompts you to click Connect to fetch models.

### Migration

- The standalone **Ollama** preset has been merged into **Local Server**. Existing users with Ollama selected are automatically migrated — your model, system prompt, and URL (`http://localhost:11434/v1`) are preserved.

### Developer

- **Automated test suite**: Three-tier Vitest setup — 90 unit tests for `lib.js` pure functions, 6 snapshot integration tests against a 1000-message chat fixture, and 3 live LLM integration tests that validate extraction output structure against a real OpenAI-compatible endpoint.
- **Extraction pipeline refactor**: Extracted `stripNonDiegetic()`, `formatChatMessages()`, and `substitutePromptTemplate()` from inline code in `index.js` into testable pure functions in `lib.js`. No behavior change — `index.js` uses local copies.
- **Live test configuration**: `TEST_LLM_URL`, `TEST_LLM_MODEL`, and `TEST_LLM_KEY` env vars support both local servers (LM Studio, Ollama) and authenticated remote APIs (OpenRouter, NanoGPT).

## 1.6.0

### New Features

- **Injection Viewer**: See exactly what memories, lorebook entries, and extension prompts were injected for each AI response — answering "what caused this response?"
  - Syringe indicator icon on AI messages that have recorded injection data
  - "View Injected" button in the message action menu (alongside Extract Here and Pin)
  - Toggleable side drawer with collapsible sections for CharMemory, Lorebook Entries, and Extension Prompts
  - Drawer auto-updates on new generations and persists open/closed state across sessions
  - Injection data is stored per-message in chat metadata for historical review
  - Click any past message's indicator to see what was injected for that specific generation
  - Toolbar with capture timestamp and diagnostics link
  - Swipe-to-close on touch devices
- **Injection Health Score**: Traffic-light indicator (green/yellow/red/gray) that automatically checks your Vector Storage configuration and flags issues like missing files, zero overlap, or duplicate memories.
  - Health dot in the stats bar (5th item) — click to jump to Diagnostics
  - Health dot in the Injection Viewer drawer header — shows injection-specific stats on hover
  - Health card in the Diagnostics panel with per-check status and recommendations
  - Runs up to 7 checks: files enabled, memory file exists, file vectorized, chunk overlap, chunk size, memories injected, duplicate detection

### Improvements

- **Full Data Bank content in diagnostics**: Extension Prompts section in both the Injection Viewer and Diagnostics now shows the complete injected content, not truncated previews.
- **Touch-friendly diagnostics**: On iPad and other touch devices, the Diagnostics link in the Injection Viewer shows an inline health summary directly in the drawer instead of navigating to the Extensions panel.
- **Theme-compatible icons**: Drawer icons and indicator dots are visible across all SillyTavern themes (dark, light, OLED).

### Bug Fixes

- **Fix iPad header clipping**: Drawer header no longer clips behind the iPad notch/safe area.
- **Fix memory parsing in diagnostics**: Memories are now parsed from the full injected content rather than truncated diagnostic data.

## 1.5.0

### New Features

- **Tools tab**: Consolidate, Batch Extraction, and the new Convert tool are now grouped under a single Tools tab with pill-button sub-navigation. Top-level tabs are now Main | Tools | Settings | Log.
- **Memory file format settings**: New "Memory File Format" section in Settings controls how memories are separated in the Data Bank file for Vector Storage chunking. Options: Block-level (default, unchanged), Bullet-level (each bullet gets its own chunk), or Custom separator.
- **Include metadata in chunks**: When using bullet-level or custom chunking, optionally prefix each bullet with `[date | chat_id]` so standalone vector chunks retain their provenance.
- **Reformat offer**: When changing the chunk boundary setting, a confirmation popup offers to reformat the existing memory file to match the new format.
- **Convert / Import tool**: Convert any Data Bank file into CharMemory's `<memory>` tag format. Supports 6 input formats via heuristic parsing (bullet lists, numbered lists, markdown headings, old CharMemory format, freeform text) with optional LLM-assisted restructuring for unstructured content. Non-destructive: original file is never modified.
- **Interactive conversion preview**: The Convert tool uses the same popup dialog as Consolidation — side-by-side panes with the original file on the left and editable memory cards on the right. Edit, add, or delete blocks and bullets before saving. Includes Re-run (with LLM toggle) and Undo. Output destination (auto or custom filename) is chosen inside the dialog.
- **Conversion prompt**: Configurable LLM prompt for the Convert tool, with disclosure accordion and Restore Default button (matching the Consolidation prompt pattern).

### Improvements

- **Round-trip safety**: `parseMemories()` now handles metadata-prefixed bullets (`[date | chat] - text`), ensuring files written in any format mode can be correctly parsed back.
- **Error handling**: `convertWithLLM()` and `previewConversion()` now catch and report errors gracefully instead of failing silently.
- **Convert source dropdown verification**: The source file dropdown now verifies files against the server before displaying, removing phantom entries for files that were deleted through the Data Bank UI.

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
- **Group avatar thumbnails in stats bar**: In group chats, the stats bar shows "Group:" followed by small character avatars. Hover for a tooltip showing each character's name and memory filename.

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
