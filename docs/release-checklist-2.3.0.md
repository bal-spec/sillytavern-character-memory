# 2.3.0 pre-promotion manual test checklist

`beta` → `master` promotion. Automated suites cover `lib.js` pure functions only —
everything in `index.js` (providers, all UI, locks, dialogs, group chat) has no automated
coverage, so the items below are the gate.

**Automated, already green:** 193 unit + 6 snapshot. Live tier passes against a hosted
non-reasoning model (see CLAUDE.md § Testing), but note it exercises `lib.js` and
`consolidation.js` only — never `index.js`'s provider layer.

**Version jump:** 2.1.11 → 2.3.0. Users skip 2.2.0 entirely; the single 2.3.0 CHANGELOG
section is the complete upgrade note.

**Rollback:** `git push --force-with-lease origin master-pre-2.3.0:master` (tag points at
`96f528b`, master @ 2.1.11).

---

## 1. batchState migration — highest risk

This is new code written during the merge, not from any PR, and it mutates persisted
settings on first chat load. The pure function is unit-tested; the wrapper is not.

- [ ] Start from a profile that **already has batch progress** (run a batch extraction on
      2.1.11 first if needed, then upgrade)
- [ ] Open any chat. Activity log shows `Migrated N batch-progress record(s) to avatar keys`
- [ ] Run batch extraction on a chat that was already fully batch-processed → it should
      report nothing new, **not** re-extract from message 0
- [ ] Reopen a chat: the migration line does **not** appear again (idempotent)
- [ ] Troubleshooter → Reset Batch Progress still clears records afterwards
- [ ] Two characters with the **same display name**: their batch progress stays independent

## 2. Provider layer (#25) — no automated coverage at all

The response-shape validation now throws where it previously returned `''`. This is the
most likely source of new user reports.

- [ ] Test Connection succeeds on your usual provider
- [ ] A real extraction completes end-to-end
- [ ] Repeat on a second provider of a different shape (one OpenAI-compatible + Anthropic
      if possible — Anthropic uses a separate adapter)
- [ ] Deliberately break the API key → error is clear, not a silent "no new memories"
- [ ] Stop button during a long extraction actually cancels the in-flight request

## 3. Reentrancy locks (#22, #29)

- [ ] Double-click **Extract Now** rapidly → warns, does not run twice
- [ ] Same for **Consolidate** and **Reformat**
- [ ] Open the Setup Wizard from two triggers quickly → only one popup
- [ ] After any of the above, normal operation still works (lock released, not stuck)

## 4. Lost-update guards (#23)

- [ ] Open Memory Manager, leave it open, let an auto-extraction land, then Save →
      prompts before overwriting
- [ ] Cancel at that prompt → existing file untouched
- [ ] Normal save with no concurrent write → **no** spurious prompt

## 5. Group chat (#24)

- [ ] Per-message buttons (Pin, Extract-here, View-injected, Set-last-extracted) appear on
      messages in a **group** chat
- [ ] Convert tool no longer fails with "No character selected"
- [ ] Troubleshooter per-row "Convert file format" targets the correct member
- [ ] Health check reports on all members, not just the first

## 6. Security fix (#26)

- [ ] Set a custom Data Bank filename containing `<img src=x onerror=alert(1)>`
- [ ] Dashboard diagnostics render it as **text**, no script execution, on chat switch and
      after a 60s health poll

## 7. New feature (#27)

- [ ] Map-pin button appears on character messages
- [ ] Clicking shows a confirm with current + target position
- [ ] Accepting moves the pointer; next extraction starts from there
- [ ] Group chat variant notes that members share one pointer

## 8. Drawers / mobile (#29)

- [ ] Open injection drawer → open log drawer → reload page: injection drawer does **not**
      auto-reopen
- [ ] On a touch device, drag the drawer resize handle → drawer resizes and does **not**
      close

---

## Promotion

Once the above passes:

```bash
git tag -a v2.3.0 origin/beta -m "2.3.0"
git push origin v2.3.0
git push origin beta:master          # clean fast-forward, no merge commit
```

## Known deferred

- **#28** (inherit extraction pointer on checkpoint/branch) — held; author flagged it
  UNVERIFIED LIVE. Conflict with #22 already resolved on local branch `pr-28-resolved`.
- **Follow-up nits** — `extractTheme()` doesn't `unescapeAttr()`; `previewConversion()`
  releases its lock by hand rather than `try/finally`; #26 reads `this_chid` in three new
  places despite its own commit 1 arguing against that.
- **Provider layer is untestable** — extracting the adapters out of `index.js` is the only
  way that code ever gets automated coverage.

---

# Results — verified 2026-07-30

All eight sections completed against a live SillyTavern instance.

| Section | Result |
|---|---|
| 1. batchState migration | PASS — one real bug found and fixed (see below) |
| 2. Provider layer (#25) | PASS — all six checks |
| 3. Reentrancy locks (#22, #29) | PASS — including no stuck lock afterwards |
| 4. Lost-update guard (#23) | PASS — 4a; 4b (two-tab concurrent write) not staged |
| 5. Group chat (#24) | PASS — buttons render, member resolution works, no "No character selected" |
| 6. Stored HTML injection (#26) | PASS — verified deterministically against the real render path |
| 7. Set-last-extracted (#27) | PASS |
| 8. Drawers (#29) | PASS |

## Found and fixed during testing

- **One-shot migration flag** (`73000c9`). The migration recorded completion as a
  boolean, so a run that legitimately left records unresolved still marked itself done
  and locked out the improved version. Hit on the first real profile. Now versioned.
- **Ambiguous records left stranded** (`1366a22`). Added chat-ownership disambiguation.
  Verified against a profile with two cards named "Susan" — where it correctly does
  *not* resolve them, because SillyTavern reports overlapping chat lists for same-named
  cards. See `9047ab1`.

## Notable during testing

- Dedicated API measured ~6x faster than the Connection Profile path for the same model
  (3.1s vs 18.7s on a trivial prompt).
- A failed extraction correctly does not advance the extraction pointer.
- Abort cancels the in-flight request immediately rather than waiting for it to finish.

## Known gaps at promotion

- **`generateOpenAICompatibleResponse`'s unexpected-response-shape check is unexercised.**
  It fires on HTTP 200 with no `choices`/`message`, which a real provider won't produce
  on demand. Ships unverified; needs a mock server or the provider-layer refactor.
- **Abort is unavailable for normal Extract Now.** The `AbortController` is only created
  by batch extraction, so a single-chunk extraction cannot be cancelled. Pre-existing.
- **Part of #24 is on a dead path.** `previewConvert()` and the `charMemory_formatSource`
  radios are never called or rendered, so `populateConvertSourceDropdown()`'s group-chat
  fix is unreachable. The live route to conversion is Troubleshooter -> file row.
- **"Convert file format" on an already-CharMemory file** shows a transient toast and no
  dialog, which reads as a broken button.
- **#27 silently no-ops** when the pin is clicked on the message the pointer is already
  on — no dialog, no feedback.
- **`Chat changed: "(none)"`** in group chats instead of naming the group.
