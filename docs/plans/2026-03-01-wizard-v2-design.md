# Setup Wizard v2 — Design

## Problem

The current 3-step wizard has several UX issues identified during testing:

1. **OK vs Next confusion** — `POPUP_TYPE.TEXT` renders an OK button in the popup chrome that competes with the wizard's own Next button. Users don't know which to press.
2. **OK closes wizard with no re-entry** — clicking OK exits the wizard. The only way back is the nudge banner, which only appears under specific conditions. Users get stuck.
3. **LLM screen readability** — model search input has transparency issues from `.text_pole` styling. Model list requires scrolling in a dropdown. NanoGPT subscription/open-source models aren't distinguished.
4. **Vector Storage screen confusion** — health checks show contradictory state (file found then not found). Screen is passive — shows problems but gives no actionable controls.
5. **"Ready" screen is unhelpful** — says "all set" even with VS issues. Doesn't orient the user on what to actually do next. No mention of injection sidebar, tools, or existing memory handling.
6. **Auto-trigger bug** — wizard condition checks `!selectedProvider` but `defaultSettings` pre-sets it to `'openrouter'`, so the wizard never triggers on fresh install.
7. **Destructive action scoping** — tools like "Clear All Memories" don't make it clear they affect the current character only (and in non-perChat mode, all that character's chats).

## Design

### Structural Changes

**Popup type:** Change from `POPUP_TYPE.TEXT` (has OK button) to `POPUP_TYPE.DISPLAY` (no chrome buttons). Wizard navigation is entirely through its own Back/Next/Get Started buttons.

**Close behavior:** Add an X button in the wizard header. On click, prompt: "You can reopen this from the dashboard any time." Then close.

**Re-entry — three paths:**
1. **Dashboard gear icon** — always visible in the sidebar panel header. Opens wizard to step 1.
2. **Nudge banner** — existing behavior kept. Appears when health checks detect issues after wizard is completed.
3. **Troubleshooter** — "Re-run Setup Wizard" link in the reset/tools section.

**Auto-trigger fix:** Change condition from `!selectedProvider && !wizardCompleted` to just `!wizardCompleted`. The `wizardCompleted` flag is the canonical "user has been through setup" signal.

### Step 1: Connect

Purpose: Set up the LLM that will read chats and create memory summaries.

**Layout (top to bottom):**

1. **Welcome blurb** — "CharMemory extracts structured memories from your chats so characters can recall past events. It needs an LLM to read messages and create summaries."

2. **Provider dropdown** — same as current. Pollinations highlighted as free/no-key option.

3. **API Key row** — shows/hides based on provider. Same as current.

4. **Connect & Test button** — on success, smoothly reveals the model section below.

5. **Model picker (redesigned):**
   - Solid-background search field replacing the transparent `.text_pole` input
   - Model list in a scrollable container below the search (always visible after connect, not a dropdown requiring click)
   - Max height ~200px with scroll
   - **NanoGPT-specific:** Inline badges `[sub]` `[open]` `[rp]` `[reason]` next to model names, plus filter checkboxes above the list (Subscription, Open Source, Roleplay, Reasoning)
   - Non-NanoGPT providers: searchable list only, no badges/filters

6. **Next button** — enabled after successful connection test.

### Step 2: Configure

Purpose: Set extraction behavior and verify retrieval pipeline.

**Layout (top to bottom):**

1. **Memory Storage section:**
   - Info text: "Each character gets their own memory file in their Data Bank (e.g., `Flux_the_Cat-memories.md`). You can change storage options in Settings later."
   - No per-chat toggle — just inform about the default. Keep it simple.

2. **Extraction Interval:**
   - "How often should CharMemory extract? Every ___ messages."
   - Number input, default 20.
   - Helper text: "Lower = more frequent, more API calls. Higher = less frequent, bigger batches. 20 is a good starting point."

3. **Retrieval (Vector Storage) section:**
   - Brief explanation: "Vector Storage finds the right memories at the right time and injects them into the prompt when your character speaks. Without it, memories are stored but never used."
   - **Three-tier detection:**
     - **VS not enabled:** Red indicator. "Vector Storage is not enabled. CharMemory will store memories but your character won't recall them. Enable it in Extensions → Vector Storage when you're ready."
     - **VS enabled but settings may need tuning:** Yellow indicator. "Vector Storage is active, but its chunk settings may not be optimized for CharMemory's memory block format. CharMemory works best with chunk size 800–1000 chars, overlap 10–25%, and retrieve chunks 2–3. You can adjust these in Extensions → Vector Storage."
     - **VS fully configured:** Green checks.
   - Detection logic: flag chunk size <500 or >1500, overlap = 0, retrieve chunks >5 or 0.

4. **Navigation:**
   - Next button always enabled (VS issues are advisory, not blocking)
   - If VS issues present, yellow note above Next: "You can continue without fixing these — memories will be stored but not retrieved until Vector Storage is configured."

### Step 3: Review & Go

Purpose: Confirm setup, orient the user, handle existing memories.

**Layout (top to bottom):**

1. **Summary card (read-only):**
   - Provider: [name]
   - Model: [name]
   - Connection: ✔ Connected / ⚠ Not tested
   - Extraction: Every [N] messages
   - Vector Storage: ✔ Ready / ⚠ Not configured / ⚠ Needs tuning
   - If something looks wrong, Back button takes them to fix it.

2. **Injection sidebar callout:**
   - "Open the **Injection Sidebar** from the dashboard to see what memories are being used in your character's prompt in real time."

3. **Existing memory conversion (conditional):**
   - Only shows if the character already has a Data Bank memory file.
   - "We found existing memories for [CharName]. The **Convert** tool can reformat them for better retrieval."
   - Two buttons: "Convert Now" / "Skip — I'll do this later"

4. **Scoping note (footer):**
   - "Tools like Clear Memories and Reset Extraction State only affect the current character."

5. **Get Started button** — sets `wizardCompleted = true`, closes wizard, returns to dashboard.

## Scoping Language

Throughout the wizard and in destructive-action confirmations, always specify scope:
- "this character" / "for [CharName]" — not "all memories" or "everything"
- Clear All Memories confirmation should say: "[CharName]'s memory file will be deleted. In default mode, this includes memories from all of [CharName]'s chats."
- Reset Extraction State should say: "Extraction tracking for [CharName] will be reset. The extension will re-process messages from the beginning."

## Technical Notes

- Health checks run once when step 2 loads, result cached in `wizHealthResult`. No re-running on step navigation.
- `POPUP_TYPE.DISPLAY` removes OK/Cancel chrome. Wizard manages its own lifecycle.
- NanoGPT model metadata (subscription, open-source, roleplay, reasoning flags) is already available from the custom models endpoint — just needs to be surfaced in the wizard's model list renderer.
- The "Convert Now" button on step 3 can reuse the existing `showReformatPreview()` flow.
