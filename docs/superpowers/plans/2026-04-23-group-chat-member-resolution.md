# Group Chat Member Resolution + Destructive Reset Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issues #17 and #18 — stop the destructive auto-reset of `lastExtractedIndex` in group chats when member resolution is incomplete, surface partial-resolution to the user via a health-check row, and auto-retry after 2 seconds to recover from the load-order race that causes most of the failures.

**Architecture:** One new pure helper in `lib.js` (the guard decision, unit-testable). One new `getGroupMembersDetailed()` in `index.js` that reports resolved + unresolved + totalActive without changing the existing `getGroupMembers()` signature (keeps 9+ callers untouched). Three integration points in `index.js`: the stale-metadata reset in `onChatChanged()` gets a guard, `computeHealthScore()` gains an unresolved-members check, and `onChatChanged()` schedules one 2-second retry when partial resolution is detected.

**Tech Stack:** Vanilla JS (ES modules), Vitest, existing SillyTavern globals (`characters`, group records via `getContext()`).

**Spec:** `docs/superpowers/specs/2026-04-23-group-chat-member-resolution-design.md`

---

## File Structure

**Create:**
- `test/unit/memberResolution.test.js` — unit tests for `shouldSkipStaleMetadataReset` (5 cases).

**Modify:**
- `lib.js` — export new pure helper `shouldSkipStaleMetadataReset`.
- `index.js`:
  - Import the new helper from `./lib.js`.
  - Add `getGroupMembersDetailed()` function.
  - Refactor `getGroupMembers()` into a thin wrapper of `getGroupMembersDetailed().resolved`.
  - Guard the stale-metadata reset block inside `onChatChanged()` (around lines 3232–3250).
  - Add unresolved-members health check inside `computeHealthScore()` (around line 3497).
  - Add 2-second retry scheduling inside `onChatChanged()` (near the `updateHealthIndicator()` call around line 3267).
- `CHANGELOG.md` — new bullet in existing `## 2.2.0` → `### Bug Fixes`.

---

## Task 1: Add `shouldSkipStaleMetadataReset` pure helper to `lib.js`

**Files:**
- Test: `test/unit/memberResolution.test.js` (create)
- Modify: `lib.js` (append after existing exports)

- [ ] **Step 1: Write failing tests**

Create `test/unit/memberResolution.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { shouldSkipStaleMetadataReset } from '../../lib.js';

describe('shouldSkipStaleMetadataReset', () => {
    it('returns false for 1:1 chats (always complete)', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: false, unresolvedCount: 0, totalActive: 0 })).toBe(false);
        expect(shouldSkipStaleMetadataReset({ isGroup: false, unresolvedCount: 5, totalActive: 10 })).toBe(false);
    });

    it('returns false for group chats with no unresolved members', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 0, totalActive: 5 })).toBe(false);
    });

    it('returns true for group chats with some unresolved members', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 2, totalActive: 10 })).toBe(true);
    });

    it('returns true for group chats with all members unresolved', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 10, totalActive: 10 })).toBe(true);
    });

    it('returns true defensively for group chats with zero active members', () => {
        expect(shouldSkipStaleMetadataReset({ isGroup: true, unresolvedCount: 0, totalActive: 0 })).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- memberResolution.test.js`
Expected: FAIL with "shouldSkipStaleMetadataReset is not defined".

- [ ] **Step 3: Implement in `lib.js`**

Append to `lib.js`:

```js
/**
 * Decide whether to skip the stale-metadata auto-reset in group chats.
 * Returns true when member resolution is incomplete and we can't trust
 * the "no memories anywhere" conclusion.
 * @param {{isGroup:boolean, unresolvedCount:number, totalActive:number}} state
 * @returns {boolean}
 */
export function shouldSkipStaleMetadataReset({ isGroup, unresolvedCount, totalActive }) {
    if (!isGroup) return false;          // 1:1 chats are always complete
    if (totalActive === 0) return true;  // can't conclude anything from zero members
    return unresolvedCount > 0;          // any unresolved member invalidates the conclusion
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- memberResolution.test.js`
Expected: PASS, 5 tests green.

- [ ] **Step 5: Run full unit suite**

