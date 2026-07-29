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
