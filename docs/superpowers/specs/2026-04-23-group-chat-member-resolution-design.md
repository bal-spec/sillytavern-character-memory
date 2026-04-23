# Group Chat Member Resolution + Destructive Reset Guard — Design Spec

**Date:** 2026-04-23
**Context:** Fixes GitHub issue [#17](https://github.com/bal-spec/sillytavern-character-memory/issues/17) (user report from Marc-Castillo) per the root-cause analysis in [#18](https://github.com/bal-spec/sillytavern-character-memory/issues/18).

## Problem

In group chats with many members, `getGroupMembers()` in `index.js` silently returns a partial list — any member whose avatar isn't resolvable in SillyTavern's global `characters` array is dropped with only a `console.warn`. This causes two visible failures:

1. Extraction and consolidation only run for the successfully-resolved members. Memory files for the silently-dropped members never get created or updated.
2. The stale-metadata self-heal path in `onChatChanged()` iterates `getMemoryTargets()` (which delegates to `getGroupMembers()`) to decide whether any of this group's characters have memories. If the partial list happens to exclude the members who *do* have memories (common when members were just added), the self-heal concludes "no memories anywhere" and resets `lastExtractedIndex = -1`, forcing a full re-extraction from message 0. On long chats this is expensive (API cost) and produces duplicate memories.

The most likely root cause is a load-order race: on group chats with many members, `CHAT_CHANGED` fires before SillyTavern's async character-loading has populated the full `characters` array. A later re-read resolves fine.

## Goal

Prevent the destructive pointer reset when member resolution is incomplete, surface the partial-resolution state to the user so it's not silent, and auto-recover from the common load-order-race case.

## Non-goals (deferred)

- **Audit all callers of `getMemoryTargets()`** (Fix #4 from issue #18). Extraction, consolidation, reformat, batch, and the Memory Manager all call it. Each may deserve its own "defer on partial result" decision, but that's a broader refactor best done as its own spec cycle.
- **Restructure `getGroupMembers()` to be async and await character loading.** The 2-second retry in this design covers the common case without introducing await cascades through every caller.
- **Backoff / multi-retry**. One 2-second retry is sufficient for the load-order race; genuine resolution failures (character cards that truly don't exist) won't recover regardless of retry count.
- **Persistent per-member "known unresolvable" marker**. Would let users tell the extension to stop warning about specific avatars. YAGNI — the Troubleshooter warning is enough for v1.

## Design

### Shape of the change

Three small fixes that compose around one new concept: **distinguishing "fully resolved" from "partially resolved" group member lists**.

1. **New detailed member-resolution function** — reports both the resolved list and the unresolved avatars, without changing the existing `getGroupMembers()` signature.
2. **Guard the stale-metadata reset** — skip the reset when resolution is incomplete.
3. **Surface via health check** — new warning-level row in the existing health panel.
4. **Delayed retry on `CHAT_CHANGED`** — one 2-second retry clears the common load-order-race case.

All changes live in `index.js`. One new pure helper in `lib.js` for the guard decision (unit-testable).

### Components

**New function in `index.js`: `getGroupMembersDetailed()`**

```js
function getGroupMembersDetailed() {
    // Returns { resolved, unresolvedAvatars, totalActive }
    //   resolved: Array<{name, avatar, charIndex}>  (same shape getGroupMembers returns today)
    //   unresolvedAvatars: string[]                  (avatars in group.members not found in `characters`)
    //   totalActive: number                          (active members = members minus disabled_members)
    //
    // Outside a group chat, returns { resolved: [], unresolvedAvatars: [], totalActive: 0 }.
}
```

`getGroupMembers()` (existing public entry point) becomes a thin wrapper:
```js
function getGroupMembers() {
    return getGroupMembersDetailed().resolved;
}
```

This keeps all 9+ existing callers of `getGroupMembers()` unchanged — zero call-site churn.

**New pure helper in `lib.js`: `shouldSkipStaleMetadataReset`**

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

Pure, unit-testable, lives next to existing `lib.js` utilities.

**Modification: `onChatChanged()` stale-metadata block (around lines 3232–3250)**

Wrap the existing reset logic in a guard that consults `shouldSkipStaleMetadataReset`. When skipping, log an activity-log warning with the counts.

**New health check inside `updateHealthIndicator()` (around line 3782)**

When `isGroupChat() && unresolvedAvatars.length > 0`, emit a `warning`-level check:
- **Label:** `N of M group members could not be loaded`
- **Detail text:** the unresolved avatar filenames plus a note about load-order races and the auto-retry.

Health check is re-computed on each `updateHealthIndicator()` call (existing 60s poll + CHAT_CHANGED trigger + 4s debounced recheck). No new timer.

**Delayed retry in `onChatChanged()` (added near existing `updateHealthIndicator()` call around line 3267)**

```js
if (isGroupChat()) {
    const initial = getGroupMembersDetailed();
    if (initial.unresolvedAvatars.length > 0) {
        const initialGroupId = getContext().groupId;
        setTimeout(() => {
            // Bail if the user switched to a different chat (1:1 or a different group).
            // Logging retry outcome against the wrong group would misattribute which
            // members got resolved.
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

A single 2-second retry. No backoff loop. The `isGroupChat()` + `groupId` re-check handles the case where the user switched chats (or switched to a *different* group) before the timeout fired.

### Data flow

```
CHAT_CHANGED fires
  │
  └─ onChatChanged()
       │
       ├── ensureMetadata()
       │
       ├── Stale-metadata self-heal:
       │     ├── detail = isGroupChat() ? getGroupMembersDetailed() : {resolved:null, unresolvedAvatars:[], totalActive:0}
       │     ├── skip = shouldSkipStaleMetadataReset({
       │     │          isGroup: isGroupChat(),
       │     │          unresolvedCount: detail.unresolvedAvatars.length,
       │     │          totalActive: detail.totalActive })
       │     ├── if (skip):
       │     │     logActivity(warning about skipping reset)
       │     └── else:
       │           existing hasAnyMemories check → reset if empty
       │
       ├── Seed messagesSinceExtraction (unchanged)
       │
       ├── updateHealthIndicator()
       │     └── includes new warning check if isGroupChat() && unresolvedAvatars > 0
       │
       └── Delayed retry (2000 ms) for load-order race:
             if (isGroupChat() && detail.unresolvedAvatars.length > 0):
                 setTimeout(→ recheck + log outcome + updateHealthIndicator(), 2000)
```

### Error handling

- **Non-group chats**: `getGroupMembersDetailed()` returns all-empty defaults; the guard is a no-op; no retry scheduled; no health check emitted.
- **Group with zero active members** (all disabled): guard returns `skip = true` defensively (can't conclude "no memories" from zero members). Edge case, unlikely in practice.
- **User switches chats before retry fires**: the `isGroupChat() && groupId === initialGroupId` re-check inside the setTimeout bails both when the user is in a 1:1 and when they're in a different group. Prevents misattribution in the activity log.
- **`updateHealthIndicator()` recursion**: the retry calls `updateHealthIndicator()`, which is safe — it doesn't itself schedule retries.

### Testing

**Unit tests** (`test/unit/memberResolution.test.js`, new):

`shouldSkipStaleMetadataReset` cases:
- 1:1 chat (`isGroup: false`) with any other fields → `false` (don't skip)
- Group, all resolved (`unresolvedCount: 0`, `totalActive > 0`) → `false`
- Group, some unresolved → `true`
- Group, all unresolved → `true`
- Group, zero active members (`totalActive: 0`) → `true` (defensive)

Expected test count: 5. Full suite post-task: 178 (was 173).

**Not unit-testable (require SillyTavern at runtime):**
- `getGroupMembersDetailed()` — depends on ST's `characters` global and group records.
- Health check surfacing — DOM-dependent.
- Retry timing — depends on ST's `CHAT_CHANGED` lifecycle.

**Manual testing in SillyTavern:**
1. Open a group chat with 8+ members immediately after SillyTavern startup (before all character cards have loaded). Observe:
   - Health indicator briefly yellow.
   - Activity log shows `"Skipped stale-metadata reset"` warning.
   - After ~2 seconds, activity log shows `"Retry resolved N previously-unresolved group members"`.
   - Health indicator clears to green.
2. Open the same group chat after full startup (no race). Observe:
   - Health indicator stays green.
   - No unresolved-members warning.
   - Extraction/consolidation target all members.
3. Create a test group that references a deleted character card (genuine unresolvable). Observe:
   - Health check warning persists after retry.
   - Activity log shows `"Retry did not resolve any additional group members"`.
   - Extraction/consolidation skip the missing member but still run for the others.
4. Long chat with existing memories on all members: switch away and back. Observe:
   - `lastExtractedIndex` is **not** reset destructively even if the race fires.
   - No re-extraction from message 0.

## Rollout

- No schema changes, no migration.
- CHANGELOG entry under `## 2.2.0` → `### Bug Fixes`.
- Release note: *"Group chats: fixed a destructive auto-reset of the extraction pointer when member resolution was incomplete (e.g., on large groups during SillyTavern startup). Partial resolution now surfaces as a yellow health warning; the extension auto-retries after 2 seconds. Fixes [#17](…)."*

## Open questions / deferred decisions

- **Audit other callers of `getMemoryTargets()`** — track as a follow-up. The guard applied here prevents the most damaging path (the destructive reset), but extraction/consolidation/batch that see partial lists still produce partial output. Deserves its own cycle.
- **Deeper retry strategy** — if 2 seconds turns out to be too short for some users' setups, a backoff loop can be added. Telemetry from the activity log will show whether retries are succeeding.
- **Known-unresolvable memoization** — if users have groups that legitimately reference deleted cards, the warning fires every session. A per-avatar "acknowledged unresolvable" flag could suppress it. YAGNI for v1.
