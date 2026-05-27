# directions/

Inbox for new ideas, status updates, and decisions you want reflected in
`CLAUDE.md` / `PLANNING.md`.

## How to use

1. Drop a markdown file in here describing what you want documented. Format
   is free-form prose — write it for the AI agent, not for a parser.
   Examples:
   - "I'm going to build a fair-value model in Phase 4. Use eBay sold data,
     median-trimmed, …"
   - "Watchlist scraper is live as of 2026-06-15, populating last_seen_url
     and last_seen_price via a GitHub Action cron."
   - "Reversed the transfer sign convention — sender is now negative again."
   - "Drop the JP coverage roadmap, not pursuing it."

2. Run `/sync-docs`. The agent will read each file in `directions/`,
   propose how to integrate it into `CLAUDE.md` / `PLANNING.md` (status
   rows, decisions log, schema sections, etc.), and ask you to approve
   per file.

3. Approved files get deleted from `directions/` after the integration
   lands. Skipped files stay so you can iterate on them.

## What belongs here

Anything you'd otherwise have to remember to write up later:
- New feature direction
- Schema change you're planning
- Status update on existing work (e.g. ⬜ → ✅ / 🟡)
- Decision you want logged
- Roadmap reorder
- Resolved discrepancy with `CONVERSATION_CONTEXT.md`

## What doesn't

- Bug fixes that are obvious from a diff — those don't need a directions
  file; the existing `feedback-keep-docs-current` memory handles them.
- The actual implementation. `directions/` is for *what to record about*
  the work, not the work itself.
- Sensitive info / credentials.

## File naming

Anything works. Suggest `YYYY-MM-DD-short-slug.md` so the inbox sorts
chronologically when there's a backlog, but it's not enforced.
