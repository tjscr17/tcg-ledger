---
description: Process the directions/ inbox into CLAUDE.md / PLANNING.md, then diff both docs against actual code and propose doc updates for any drift. Approval required before edits.
---

# /sync-docs

You are auditing `CLAUDE.md` and `PLANNING.md` against the current state of
the repo. Two phases: ingest new ideas from the `directions/` inbox, then
detect drift against the code.

## Phase 1 — Directions inbox

The `directions/` folder at the repo root is an inbox for new ideas. Each
`.md` file in there describes something the user wants reflected in the
project docs — could be a new feature direction, a schema change they're
considering, a status update on existing work, a decision they want logged,
a roadmap reorder. Format is free-form prose; the user wrote it for *you*,
not for a parser.

**For each file in `directions/` (alphabetical order, excluding `README.md`):**

1. **Read the file in full.** Understand what the user is conveying. Is it:
   - A new feature direction → update CLAUDE.md views/architecture sections
     and add a status row to PLANNING.md
   - A schema change → update the relevant CLAUDE.md schema section and
     flag that `src/storage.js` SQL comments may also need updating (do
     **not** edit the code; that's a separate task)
   - A status update on existing work → flip PLANNING.md snapshot rows
   - A decision the user wants logged → append a row to the Decisions Log
     with the date from the file (or today's date if not stated)
   - A roadmap reorder → adjust phase ordering in PLANNING.md
   - A resolved discrepancy with `CONVERSATION_CONTEXT.md` → move it out of
     CLAUDE.md's discrepancies table
2. **Propose the doc edits**, presented in the standard per-file table:

   ```
   ### directions/<filename>.md → proposed integrations

   | target | section | proposed edit |
   |--------|---------|---------------|
   | CLAUDE.md | Views | Add row for FairValueView |
   | PLANNING.md | Status snapshot | New row: "Fair value model (Phase 4)" ⬜ |
   | PLANNING.md | Decisions Log | New row dated 2026-05-30 |
   ```

   Then: `Approve all / pick items / skip file?`
3. **Apply approved edits** to CLAUDE.md / PLANNING.md.
4. **Delete the source file** from `directions/` after applying — that's
   the user's stated intent. Use `Bash` `rm`.
5. **If the user skips a file**, leave it in `directions/` untouched.

After all inbox files have been processed (or skipped), continue to Phase 2.

If `directions/` is empty (or only contains `README.md`), skip Phase 1.

## Phase 2 — Drift audit

After (or instead of) the inbox phase, audit the docs against the actual
code for things that have drifted.

### What to check

#### CLAUDE.md

- **Stack / dependencies** — versions and packages in `package.json` match
  the doc's stack table.
- **File layout** — every path the doc mentions exists; every top-level
  source file or directory is mentioned (or deliberately omitted).
- **Schema** — column lists in CLAUDE.md match the SQL comments in
  `src/storage.js` (the source of truth for the live Supabase schema).
- **Env vars** — every `VITE_*` (and any `PSA_TOKEN`-style server vars)
  referenced in the code is documented; the env table doesn't list vars
  that no longer exist in any source file.
- **Conventions** — patterns the doc names (e.g. `useStoredState`, ad-hoc
  alert on insert failure, vault-key partitioning) still exist in the code
  with the same shape.
- **Discrepancies table** — items flagged as MISMATCH vs
  `CONVERSATION_CONTEXT.md` are still mismatched. If one's been resolved
  (e.g. TCGCSV integrated, real auth added), move it out of the table and
  into the relevant section as current-state.

#### PLANNING.md

- **Status snapshot rows** — each `✅ / 🟡 / ⬜ / ❌` reflects reality.
  Look for rows that have changed state since the snapshot:
  - `⬜` items that are now built → `✅` or `🟡`
  - `✅` items that have been removed → `❌`
  - `🟡` items that have either fully landed or been abandoned
- **Phased roadmap** — phase notes ("Current state" bullets under each
  phase) match the code.
- **Decisions Log** — entries reference files/identifiers that still exist.
  If a decision has since been reversed by a later change, flag it (don't
  rewrite history — log the reversal as its own row).
- **Open questions** — resolved questions get crossed off or moved to the
  Decisions Log; unresolved ones stay.

#### Cross-doc

- If a feature lands or is dropped, both files often need updates. Make
  sure the changes stay consistent.

### Drift audit procedure

1. **Read all three docs in full**: `CLAUDE.md`, `PLANNING.md`,
   `CONVERSATION_CONTEXT.md` (the last is the historical anchor; don't
   rewrite it). Plus `README.md` for stack claims that overlap with
   `CLAUDE.md`.

2. **Map concrete claims to verifiers.** For each claim worth checking,
   pick the fastest verification:
   - Schema column claim → grep `src/storage.js` for the column name in
     the SQL comments.
   - File-exists claim → `Glob` or `ls`.
   - Export claim → `Grep` for `export.*<name>` in the source file.
   - Env var claim → `Grep` for `VITE_*` across `src/`, `api/`,
     `vite.config.js`, `.env.example`.
   - Status row claim → look at the user-visible feature: does the modal
     exist? Is the route mounted? Does the helper return something
     non-null?
   - Decision Log entry → check the cited file/identifier still exists.

3. **Skim git log since the docs were last touched** to surface recent
   feature work or removals that haven't been logged. `git log --since`
   the timestamp on the docs and read the commits. New features or
   removals that aren't reflected in PLANNING.md's status snapshot or
   decisions log are drift candidates.

4. **Group findings into three buckets** for the user, with file:line refs:
   - **CLAUDE.md drift** — doc says X, code says Y
   - **PLANNING.md drift** — status rows / phase notes / decisions log
   - **Undocumented additions** — code has new thing not yet referenced
     anywhere in docs

5. **Present batches for approval** like `/cleanup` does — per-section
   table, file:line refs, proposed edit summarized in one sentence.

6. **Apply approved edits** with `Edit`. Don't rewrite whole sections —
   make targeted changes that preserve the existing voice.

7. **Don't touch `CONVERSATION_CONTEXT.md`.** It's a historical artifact;
   it's allowed to diverge from reality. The discrepancies table in
   `CLAUDE.md` is where divergence gets tracked.

## Hard rules

- Never invent decisions. If a Decision Log entry would need a date you
  can't verify from git history or known facts, flag it and ask instead of
  guessing.
- Don't fluff. If a section is correct, don't rewrite it for tone.
- Preserve the BEM-ish `op-*` shape, `✅ / 🟡 / ⬜ / ❌` status conventions,
  and the existing table headers — don't restyle the docs.
- After edits, run `npm run build` only if you also touched code; pure
  doc changes don't need it.
- **Inbox files are only deleted after their edits are applied.** If the
  user skips a file or you fail to apply edits, leave the file in
  `directions/`. Never delete an inbox file without a successful integration.
- **Don't paste inbox files verbatim into CLAUDE.md / PLANNING.md.** They're
  rough prose written for you — your job is to translate them into the
  shape and voice of the target docs (tables, status rows, decision-log
  entries). The original file gets deleted, the integrated version stays.

## Output shape

```
### CLAUDE.md drift

| section | doc says | code says | proposed fix |
|---------|----------|-----------|--------------|
| File layout | references src/foo.js | no such file | drop the line |

### PLANNING.md drift

| row / entry | current | should be | proposed fix |
|-------------|---------|-----------|--------------|
| Status: Watchlist | 🟡 | ✅ (last_seen_url populated by … on YYYY-MM-DD) | flip emoji + add note |

### Undocumented additions

| what | where | propose adding to |
|------|-------|-------------------|
| BulkGradingModal | src/App.jsx:2354 | CLAUDE.md Views table; PLANNING.md status row |
```

Then: `Approve all / pick individual items / skip section?`

## Stopping criteria

Stop when every section of CLAUDE.md and PLANNING.md has been audited
against the code at least once, or when the user says stop. Don't loop.
