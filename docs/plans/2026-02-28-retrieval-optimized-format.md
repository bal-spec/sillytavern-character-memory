# Retrieval-Optimized Memory Format — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve vector retrieval precision by updating extraction/consolidation prompts to produce topic-tagged, concise memory blocks, adding a Reformat tool for existing memories, and enhancing diagnostics to warn about Vector Storage misconfigurations.

**Architecture:** Three phases — (1) update all prompt strings and tests, (2) add Reformat tool to the Tools tab using the existing conversion dialog pattern, (3) enhance health checks. All changes are in `index.js`, `settings.html`, `lib.js`, and test files. No new dependencies.

**Tech Stack:** JavaScript (SillyTavern browser extension), jQuery, Vitest

---

## Phase 1: Prompt Updates

Prompt changes only affect users on the default prompt. Users with customized prompts are unaffected. The "Restore Default" button becomes the opt-in mechanism.

### Task 1: Update Solo Extraction Prompt

**Files:**
- Modify: `index.js:111-183` (the `defaultExtractionPrompt` template literal)
- Reference: `docs/proposed-solo-extraction-prompt.txt`

**Step 1: Read the current prompt and proposed replacement**

Read `index.js` lines 111-183 and `docs/proposed-solo-extraction-prompt.txt` to confirm the exact diff.

**Step 2: Replace `defaultExtractionPrompt` in index.js**

Replace the entire template literal (lines 111-183) with the contents of `docs/proposed-solo-extraction-prompt.txt`, wrapped in backticks as a template literal. Key changes:
- New instruction 6: topic tag as first bullet `- [Names — description]`
- Instruction 7: bullet limit 8 → 5 per block (not counting topic tag)
- New line in WHAT TO EXTRACT: "Always name specific people involved"
- Updated negative example: Flux play-by-play (8 bullets about adoption day)
- Updated positive example: Flux topic tag + 3 outcome bullets
- Positive example label changed from "Marcus — warehouse heist" to Flux example

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: update default extraction prompt with topic tags and 5-bullet limit"
```

### Task 2: Update Group Extraction Prompt

**Files:**
- Modify: `index.js:185-238` (the `defaultGroupExtractionPrompt` template literal)
- Reference: `docs/proposed-group-extraction-prompt.txt`

**Step 1: Replace `defaultGroupExtractionPrompt` in index.js**

Replace the entire template literal (lines 185-238) with the contents of `docs/proposed-group-extraction-prompt.txt`. Key changes mirror the solo prompt:
- New instruction 6: topic tag
- Instruction 7: bullet limit 8 → 5
- New line in WHAT TO EXTRACT: "Always name specific people involved"

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: update default group extraction prompt with topic tags and 5-bullet limit"
```

### Task 3: Update Consolidation Presets and Wrapper

**Files:**
- Modify: `index.js:4066-4082` (`CONSOLIDATION_PRESETS` object)
- Modify: `index.js:4090-4104` (`buildConsolidationPrompt` ADDITIONAL FORMAT RULES)
- Reference: `docs/proposed-consolidation-presets.txt`

**Step 1: Update the three preset prompt strings**

In `CONSOLIDATION_PRESETS` (line 4066):

**Conservative** — append to existing prompt:
```
Each block must start with a topic tag as the first bullet: "- [Names involved — short description]" (e.g., "- [Alex, Flux — adoption day at the apartment]"). Preserve existing topic tags.
```

**Balanced** — append to existing prompt:
```
Each block must start with a topic tag as the first bullet: "- [Names involved — short description]" (e.g., "- [Alex, Flux — adoption day at the apartment]"). When merging blocks, update the topic tag to reflect the combined content. No more than 5 bullets per block (not counting the topic tag).
```

**Aggressive** — append to existing prompt:
```
Each block must start with a topic tag as the first bullet: "- [Names/themes — short description]" (e.g., "- [Alex, Sarah — first visit to the apartment]"). No more than 5 bullets per block (not counting the topic tag). Always name specific people — never use "a client" or "someone."
```

**Step 2: Update the FORMAT RULES in `buildConsolidationPrompt()`**

At line 4096-4100, replace the ADDITIONAL FORMAT RULES section:

```javascript
ADDITIONAL FORMAT RULES:
1. Do NOT use emojis anywhere in the output.
2. Do NOT copy text verbatim from the input — rephrase in third person.
3. Group memories by theme or encounter. Each group is wrapped in <memory chat="Theme Name"></memory> tags where "Theme Name" is a short, specific label. Prefer encounter-specific labels (e.g., "Adoption day at the apartment", "First vet visit") over broad categories (e.g., "Key Events", "Relationships"). Specific labels improve later retrieval.
4. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").
5. The first bullet in each block must be a topic tag: "- [Names — short description]". This is mandatory.
6. Always use specific names for people involved, never generic labels like "a client" or "someone."
```

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: update consolidation presets with topic tags and encounter-specific labels"
```

### Task 4: Update Conversion/Reformat Prompt

**Files:**
- Modify: `index.js:240-253` (`defaultConversionPrompt` template literal)
- Reference: `docs/proposed-reformat-prompt.txt`

**Step 1: Replace `defaultConversionPrompt` with the unified reformat prompt**

Replace the entire template literal with the contents of `docs/proposed-reformat-prompt.txt`. This prompt handles all three cases:
- Unstructured text → create `<memory>` blocks with topic tags
- Existing `<memory>` blocks without tags → add tags + trim to 5 bullets
- Already-formatted blocks → leave unchanged

Note: The `{{today}}` placeholder in the prompt needs to be substituted at call time. Check how `convertWithLLM()` (line 802) builds the prompt — it uses `defaultConversionPrompt` with `{{sourceText}}` and `{{charName}}` substitutions. Add `{{today}}` substitution there:
```javascript
.replace(/\{\{today\}\}/g, new Date().toISOString().slice(0, 10))
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: replace conversion prompt with unified reformat prompt"
```

### Task 5: Update lib.js Copies (if applicable)

**Files:**
- Modify: `lib.js` (if any prompt-related functions are duplicated there)

**Step 1: Check if lib.js contains any of the updated functions**

The prompts are constants, not functions. `lib.js` only contains copies of `stripNonDiegetic`, `formatChatMessages`, and `substitutePromptTemplate`. The prompt constants are NOT in `lib.js`.

**Step 2: Run the sync check test to verify**

Run: `npm test -- --grep "sync"`

Expected: PASS — the sync check only validates the three duplicated functions, not prompt constants.

**Step 3: No changes needed to lib.js for prompt updates.**

### Task 6: Update Sample LLM Response Fixture

**Files:**
- Modify: `test/fixtures/sample-llm-response.txt`

**Step 1: Update the fixture to include a topic tag**

The current fixture:
```
<memory chat="main_abc123" date="2026-01-15 10:00">
- Alex adopted Flux the Cat from a pet store and brought him to his penthouse apartment
- Flux immediately bonded with his custom Gundam-styled Roomba, using it as personal transport
- Alex works in marketing and had a video conference with his boss Mr. Henderson on Flux's first day
- Flux's first meal was premium salmon pate, which triggered his first purr in the new home
</memory>
```

Replace with:
```
<memory chat="main_abc123" date="2026-01-15 10:00">
- [Alex, Flux — adoption day and settling into the apartment]
- Alex adopted Flux and brought him to his penthouse, where Flux immediately bonded with his custom Gundam-styled Roomba.
- Flux's first meal of premium salmon pate triggered his first purr in the new home.
- Alex assembled a cat tree that Flux claimed as a second perch alongside the Roomba.
</memory>
```

**Step 2: Commit**

```bash
git add test/fixtures/sample-llm-response.txt
git commit -m "test: update sample LLM response fixture with topic tag format"
```

### Task 7: Update Snapshot Tests

**Files:**
- Modify: `test/integration/__snapshots__/snapshot.test.js.snap`

**Step 1: Run snapshot tests to see what breaks**

Run: `npm run test:snapshot`

Expected: The `substitutePromptTemplate` snapshots will fail because the default prompt text changed. The `formatChatMessages` and `stripNonDiegetic` snapshots should still pass (they don't involve prompt text).

**Step 2: Review the snapshot diff**

The failing snapshots should show the old prompt text being replaced by the new prompt text. Verify the new prompt content looks correct in the snapshot output.

**Step 3: Update snapshots**

Run: `npm run test:snapshot -- --update`

**Step 4: Run all tests to confirm everything passes**

Run: `npm test`

Expected: All tests pass.

**Step 5: Commit**

```bash
git add test/
git commit -m "test: update snapshots for new extraction prompt format"
```

---

## Phase 2: Reformat Tool

Add a "Reformat" tool to the Tools tab that runs existing memory files through the LLM to add topic tags and trim bullets. Uses the same dialog pattern as consolidation (preview + edit + confirm + undo).

### Task 8: Add Reformat Pill to Tools Tab HTML

**Files:**
- Modify: `settings.html:57-64` (tool pills section)
- Modify: `settings.html` (add new tool content pane)

**Step 1: Add "Reformat" pill button after "Convert"**

In settings.html, find the tool pills section and add a fourth pill:
```html
<div class="charMemory_toolPill" data-tool="reformat">Reformat</div>
```

**Step 2: Add the Reformat tool content pane**

After `#charMemory_toolConvert`, add:
```html
<div id="charMemory_toolReformat" style="display:none;">
    <div class="charMemory_toolDescription">
        Reformat existing memories to improve vector retrieval. Adds topic tags, trims to 5 bullets per block, and ensures specific names are used. Works on any format — unstructured text, old memory blocks, or already-formatted blocks.
    </div>
    <div class="charMemory_inlineRow">
        <div id="charMemory_reformatPreview" class="menu_button">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Preview Reformat
        </div>
        <div id="charMemory_undoReformat" class="menu_button" disabled>
            <i class="fa-solid fa-rotate-left"></i> Undo Reformat
        </div>
    </div>
</div>
```