Run: `npm test`
Expected: PASS, 178 tests total (was 173 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add lib.js test/unit/memberResolution.test.js
git commit -m "feat: add shouldSkipStaleMetadataReset pure helper

Decides whether to skip the destructive stale-metadata auto-reset in
group chats when member resolution is incomplete. Pure and unit-tested.
Foundation for fixing issue #17 / #18
(see docs/superpowers/specs/2026-04-23-group-chat-member-resolution-design.md)."
```

---

## Task 2: Add `getGroupMembersDetailed()` and refactor `getGroupMembers()` wrapper

**Files:**
- Modify: `index.js` (replace `getGroupMembers()` around lines 1743–1766)

- [ ] **Step 1: Locate the current `getGroupMembers()` function**

Run: `grep -n "^function getGroupMembers" /Users/davidsayed/repos/sillytavern-character-memory/index.js`
Expected: one line — `function getGroupMembers()` around line 1743.

- [ ] **Step 2: Replace `getGroupMembers` with a detailed version + thin wrapper**

Locate the current function body (verbatim check via `git show HEAD:index.js | sed -n '1743,1766p'`):

```js
function getGroupMembers() {
    const context = getContext();
    if (!context.groupId) return [];
    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group) {
        console.warn(LOG_PREFIX, `Group not found: groupId="${context.groupId}", available groups:`, context.groups?.map(g => g.id));
        return [];
    }
    const activeMembers = group.members
        .filter(avatar => !group.disabled_members?.includes(avatar));
    if (activeMembers.length === 0) {
        console.warn(LOG_PREFIX, `Group "${group.name}" has no active members. members=${group.members?.length}, disabled=${group.disabled_members?.length}, mode=${group.generation_mode}`);
    }
    return activeMembers
        .map(avatar => {
            const charIndex = characters.findIndex(c => c.avatar === avatar);
            const char = characters[charIndex];
            if (!char) {
                console.warn(LOG_PREFIX, `Group member avatar "${avatar}" not found in characters array (${characters.length} characters loaded)`);
            }
            return char ? { name: char.name, avatar, charIndex } : null;
        })
        .filter(Boolean);
}
```

Replace with:

```js
/**
 * Resolve group members and report both the successfully-resolved ones and
 * any avatars that couldn't be found in the global `characters` array (the
 * most common cause is a load-order race: CHAT_CHANGED fires before ST has
 * finished populating characters for large groups).
 *
 * Outside a group chat, returns all-empty defaults.
 *
 * @returns {{
 *   resolved: Array<{name:string, avatar:string, charIndex:number}>,
 *   unresolvedAvatars: string[],
 *   totalActive: number
 * }}
 */
function getGroupMembersDetailed() {
    const context = getContext();
    if (!context.groupId) return { resolved: [], unresolvedAvatars: [], totalActive: 0 };
    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group) {
        console.warn(LOG_PREFIX, `Group not found: groupId="${context.groupId}", available groups:`, context.groups?.map(g => g.id));
        return { resolved: [], unresolvedAvatars: [], totalActive: 0 };
    }
    const activeMembers = group.members
        .filter(avatar => !group.disabled_members?.includes(avatar));
    if (activeMembers.length === 0) {
        console.warn(LOG_PREFIX, `Group "${group.name}" has no active members. members=${group.members?.length}, disabled=${group.disabled_members?.length}, mode=${group.generation_mode}`);
    }
    const resolved = [];
    const unresolvedAvatars = [];
    for (const avatar of activeMembers) {
        const charIndex = characters.findIndex(c => c.avatar === avatar);
        const char = characters[charIndex];
        if (char) {
            resolved.push({ name: char.name, avatar, charIndex });
        } else {
            unresolvedAvatars.push(avatar);
        }
    }
    if (unresolvedAvatars.length > 0) {
        console.warn(LOG_PREFIX, `${unresolvedAvatars.length} of ${activeMembers.length} group members could not be resolved: ${unresolvedAvatars.join(', ')} (characters.length=${characters.length})`);
    }
    return { resolved, unresolvedAvatars, totalActive: activeMembers.length };
}

/**
 * Back-compat entry point used by 9+ callers. Returns only the resolved members.
 * New code that needs visibility into unresolved avatars should call
 * getGroupMembersDetailed() directly.
 */
function getGroupMembers() {
    return getGroupMembersDetailed().resolved;
}
```

- [ ] **Step 3: Verify the refactor preserves the external contract**

Run: `npm test`
Expected: PASS, 178/178 (unchanged — existing tests don't exercise these DOM-dependent functions).

Run: `node --check index.js 2>&1 | head -3`
Expected: no output (syntax OK).

Run: `grep -c "^function getGroupMembers\b\|^function getGroupMembersDetailed\b" index.js`
Expected: **2** (two function definitions).

Run: `grep -c "getGroupMembers(" index.js`
Expected: at least 9 (existing callers still call the wrapper — count unchanged from before this task).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "refactor: add getGroupMembersDetailed + thin getGroupMembers wrapper

New function reports both the resolved members and any avatars that
couldn't be found in the characters array (the common load-order race
on large groups). getGroupMembers() becomes a thin wrapper returning
just the resolved list, so existing callers are unchanged. Groundwork
for the guard/warning/retry fixes in subsequent tasks (#17, #18)."
```

