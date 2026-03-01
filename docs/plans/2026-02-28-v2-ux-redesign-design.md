# CharMemory v1.8 + v2.0 Design Document

## Goal

Simplify the UX for new users while keeping full control for advanced users. Fix accumulated tech debt that makes the codebase hard to maintain. Ship in two phases: v1.8 (internals only, no visible changes) and v2.0 (full UX redesign).

## Current Problems

**UX:**
- 53+ controls spread across 4 tabs and 3 sub-tabs in a narrow sidebar
- No first-run experience — new users see the full complexity immediately
- 4 prompts scattered across Settings and Tools tabs, no central overview
- Prompt updates in new versions are silently ignored for users with custom prompts
- Troubleshooting requires digging through Settings → Advanced for reset/clear actions
- Data Bank files not directly accessible from CharMemory UI

**Tech debt:**
- 6,086-line monolithic `index.js` with 203 functions
- `setupListeners()` is 527 lines wiring all UI events
- 3 near-identical dialog editors (~300 lines duplicated)
- 9 copies of timestamp formatting, 3 copies of block cloning
- `lib.js` duplicates 15 functions from `index.js` — unnecessary since ST supports ES module imports

## Architecture Decision: Modals Over Tabs

The sidebar panel (~300px wide) is the wrong place for configuration. It's good for monitoring and quick actions while chatting. All configuration, editing, and tool workflows move to center-screen modals where there's room to work. This matches how users actually operate: monitoring happens alongside chat, configuring does not.

SillyTavern extensions already create modals (we do it for consolidation, conversion, and the Injection Viewer). This makes modals the primary UI pattern instead of an exception.

---

## Phase 1: v1.8 — Tech Debt Cleanup

No visible UX changes. The goal is to make `index.js` maintainable before rebuilding the UI.

### 1.1 ES Module Imports

`index.js` imports pure functions from `lib.js` instead of duplicating them. Functions to import:

- `escapeAttr()`, `unescapeAttr()`, `escapeHtml()`
- `parseMemories()`, `splitMultiTagBullets()`, `countMemories()`, `serializeMemories()`
- `mergeMemoryBlocks()`, `migrateMemoriesIfNeeded()`
- `detectFileFormat()`, `convertHeuristic()`
- `stripNonDiegetic()`, `formatChatMessages()`, `substitutePromptTemplate()`
- `truncateText()`, `reindexEditingSet()`

The sync-check test (`test/unit/sync-check.test.js`) becomes unnecessary and is removed. `lib.js` becomes the single source of truth.

### 1.2 Shared Editor Factory

Extract `createMemoryEditor(options)` from the three duplicated dialog editors:
- `consolidateMemories()` (lines 4291–4554)
- `previewConversion()` (lines 951–1252)
- `showReformatPreview()` (lines 4605–4764)

The factory accepts options (event namespace, save/undo/rerun callbacks, initial blocks) and returns:
- `render(blocks, editingSet)` → HTML string
- `attachHandlers(container)` → wires event delegation
- `getState()` → current editor blocks
- `cleanup()` → removes event handlers

Each caller passes its specific options. The identical toggle/edit/delete/add-bullet logic lives in one place.

### 1.3 Split setupListeners()

Break the 527-line function into feature-specific initializers:

- `setupConnectionControls()` — provider dropdown, API key, connect, model picker
- `setupExtractionControls()` — interval slider, cooldown, chunk size, response length
- `setupToolControls()` — consolidation, batch, convert pill switching and buttons
- `setupStorageControls()` — per-chat toggle, file name, format settings
- `setupLogControls()` — verbose toggle, clear log

`setupListeners()` becomes a coordinator that calls these five functions.

### 1.4 Utility Extractions

**`getTimestamp()`** — replaces 9 inline copies of the `getFullYear()-padStart` pattern. Lives in `lib.js`, imported everywhere.

**`cloneMemoryBlocks(blocks)`** — replaces 3 copies of `blocks.map(b => ({ ...b, bullets: [...b.bullets] }))`. Lives in `lib.js`.

---

## Phase 2: v2.0 — UX Redesign