**Step 3: Commit**

```bash
git add settings.html
git commit -m "feat: add Reformat pill and content pane to Tools tab"
```

### Task 9: Wire Up Reformat Tool in JavaScript

**Files:**
- Modify: `index.js` (add reformat flow near consolidation code, ~line 4050)
- Modify: `index.js` (add event handlers in `setupListeners()`, ~line 4900)

**Step 1: Add `reformatBackup` variable**

Near `consolidationBackup` declaration (search for `let consolidationBackup`), add:
```javascript
let reformatBackup = null;
```

**Step 2: Add `reformatMemories()` async function**

Add after `consolidateMemories()`. This function:

1. Reads the current memory file for the active character
2. If no memories exist, shows error and returns
3. Sends the full memory text through `convertWithLLM()` using the updated `defaultConversionPrompt` (which is now the reformat prompt)
4. Shows a preview dialog using `buildConversionDialog()` (reuse the existing conversion dialog builder — it already has the left/right pane with editing)
5. On confirmation:
   - Backs up current content to `reformatBackup`
   - Writes reformatted blocks to the memory file
   - Enables the Undo button
   - Shows success toast

```javascript
async function reformatMemories() {
    const context = getContext();
    if (!context.characterId) {
        toastr.warning('No character selected.', 'CharMemory');
        return;
    }

    const charName = context.name2;
    const content = await readMemoriesForCharacter();
    if (!content || !content.trim()) {
        toastr.warning('No memories found to reformat.', 'CharMemory');
        return;
    }

    const blocks = parseMemories(content);
    if (blocks.length === 0) {
        toastr.warning('No memory blocks found in file.', 'CharMemory');
        return;
    }

    logActivity(`Reformat started: ${blocks.length} blocks`);

    // Check if already formatted (all blocks have topic tags)
    const allHaveTags = blocks.every(b => b.bullets.length > 0 && /^\[.+\]$/.test(b.bullets[0].trim()));
    if (allHaveTags) {
        const proceed = await callGenericPopup(
            'All memory blocks already appear to have topic tags. Reformat anyway?',
            POPUP_TYPE.CONFIRM,
        );
        if (!proceed) return;
    }

    // Send through LLM
    const reformatted = await convertWithLLM(content, charName);
    if (!reformatted) {
        toastr.error('Reformat failed — no response from LLM.', 'CharMemory');
        return;
    }

    const newBlocks = parseMemories(reformatted);
    if (newBlocks.length === 0) {
        toastr.error('Reformat produced no valid memory blocks.', 'CharMemory');
        return;
    }

    // Show preview dialog (reuse conversion dialog pattern)
    const result = await showReformatPreview(blocks, newBlocks, charName);
    if (!result) return; // User cancelled

    // Save with backup
    reformatBackup = content;
    const serialized = serializeMemories(result);
    await writeMemoriesForCharacter(serialized);
    $('#charMemory_undoReformat').prop('disabled', false);
    logActivity(`Reformat complete: ${blocks.length} blocks → ${result.length} blocks`);
    toastr.success(`Reformatted ${result.length} memory blocks.`, 'CharMemory');
}
```

