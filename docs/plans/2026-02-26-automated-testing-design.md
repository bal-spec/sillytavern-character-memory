# Automated Testing Design

## Goal

Add automated testing for CharMemory's extraction pipeline using a 1000-message test chat fixture. Two tiers: deterministic snapshot tests for the processing pipeline, and live integration tests against a real LLM.

## Current State

- Vitest with 71 passing unit tests in `test/unit/` covering `lib.js` pure functions
- `lib.js` exports pure functions (parsing, serialization, escaping, format detection)
- `package.json` has `test:snapshot` and `test:live` scripts wired up but no test files
- `index.js` has extraction pipeline logic tightly coupled to SillyTavern globals
- 1000-message JSONL test chat at `/Users/davidsayed/repos/st-test-chatlog/output/`

## Design

### Step 1: Extract pure logic from `index.js` into `lib.js`

Three new functions:

**`stripNonDiegetic(text)`** — The 5 regex operations currently inline in `collectRecentMessages()` (lines 2031-2036). Removes code blocks, `<details>` sections, markdown tables, HTML tags, collapses excessive newlines.

**`formatChatMessages(chatArray, startIndex, endIndex)`** — Message filtering and formatting extracted from `collectRecentMessages()`. Takes a plain array of ST message objects, filters out empty/system-only messages, applies `stripNonDiegetic()`, returns formatted text. The caller (`collectRecentMessages` in index.js) handles reading from `getContext()` and passes the array in.

**`substitutePromptTemplate(template, vars)`** — Template variable substitution from `buildExtractionPrompt()`. Replaces `{{charName}}`, `{{charCard}}`, `{{existingMemories}}`, `{{recentMessages}}`, `{{participants}}`. The caller handles reading the template from settings and getting the character card from ST globals.

After extraction, `index.js` calls these lib.js functions. No behavior change.

### Step 2: Snapshot tests (`npm run test:snapshot`)

File: `test/integration/snapshot.test.js`

Test fixture: Copy JSONL into `test/fixtures/flux-chat.jsonl`.

Tests:
1. **stripNonDiegetic** — Feed messages containing code blocks, tables, HTML, `<details>` sections. Snapshot the cleaned output.
2. **formatChatMessages** — Load the JSONL, process chunks (messages 0-20, 20-50). Snapshot the formatted text. Verifies filtering, stripping, and formatting stability.
3. **substitutePromptTemplate** — Build a prompt using processed messages, mock character card, empty existing memories. Snapshot the final prompt. Verifies the prompt the LLM receives is correct.
4. **parseMemories round-trip** — Parse a sample LLM response fixture, re-serialize, verify no data loss.

All deterministic. Run in milliseconds.

### Step 3: Live LLM tests (`npm run test:live`)

File: `test/integration/live.test.js`

Flow: Load JSONL → formatChatMessages → substitutePromptTemplate → call LLM → parseMemories → assert quality.

LLM backend configured via env var: `TEST_LLM_URL` (default: `http://127.0.0.1:1234/v1`). Works with LM Studio, Ollama, KoboldCpp, llama.cpp.

Assertions (structural, not exact content):
- Response contains at least 1 `<memory>` block
- Each block has `chat` and `date` attributes
- Each block has at least 1 bullet
- No character card trait leakage (bullets don't parrot the character description)
- Total bullet count is reasonable for the input size

### File structure

```
test/
  fixtures/
    flux-chat.jsonl
  unit/                      (existing, unchanged)
    parsing.test.js
    escaping.test.js
    format-detection.test.js
    utils.test.js
  integration/
    snapshot.test.js
    live.test.js
```

### Changes to existing files

- `lib.js` — Add 3 exported functions
- `index.js` — Replace inline logic with lib.js calls (refactor, no behavior change)
- `package.json` — No changes needed (scripts already defined)