---

## Task 3: Guard the stale-metadata reset in `onChatChanged()`

**Files:**
- Modify: `index.js` (stale-metadata block around lines 3232–3250, plus lib.js import around line 55)

- [ ] **Step 1: Add `shouldSkipStaleMetadataReset` to the lib.js import block**

The `./lib.js` named-import block in `index.js` currently ends around line 55:

```js
    ...
    estimateConsolidationSize,
    packBlocksIntoChunks,
    classifyBlocksForConsolidation,
} from './lib.js';
```

Add `shouldSkipStaleMetadataReset`:

```js
    ...
    estimateConsolidationSize,
    packBlocksIntoChunks,
    classifyBlocksForConsolidation,
    shouldSkipStaleMetadataReset,
} from './lib.js';
```

- [ ] **Step 2: Replace the stale-metadata block in `onChatChanged()`**

Locate this verbatim block inside `onChatChanged()` (around lines 3232–3250):

```js
    if (lastIdx >= 0) {
        try {
            let hasAnyMemories = false;
            const targets = getMemoryTargets();
            for (const target of targets) {
                const content = await readMemoriesForCharacter(target.avatar, target.fileName);
                const blocks = parseMemories(content);
                if (blocks.length > 0) {
                    hasAnyMemories = true;
                    break;
                }
            }
            if (!hasAnyMemories) {
                meta.lastExtractedIndex = -1;
                saveMetadataDebounced();
                logActivity(`Auto-reset lastExtractedIndex: was ${lastIdx} but memory file is empty — stale metadata`, 'warning');
            }
        } catch { /* ignore read errors */ }
    }
```

Replace with:

```js
    if (lastIdx >= 0) {
        try {
            // In group chats, if member resolution is incomplete we can't trust a
            // "no memories anywhere" conclusion — the members we CAN see might
            // legitimately lack memories while the ones we CAN'T see have them.
            // Guard prevents the destructive reset that causes re-extraction from
            // message 0 (issue #17 / #18).
            const detail = isGroupChat()
                ? getGroupMembersDetailed()
                : { resolved: null, unresolvedAvatars: [], totalActive: 0 };
            const skipReset = shouldSkipStaleMetadataReset({
                isGroup: isGroupChat(),
                unresolvedCount: detail.unresolvedAvatars.length,
                totalActive: detail.totalActive,
            });
            if (skipReset) {
                logActivity(`Skipped stale-metadata reset: ${detail.unresolvedAvatars.length} of ${detail.totalActive} group members could not be loaded (likely a load-order race). Pointer preserved at ${lastIdx}.`, 'warning');
            } else {
                let hasAnyMemories = false;
                const targets = getMemoryTargets();
                for (const target of targets) {
                    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
                    const blocks = parseMemories(content);
                    if (blocks.length > 0) {
                        hasAnyMemories = true;
                        break;
                    }
                }
                if (!hasAnyMemories) {
                    meta.lastExtractedIndex = -1;
                    saveMetadataDebounced();
                    logActivity(`Auto-reset lastExtractedIndex: was ${lastIdx} but memory file is empty — stale metadata`, 'warning');
                }
            }
        } catch { /* ignore read errors */ }
    }
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS, 178/178.

Run: `node --check index.js 2>&1 | head -3`
Expected: no output.

Run: `grep -c "shouldSkipStaleMetadataReset" index.js`
Expected: **2** (import + one usage in `onChatChanged`).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "fix(group-chat): guard destructive pointer reset on partial member resolution

When CHAT_CHANGED fires before SillyTavern has finished loading
characters (common on large groups during startup), getGroupMembers()
returns a partial list. The stale-metadata self-heal then iterates that
partial list, concludes 'no memories anywhere,' and resets
lastExtractedIndex = -1 — forcing a full re-extraction from message 0
and producing duplicate memories. Now the reset only runs when member
resolution is complete. Partial-resolution paths log a warning and
preserve the pointer. Addresses issue #17."
```

---

## Task 4: Surface unresolved members via health check

**Files:**
- Modify: `index.js` (`computeHealthScore` around line 3497)

- [ ] **Step 1: Locate the right insertion point**

Search for the end of the conditional profile check and the start of the Vector Storage check — we'll insert the group-resolution check immediately after the conditional profile check and before Check 1 (Vector Storage for files) so it fires early when relevant.

Run: `grep -n "// Check 1:" /Users/davidsayed/repos/sillytavern-character-memory/index.js`
Expected: one match — around line 3533.