Note: `showReformatPreview()` should be a simplified version of the consolidation dialog. It needs:
- Left pane: original blocks (read-only)
- Right pane: reformatted blocks (editable — same card editor as consolidation)
- Confirm/Cancel buttons
- Returns the edited blocks array or null if cancelled

The easiest approach is to reuse `buildConsolidationDialog()` with minor modifications, or create a generic `buildMemoryComparisonDialog(originalBlocks, newBlocks, title)` that both consolidation and reformat can use. However, to minimize risk and code churn, the simplest path is to build a standalone `showReformatPreview()` that creates a popup with the same HTML structure as the consolidation dialog.

**Step 3: Add undo handler**

```javascript
async function undoReformat() {
    if (!reformatBackup) return;
    const confirm = await callGenericPopup(
        'Undo the last reformat and restore original memories?',
        POPUP_TYPE.CONFIRM,
    );
    if (!confirm) return;
    await writeMemoriesForCharacter(reformatBackup);
    reformatBackup = null;
    $('#charMemory_undoReformat').prop('disabled', true);
    toastr.info('Reformat undone — original memories restored.', 'CharMemory');
    logActivity('Reformat undone');
}
```

**Step 4: Wire up event handlers in `setupListeners()`**

Near the consolidation button handlers (search for `$('#charMemory_consolidate')`):

```javascript
$('#charMemory_reformatPreview').off('click').on('click', () => reformatMemories());
$('#charMemory_undoReformat').off('click').on('click', () => undoReformat());
```

Also update the tool pill switching handler to include 'reformat':
```javascript
if (tool === 'reformat') { /* no special init needed */ }
```

**Step 5: Handle `{{today}}` in the conversion prompt**

In `convertWithLLM()` (around line 802-837), add the `{{today}}` substitution when building the prompt:
```javascript
.replace(/\{\{today\}\}/g, new Date().toISOString().slice(0, 10))
```

**Step 6: Commit**

```bash
git add index.js
git commit -m "feat: add Reformat tool with preview, confirmation, and undo"
```

### Task 10: Build the Reformat Preview Dialog

**Files:**
- Modify: `index.js` (add `showReformatPreview()` function)
- Modify: `style.css` (reuse existing consolidation dialog styles if possible)

**Step 1: Implement `showReformatPreview()`**

This function creates a popup dialog showing original vs reformatted blocks side-by-side. It should closely follow the consolidation dialog pattern from `buildConsolidationDialog()` (line 4002) but simplified — no strategy dropdown, no re-run button. Just:
- Left pane: "Original" with read-only block cards
- Right pane: "Reformatted" with editable block cards
- Stats bar: "Original: N blocks → Reformatted: M blocks"
- OK/Cancel buttons (via `callGenericPopup`)

Use the same card HTML structure and editing event delegation as the consolidation dialog. The key functions to reference:
- Block card rendering: look at how consolidation renders `editorBlocks` into HTML cards
- Edit mode toggling: the `.charMemory_toggleEdit` click handler
- Bullet editing: the `.charMemory_editBullet` input handler
- Block/bullet deletion: the `.charMemory_deleteBullet` and `.charMemory_deleteBlock` handlers

Since consolidation already uses event delegation on the popup container for editing, the reformat dialog can use the same CSS classes and the same delegation handlers will work automatically — as long as the reformat dialog is shown as a popup with the same class structure.

**Step 2: Commit**

```bash
git add index.js style.css
git commit -m "feat: add reformat preview dialog with side-by-side comparison"
```

---

## Phase 3: Diagnostics Enhancements

Add new health checks that detect common Vector Storage misconfigurations.

### Task 11: Add Retrieve Chunks Health Check

**Files:**
- Modify: `index.js:3268-3393` (inside `computeHealthScore()`)

**Step 1: Research how to access Vector Storage settings**