### 2.1 Sidebar Dashboard

The sidebar collapses to a single view — no tabs. It's a monitoring dashboard and launcher:

```
┌───────────────────────────────┐
│ CharMemory              [⚙️]  │
├───────────────────────────────┤
│ 🔢 169 memories  ⏱ 3/20 msgs │
│ ⚡ Ready          ● Healthy   │
├───────────────────────────────┤
│ 📄 Flux_the_Cat-memories.md   │
│    42 KB • 11 chunks          │
│    [View / Edit]  [Files ▾]   │
├───────────────────────────────┤
│ ☑ Automatic extraction        │
│ [Extract Now]                 │
├───────────────────────────────┤
│ Tools                         │
│ [Consolidate] [Batch] [Convert│
├───────────────────────────────┤
│ Activity                      │
│ 16:07 Extracted 4 memories    │
│ 15:42 Extracted 3 memories    │
│ [View full log →]             │
├───────────────────────────────┤
│ Diagnostics        [Refresh]  │
│ ✅ Healthy — 7/7 checks pass  │
│ [View details →]              │
├───────────────────────────────┤
│ [🔧 Help, it's not working]   │
└───────────────────────────────┘
```

**Elements:**
- **Gear icon** (top right) → opens Settings modal
- **Stats bar** — memory count, message counter, extraction status, health dot
- **File section** — active memory file with metadata (size, chunk count). **[View / Edit]** opens memory manager. **[Files]** opens a popover listing all Data Bank files for this character with View/Export/Delete/Convert actions.
- **Automatic extraction** toggle + Extract Now button
- **Tool launchers** — Consolidate, Batch, Convert. Each opens its existing modal/dialog.
- **Activity** — last 2-3 log entries inline. "View full log" opens Log drawer.
- **Diagnostics** — summary line. "View details" expands or opens full health check list.
- **Troubleshooter** button — "Help, it's not working" opens the Troubleshooter modal. Also triggered by clicking health dot when issues exist.

### 2.2 Setup Wizard

Center-screen modal with smart triggering.

**Full wizard trigger:** `extension_settings.charMemory` has no provider configured (first launch or fresh install).

**Light nudge trigger:** Health check detects a fixable issue (Vector Storage off, no API key, file not vectorized). Shows a banner on the sidebar: "Something needs attention — [Fix now]" which opens to the relevant wizard step.