The block just above it (lines 3505–3532) ends with a closing `}` for the `if (source === EXTRACTION_SOURCE.PROFILE)` block. That's where our new check goes.

- [ ] **Step 2: Add the group-resolution health check**

Insert the following block immediately after the closing `}` of the `if (source === EXTRACTION_SOURCE.PROFILE) { ... }` block (i.e., between line 3531 and line 3533 of the current file — the blank line and the `// Check 1` comment). Here is the insertion in place, showing enough surrounding context to find the anchor:

**Context before (unchanged):**
```js
        } else {
            checks.push({ id: 'profile_source', level: 'green', label: t`Connection Profile`,
                detail: t`Profile configured and available.` });
        }
    }

    // Check 1: Vector Storage enabled for files
```

**After insertion:**
```js
        } else {
            checks.push({ id: 'profile_source', level: 'green', label: t`Connection Profile`,
                detail: t`Profile configured and available.` });
        }
    }

    // Check 0b (conditional): Group chat member resolution completeness.
    // Surfaces the load-order race / genuinely-missing-card cases so they're
    // not silent (issue #17). The guard in onChatChanged prevents the destructive
    // pointer reset; this check tells the user why some group members might be
    // missing from extraction/consolidation.
    if (isGroupChat()) {
        const detail = getGroupMembersDetailed();
        if (detail.unresolvedAvatars.length > 0) {
            const listed = detail.unresolvedAvatars.slice(0, 5).join(', ');
            const more = detail.unresolvedAvatars.length > 5
                ? t` (+ ${detail.unresolvedAvatars.length - 5} more)`
                : '';
            checks.push({
                id: 'group_unresolved',
                level: 'yellow',
                label: t`Group members: ${detail.unresolvedAvatars.length} of ${detail.totalActive} could not be loaded`,
                detail: t`These avatars couldn't be found in SillyTavern's character list: ${listed}${more}. This often resolves itself within seconds (the extension auto-retries 2s after chat change); check again shortly. If it persists, the character cards may have been renamed or deleted — extraction and consolidation will skip these members.`,
            });
        }
    }

    // Check 1: Vector Storage enabled for files
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS, 178/178.

Run: `node --check index.js 2>&1 | head -3`
Expected: no output.

Run: `grep -c "group_unresolved" index.js`
Expected: **1** (the new check id).

Run: `grep -c "getGroupMembersDetailed" index.js`
Expected: at least 3 (definition from Task 2, plus callers from Task 3 and Task 4).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(group-chat): surface unresolved members via health check

Adds a yellow (warning) health check that fires when isGroupChat() and
any of the active group members couldn't be resolved in SillyTavern's
characters array. Lists up to 5 unresolved avatars in the detail text.
Users see this in the Troubleshooter → Diagnostic Report and via the
health indicator dot color. Addresses issue #17's 'silent partial list'
symptom."
```

---

## Task 5: Add 2-second retry in `onChatChanged()`

**Files:**
- Modify: `index.js` (inside `onChatChanged`, near the `updateHealthIndicator()` call around line 3267)

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "updateHealthIndicator();" /Users/davidsayed/repos/sillytavern-character-memory/index.js | head`
Expected: multiple matches. The one inside `onChatChanged` is around line 3267. Verify by reading a few lines of context.

- [ ] **Step 2: Read the current `onChatChanged()` tail**

Run: `sed -n '3260,3290p' /Users/davidsayed/repos/sillytavern-character-memory/index.js`

The section ends with the `updateHealthIndicator()` call followed by a closing `}` for `onChatChanged`. Confirm via the read before editing.

- [ ] **Step 3: Insert the retry block**

Find the line `updateHealthIndicator();` inside `onChatChanged()` (should be near the end of the function). Immediately after that line, insert:

```js
    // Retry member resolution after 2 seconds to recover from the load-order
    // race on large groups (issue #17 / #18). If the initial resolution was
    // incomplete, re-read and log the outcome; updateHealthIndicator() will
    // clear the yellow warning if the retry succeeded.
    if (isGroupChat()) {
        const initial = getGroupMembersDetailed();
        if (initial.unresolvedAvatars.length > 0) {
            const initialGroupId = getContext().groupId;
            setTimeout(() => {
                // Bail if the user switched to a different chat (1:1 or a different group) —
                // logging retry outcome against the wrong group would misattribute.
                if (!isGroupChat() || getContext().groupId !== initialGroupId) return;
                const retry = getGroupMembersDetailed();
                if (retry.unresolvedAvatars.length < initial.unresolvedAvatars.length) {
                    const recovered = initial.unresolvedAvatars.length - retry.unresolvedAvatars.length;
                    logActivity(`Retry resolved ${recovered} previously-unresolved group members.`);
                } else {
                    logActivity(`Retry did not resolve any additional group members (${retry.unresolvedAvatars.length} still unresolved).`, 'warning');
                }
                updateHealthIndicator();
            }, 2000);
        }
    }