Before implementing, check whether SillyTavern exposes Vector Storage extension settings to other extensions. Look for:
- `extension_settings.vectors` or similar in the ST global scope
- Any API endpoint that returns VS configuration
- The VS extension's settings object in the DOM

If VS settings are accessible, add a check. If not, skip this task and rely on the documentation/UI guidance approach instead.

**Step 2: Add check for retrieve chunks (if accessible)**

After the `chunk_size` check (line 3355), add:

```javascript
// Check: retrieve_chunks — warn if too high
const retrieveChunks = /* access VS setting */;
if (retrieveChunks !== undefined) {
    if (retrieveChunks > 5) {
        checks.push({
            id: 'retrieve_chunks',
            level: 'yellow',
            label: 'Retrieve chunks is high',
            detail: `Retrieve chunks is set to ${retrieveChunks}. For CharMemory, 2-3 is recommended. Higher values inject more memories per message, which can flood the prompt with irrelevant content.`,
        });
    } else {
        checks.push({
            id: 'retrieve_chunks',
            level: 'green',
            label: `Retrieve chunks: ${retrieveChunks}`,
            detail: 'Retrieve chunks is in the recommended range for CharMemory.',
        });
    }
}
```

**Step 3: Add check for score threshold (if accessible)**

```javascript
// Check: score_threshold — info if not set
const scoreThreshold = /* access VS setting */;
if (scoreThreshold !== undefined && scoreThreshold < 0.1) {
    checks.push({
        id: 'score_threshold',
        level: 'yellow',
        label: 'No score threshold set',
        detail: 'Without a score threshold, low-relevance memories may be injected. Recommended: 0.2-0.3 for most embedding models.',
    });
}
```

**Step 4: Commit (if changes were made)**

```bash
git add index.js
git commit -m "feat: add retrieve chunks and score threshold health checks"
```

### Task 12: Update Existing Chunk Size Check

**Files:**
- Modify: `index.js:3333-3355` (existing `chunk_size` check)

**Step 1: Update the chunk size recommendations**

The current check warns if chunk size is smaller than average block or larger than 4x average block. Update the messaging to include the specific recommendation:

```javascript
detail: `Chunk size (${chunkSize} chars) is smaller than the average memory block (${avgBlockSize} chars). This may split blocks mid-content. Recommended: 800-1000 chars for CharMemory.`,
```

And for too-large chunks:
```javascript
detail: `Chunk size (${chunkSize} chars) is much larger than the average memory block (${avgBlockSize} chars). Multiple blocks may be packed into single chunks, reducing retrieval precision. Recommended: 800-1000 chars for CharMemory.`,
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: improve chunk size health check messaging with specific recommendations"
```

### Task 13: Add Recommended Settings to Diagnostics Panel

**Files:**
- Modify: `settings.html` (diagnostics section)
- Modify: `index.js` (render the recommendation card)

**Step 1: Add a collapsible "Recommended Vector Storage Settings" section**

In the diagnostics panel area of `settings.html`, add an expandable info section:

```html
<div class="charMemory_settingsRecommendation">
    <div class="charMemory_recommendationHeader">
        <i class="fa-solid fa-circle-info"></i> Recommended Vector Storage Settings
    </div>
    <div class="charMemory_recommendationBody" style="display:none;">
        <table class="charMemory_recommendationTable">
            <tr><td>Embedding Model</td><td>text-embedding-3-small or all-MiniLM-L6-v2</td></tr>
            <tr><td>Chunk Size</td><td>800–1000 characters</td></tr>
            <tr><td>Chunk Overlap</td><td>0%</td></tr>
            <tr><td>Retrieve Chunks</td><td>2–3</td></tr>
            <tr><td>Score Threshold</td><td>0.2–0.3 (varies by model)</td></tr>
            <tr><td>Size Threshold</td><td>1 KB</td></tr>
            <tr><td>Query Messages</td><td>2–3</td></tr>
        </table>
    </div>
</div>
```

**Step 2: Add toggle handler and minimal styling**

In `setupListeners()`:
```javascript
$('.charMemory_recommendationHeader').off('click').on('click', function () {
    $(this).next('.charMemory_recommendationBody').slideToggle(200);
});
```

In `style.css`, add minimal styling for the recommendation table.

**Step 3: Commit**