**Step 1: LLM Connection**
- Explanation: "CharMemory uses a separate LLM to read your chats and extract memories. This keeps your main LLM's context clean."
- Provider dropdown (Pollinations highlighted for zero-friction start)
- API key field (hidden for providers that don't need one)
- Connect & Test button with inline success/failure
- Model auto-selected, option to change
- [Next →]

**Step 2: Vector Storage**
- Explanation: "Memories are stored in your character's Data Bank. Vector Storage searches them and injects the relevant ones when your character responds."
- Auto-detect current VS configuration using existing health checks
- Green checks for passing, amber warnings for issues
- Each warning has a [Fix] button where possible
- If can't auto-fix, explain what to change and where
- [← Back] [Next →]

**Step 3: Ready**
- Summary of configuration
- Explain what happens next: extraction interval, Extract Now, syringe icon for checking injections, health dot for monitoring
- [Get Started] closes wizard
- Stores `wizardCompleted: true`

**Step 4: Verify It's Working** (triggered after first successful extraction, not during initial wizard)
- "Your first memories were just extracted! Let's make sure retrieval is working."
- Guide: send a message referencing chat history, check syringe icon
- Quick diagnostic:
  - "See relevant memories? You're good."
  - "See irrelevant memories? Score threshold may be too low — [Open Settings]"
  - "See nothing? File may not be vectorized — [Run health check]"
  - "Not sure? Paste injected content + memory file into an LLM to evaluate."
- [Got it] dismisses. Stores `verificationSeen: true`.

**Re-entry:** "Run Setup Wizard" link in Settings modal → Connection section.

### 2.3 Settings Modal

Center-screen modal, opened by gear icon on sidebar. Left sidebar nav, content on right.

```
┌──────────────────────────────────────────────────┐
│ Settings                                    [X]  │
├──────────────┬───────────────────────────────────┤
│              │                                   │
│ Connection   │  (content for selected section)   │
│ Extraction   │                                   │
│ Storage      │                                   │
│ Prompts      │                                   │
│ Advanced     │                                   │
│              │                                   │
└──────────────┴───────────────────────────────────┘
```

**Connection section:**
- LLM source dropdown (Dedicated API / Main LLM / WebLLM)
- Provider dropdown, API key, Connect button, model picker
- System prompt override
- "Run Setup Wizard" link at bottom

**Extraction section:**
- Auto-extraction: interval slider, cooldown slider
- Messages per LLM call, max response length, merge chunks toggle
- "Extraction Prompt (1:1)" — one-line summary + version badge + **[View / Edit]** → opens Prompts modal
- "Extraction Prompt (Group)" — same pattern

**Storage section:**
- Per-chat memories toggle with explanation
- File name field
- Group chat member files (shown when in group chat)

**Prompts section:**
- Overview of all 4 prompts with version badges and customization status
- Each has **[View / Edit]** → opens Prompts modal to that prompt
- Update notifications appear here: "Extraction prompt updated in v2.0 — your custom version is unchanged."

**Advanced section:**
- Memory File Format (chunk boundary, custom separator, metadata prefix) — with note: "Most users don't need to change these. The default block-level format works well with topic-tagged memories."
- Reset extraction state, Clear all memories (with confirmation dialogs)
- Note: Reset/Clear also accessible from Troubleshooter

### 2.4 Prompts Modal

Full-screen modal, opened from **[View / Edit]** buttons in Settings or from update notifications.

```
┌──────────────────────────────────────────────────┐
│ Prompts                                     [X]  │
├──────────┬───────────────────────────────────────┤
│          │                                       │
│ Extract  │  Extraction Prompt (1:1)              │
│ (1:1)    │  v1.7.0 • Default                     │
│          │                                       │
│ Extract  │  ┌───────────────────────────────────┐│
│ (Group)  │  │                                   ││
│          │  │  (full prompt text, editable)      ││
│ Consoli- │  │                                   ││
│ dation   │  │                                   ││
│          │  └───────────────────────────────────┘│
│ Convert  │                                       │
│          │  [Restore Default]  [Save]             │
└──────────┴───────────────────────────────────────┘
```

**Features:**
- Left nav lists all 4 prompts. Click to switch.
- Version badge: which default version this is based on, whether it's default or custom
- Full-width textarea with enough height to read the prompt
- [Restore Default] resets to current version's default
- [Save] saves edits

**Prompt version tracking:**
- Each default prompt has a version number stored in code (e.g. `PROMPT_VERSIONS.extraction = '1.7.0'`)
- User's settings store the version they're based on: `extension_settings.charMemory.promptVersions.extraction = '1.7.0'`
- On extension load, compare: if code version > stored version and user has a custom prompt, show update banner

**When default prompt updated:**
```
┌─────────────────────────────────────────────┐
│ ℹ️ The default prompt was updated in v2.0.   │
│ Your custom prompt is unchanged.            │
│ [Keep mine] [Use new default]               │
│ [Compare & Edit →]                          │
└─────────────────────────────────────────────┘
```

**Compare & Edit** replaces the single textarea with two panes:
- Left: user's current prompt (editable)
- Right: new default prompt (read-only reference)
- User can copy/merge sections from new default into their version
- Reuses the side-by-side pattern from the Convert tool preview

### 2.5 Troubleshooter

Center-screen modal, opened from sidebar button or health dot when issues detected.

**Automated checks (run in sequence):**
1. LLM connection — can we reach the provider?
2. Extraction history — have memories been extracted? If not, why?
3. Memory file — does the Data Bank file exist and have content?
4. Vectorization — is the file vectorized? How many chunks?
5. Injection — were memories injected in the last response? Scores?
6. Score threshold — is it filtering out too much or too little?

Each check shows: pass/fail status, explanation, and fix button where possible.

**Data Bank browser:**

Below the health checks, a list of all Data Bank files for the character:

```
┌──────────────────────────────────────────┐
│ 📄 Flux_the_Cat-memories.md    42 KB     │
│    169 memories • vectorized • 11 chunks │
│    [View] [Edit] [Export] [Delete]       │
├──────────────────────────────────────────┤
│ 📄 Flux-backstory-notes.txt    3 KB      │
│    Not a CharMemory file                 │
│    [View] [Export] [Convert] [Delete]    │
└──────────────────────────────────────────┘

[Import file]
```

Actions:
- **View** — read-only modal with memory block parsing/highlighting for CharMemory files
- **Edit** — opens memory manager
- **Export** — downloads the file
- **Delete** — confirmation dialog, then removes from Data Bank
- **Convert** — for non-CharMemory files, launches Convert tool
- **Import** — upload a file into the character's Data Bank

**Diagnostic report:**

"Copy diagnostic report" button at the bottom bundles: settings snapshot, last activity log entries, health check results, memory count, VS configuration, last injection data. User can paste into an LLM for analysis or share when asking for help.

**Reset/Clear actions** accessible here for troubleshooting convenience (with confirmation dialogs). Same actions as Settings → Advanced.

### 2.6 Log Drawer

Slide-out drawer (same pattern as Injection Viewer), opened from "View full log" on sidebar.

- Full activity log with timestamps
- Verbose toggle
- Clear log button
- Replaces the current Log tab

---

## What Moves Where (Migration Map)

| Current location | v2.0 location |
|---|---|
| Main tab → Extract Now, View/Edit | Sidebar dashboard |
| Main tab → Activity Log | Sidebar (summary) + Log drawer (full) |
| Main tab → Diagnostics | Sidebar (summary) + Troubleshooter (full) |
| Tools tab → Consolidate pill | Sidebar tool launcher → existing modal |
| Tools tab → Batch pill | Sidebar tool launcher → existing modal |
| Tools tab → Convert pill | Sidebar tool launcher → existing modal |
| Settings tab → LLM source, provider | Settings modal → Connection |
| Settings tab → Interval, cooldown | Settings modal → Extraction |
| Settings tab → Chunk size, response length | Settings modal → Extraction |
| Settings tab → Extraction prompt (1:1) | Settings modal → Extraction → [View/Edit] → Prompts modal |
| Settings tab → Extraction prompt (group) | Settings modal → Extraction → [View/Edit] → Prompts modal |
| Settings tab → Per-chat, file name | Settings modal → Storage |
| Settings tab → Memory File Format | Settings modal → Advanced |
| Settings tab → Reset, Clear | Settings modal → Advanced + Troubleshooter |
| Log tab → Activity log, verbose | Log drawer |
| Log tab → Diagnostics | Troubleshooter |
| Consolidation strategy dropdown | Consolidation modal (already there) |
| Conversion prompt | Settings modal → Prompts → [View/Edit] → Prompts modal |
| (new) Data Bank file browser | Sidebar [Files] popover + Troubleshooter |
| (new) Setup wizard | Auto-triggered modal |
| (new) Prompt version tracking | Prompts modal |
| (new) Diagnostic report export | Troubleshooter |

## What's NOT Changing

- Injection Viewer (syringe icon, slide-out drawer) — already good UX
- Message action buttons (Extract Here, Pin) — per-message, not panel UI
- Memory Manager dialog (View/Edit) — works well, just gets more entry points
- Consolidation/Conversion/Reformat dialog internals — already modal, just launched differently
- Provider presets and API architecture — purely internal
- Memory format and extraction pipeline — no changes

## Feature Preservation

No features are removed. Low-use features are preserved but organized for discoverability:

- **Memory File Format** (chunk boundary, custom separator, metadata) → Settings → Advanced, with note that most users don't need to change these
- **WebLLM source** → still in Settings → Connection dropdown
- **Main LLM source** → still in Settings → Connection dropdown, with existing warning about context pollution
- **Merge chunks toggle** → Settings → Extraction
- **NanoGPT model filters** → Settings → Connection (shown when NanoGPT selected)