```

(This goes INSIDE `onChatChanged()`, after the existing `updateHealthIndicator();` call, before the function's closing `}`.)

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS, 178/178.

Run: `node --check index.js 2>&1 | head -3`
Expected: no output.

Run: `grep -c "initialGroupId" index.js`
Expected: **2** (declaration + comparison inside setTimeout).

Run: `grep -c "Retry resolved" index.js`
Expected: **1**.

Run: `grep -c "Retry did not resolve" index.js`
Expected: **1**.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(group-chat): auto-retry member resolution 2s after CHAT_CHANGED

When onChatChanged detects partial group-member resolution (likely a
load-order race on large groups during startup), schedule one re-check
2 seconds later. If resolution recovers, log it and refresh the health
indicator (which clears the yellow warning). If not, log that the
unresolved avatars are likely genuinely missing. Captures groupId at
schedule time and bails if the user switched chats, to avoid mis-
attributing retry outcomes in the activity log."
```

---

## Task 6: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find the Bug Fixes section**

Run: `grep -n "^### Bug Fixes" CHANGELOG.md | head -3`
Expected: at least one line — the first match should be under `## 2.2.0`.

Read the existing bug-fix bullets to match their style.

- [ ] **Step 2: Insert a new bullet at the end of the `## 2.2.0` → `### Bug Fixes` list**

Find the last bullet in the `## 2.2.0` → `### Bug Fixes` section (the bullet right before the next `## 2.1.x` heading). Add immediately after it (before the blank line that precedes the next `## 2.1.x` heading):

```markdown
- **Group chats: fixed destructive extraction-pointer reset and silent partial-member lists**: In group chats with many members, `getGroupMembers()` silently dropped any member whose avatar hadn't finished loading into SillyTavern's character array — usually a load-order race during startup. That partial list caused two visible failures: extraction and consolidation only ran for a subset of members, and the stale-metadata self-heal in `onChatChanged` would sometimes conclude "no memories anywhere" and reset `lastExtractedIndex = -1`, forcing a full re-extraction from message 0 (expensive and duplicate-producing on long chats). Three fixes: (1) guard the destructive reset when member resolution is incomplete — the pointer is preserved; (2) new yellow health check *"N of M group members could not be loaded"* with the unresolved avatar list; (3) one automatic retry 2 seconds after each chat change, which clears the warning silently for the common race case. Fixes [#17](https://github.com/bal-spec/sillytavern-character-memory/issues/17) (see [#18](https://github.com/bal-spec/sillytavern-character-memory/issues/18) for root-cause analysis).
```

- [ ] **Step 3: Verify**

Run: `grep -c "Group chats: fixed destructive" CHANGELOG.md`
Expected: **1**.

Run: `grep -c "^## 2.2.0" CHANGELOG.md`
Expected: **1** (no duplicate heading).

Run: `npm test`
Expected: PASS, 178/178.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for group-chat member resolution fix"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ Pure helper `shouldSkipStaleMetadataReset` → Task 1
- ✅ `getGroupMembersDetailed()` + wrapper → Task 2
- ✅ Guard in `onChatChanged` stale-metadata block → Task 3
- ✅ Health check for unresolved members → Task 4
- ✅ 2-second retry with groupId-capture → Task 5
- ✅ CHANGELOG entry → Task 6

**Type consistency:**
- `getGroupMembersDetailed` return shape `{ resolved, unresolvedAvatars, totalActive }` — consistent across Tasks 2, 3, 4, and 5.
- `shouldSkipStaleMetadataReset` parameter names (`isGroup`, `unresolvedCount`, `totalActive`) consistent between the lib.js definition (Task 1) and the index.js call site (Task 3).
- `getContext().groupId` typed as a string throughout; `initialGroupId` capture in Task 5 uses the same API.

**Placeholder scan:** none — every step has complete code and exact commands.

**Out-of-scope reminders (not in this plan):**
- Fix #4 from issue #18 (audit all callers of `getMemoryTargets()`) — deferred to a follow-up spec cycle.
- Async `getGroupMembers` waiting for character-load events — out of scope; the retry covers the common race.
- Persistent "acknowledged unresolvable" marker — YAGNI.
- No live-LLM test — this fix doesn't touch the LLM path.
