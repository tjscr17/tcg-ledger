---
description: Sweep the codebase for dead code, stale comments, and superseded paths. Present findings per file for approval before deleting.
---

# /cleanup

You are about to do a directed cleanup sweep of the `optcg-ledger` codebase.

## Goal

Find and remove deadwood across four categories without breaking anything
that's wired through string keys. Approval is required before any deletion.

## Scope (always all four unless the invocation narrows it)

1. **Unused JS** — imports that aren't referenced, state variables / setters
   with no readers, helpers / utilities never called, branches that can't be
   reached, function parameters that are never used. Includes unused
   `useState`, `useMemo`, `useCallback`, `useRef` whose return values are
   never consumed.
2. **Unused / stale CSS classes** — classes defined in `src/styles.css` that
   are never referenced anywhere in `src/`. Be careful: classes used via
   string interpolation (`` `op-foo ${isActive ? 'is-active' : ''}` ``) or
   dynamic class composition can look unused — confirm by grepping for the
   class name as a substring.
3. **Stale comments** — comments referencing renamed identifiers, fixed
   bugs, removed features, or "TODO" / "HACK" markers that have since been
   resolved. Multi-paragraph docstrings on things that are now trivial.
4. **Superseded code paths** — old implementations still wired in but
   bypassed by newer code. Highest-judgment category. Flag, don't delete
   without explicit user approval per item.

## Procedure

1. **Plan**: state which files you'll sweep and in what order. Default
   order: top of `src/` outward (`App.jsx` first — it's the biggest and the
   most likely to have leftovers), then small files, then `styles.css`,
   then `api/`, `vite.config.js`, root markdown files.

2. **Sweep one file at a time.** For each file:
   - Read the whole file. Don't skim.
   - Grep across the repo for each suspected-unused identifier / class name
     before declaring it dead. Imports especially can be re-exported,
     wired via string keys, or used inside template literals.
   - Build a list of candidates with: file:line, category, what it is, why
     it looks unused, confidence (high / medium / low).
   - Present the list to the user as a per-file batch and wait for
     approval. Do not delete in the same turn as the proposal.

3. **Apply approved deletions** using `Edit`. After deletions, run
   `npm run build` to confirm nothing broke.

4. **Update docs.** Per the `feedback-keep-docs-current` memory:
   - If cleanup reverses or retires a previously-logged Decision, add a
     short row to PLANNING.md's Decisions Log noting what was removed and
     why.
   - If cleanup changes the file layout, surface area, or conventions
     described in CLAUDE.md, update it.
   - Bug-fix-grade cleanup (unused imports, stale comments) doesn't need
     doc updates — only mention it in the end-of-turn summary.

## Hard rules — do NOT delete without explicit per-item approval

- Anything referenced by a string key: localStorage keys (`optcg:*`),
  Supabase column names, table names, CSS class names used in conditional
  expressions or template literals, ENV var names.
- Code labeled with comments like "// keep — used by …" or "// don't remove".
- Exports from `src/storage.js`, `src/catalog.js`, `src/grading.js`,
  `src/psa.js` even if they look unused in `App.jsx`: they may be the
  external surface of those modules.
- Schema SQL comments in `src/storage.js`. These document the live Supabase
  schema and must stay in sync with reality.

## Output shape per file

```
### <file>

| line | category | what | why dead | confidence |
|------|----------|------|----------|------------|
| ...  | unused-js | `const foo = ...` | not referenced anywhere | high |
| ...  | stale-comment | block at line 42 | references removed feature | high |
| ...  | superseded | function `oldFlow` | replaced by `newFlow` line 312 | medium |
```

Then: `Approve all / pick individual items / skip file?`

## Stopping criteria

End the sweep when every source file has been visited once, or when the
user says stop. Do not loop forever.