```bash
git add settings.html index.js style.css
git commit -m "feat: add recommended Vector Storage settings card to diagnostics"
```

---

## Phase 4: Version Bump and Cleanup

### Task 14: Update Version and Changelog

**Files:**
- Modify: `manifest.json` (version bump to 1.7.0)
- Modify: `CHANGELOG.md` (add v1.7.0 section)

**Step 1: Bump version in manifest.json**

Change `"version": "1.6.1"` to `"version": "1.7.0"`.

**Step 2: Add changelog entry**

Add a new section at the top of CHANGELOG.md:

```markdown
## 1.7.0

### New Features

- **Retrieval-optimized memory format**: Extraction prompts now produce topic-tagged memory blocks with a `[Names — description]` tag as the first bullet. This improves vector search discrimination, allowing Vector Storage to retrieve only the most relevant memories instead of thematically similar ones.
- **Reformat tool**: New tool in the Tools tab that reformats existing memory files to the new topic-tagged format. Works on any input — unstructured text, old memory blocks, or already-formatted blocks. Includes preview dialog, editing, and one-click undo.
- **Recommended VS settings**: Diagnostics panel now includes a "Recommended Vector Storage Settings" card with optimal chunk size, retrieve chunks, score threshold, and other settings for CharMemory.

### Improvements

- **Tighter memory blocks**: Default bullet limit reduced from 8 to 5 per block (not counting the topic tag). Forces outcome-focused extraction rather than step-by-step narration.
- **Better consolidation labels**: Consolidation now uses encounter-specific labels (e.g., "Adoption day at the apartment") instead of broad categories (e.g., "Key Events"). Topic tags are preserved and updated during consolidation.
- **Improved health checks**: Chunk size recommendations now include specific guidance (800-1000 chars). New checks for retrieve chunks and score threshold (when accessible).
- **Named participants**: Extraction and consolidation prompts now require specific names instead of generic labels like "a client" or "someone".

### Migration

- Existing memories continue to work without changes. Use the new **Reformat** tool to add topic tags to existing memory files for improved retrieval.
- Users with customized extraction prompts are unaffected — only the default prompt is updated. Click "Restore Default" to opt into the new format.
```

**Step 3: Commit**

```bash
git add manifest.json CHANGELOG.md
git commit -m "chore: bump version to 1.7.0, add changelog"
```

### Task 15: Clean Up Proposed Files

**Files:**
- Delete: `docs/proposed-solo-extraction-prompt.txt`
- Delete: `docs/proposed-group-extraction-prompt.txt`
- Delete: `docs/proposed-consolidation-presets.txt`
- Delete: `docs/proposed-reformat-prompt.txt`
- Delete: `docs/proposed-migration-prompt.txt` (if it exists)

**Step 1: Remove proposed files that are now implemented**

```bash
rm docs/proposed-*.txt
```

**Step 2: Commit**

```bash
git add -A docs/proposed-*.txt
git commit -m "chore: remove proposed prompt files (now implemented)"
```

### Task 16: Final Test Run

**Step 1: Run all unit tests**

Run: `npm test`

Expected: All pass.

**Step 2: Run snapshot tests**

Run: `npm run test:snapshot`

Expected: All pass (snapshots were updated in Task 7).

**Step 3: Run sync check**

Run: `npm test -- --grep "sync"`

Expected: Pass — prompt constants are not duplicated in lib.js.

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Prompt changes produce bad extractions | Only affects default prompt; users with custom prompts unaffected. Beta branch testing period before merge to master. |
| Topic tags confuse the LLM during generation | Tags are inside `<memory>` blocks which are already structured data the LLM expects. The `[brackets]` signal metadata, not narrative. |
| 5-bullet limit loses important information | The prompt says "combine related facts into single bullets" not "delete". Test with varied content during beta. |
| Reformat tool destroys memories | Backup + undo mechanism (same pattern as consolidation). Preview dialog before saving. |
| parseMemories() breaks with topic tags | Verified: topic tags parse as regular bullets. No parsing changes needed. |
| Snapshot tests break unexpectedly | Phase 1 updates snapshots intentionally. Phase 2+ adds no snapshot-affecting changes. |
| VS settings not accessible for health checks | Task 11 includes a research step — if settings aren't accessible, we skip the check and rely on the recommendation card (Task 13) instead. |
