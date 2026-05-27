# Remote Bug-Fix Pipeline — Implementation Spec

A system for capturing bugs from anywhere (phone, friend's house, etc.) and getting them fixed without needing access to your dev machine.

## Goal

Enable this flow:
1. Encounter a bug on the live site while away from your PC.
2. Click "Report bug" on the site itself.
3. Receive a phone notification with a Vercel preview link of a proposed fix.
4. Review on phone, approve PR, auto-deploy to prod.

## Architecture

```
[User on phone]
      ↓
[Site: "Report bug" button] → captures context (URL, console errors, screenshot, description)
      ↓
[Supabase: bug_reports table] → insert row
      ↓
[Supabase Edge Function or DB trigger] → calls GitHub API
      ↓
[GitHub Issue created with `auto-fix` label]
      ↓
[GitHub Actions: claude-code-action] → reads issue, runs Claude Code headless
      ↓
[Branch + PR opened with proposed fix]
      ↓
[Vercel preview deploy] → automatic on PR
      ↓
[Discord/Telegram notification] → sends preview link to phone
      ↓
[User reviews on phone, approves PR]
      ↓
[Merge → Vercel prod deploy]
```

## Phased Build

Each phase is independently useful. Stop at any phase and still have value.

---

### Phase 1 — In-site bug reporter (highest ROI, build first)

**What:** A floating "Report bug" button visible only to authenticated users (you + your friend). Captures bug context and writes to Supabase.

**Why first:** Even with no automation downstream, this alone solves "I forgot what the bug was by the time I got home." Captures the context you'd otherwise lose.

#### Schema

```sql
create table bug_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) not null,
  created_at timestamptz default now() not null,

  -- User-provided
  description text not null,
  severity text check (severity in ('low', 'medium', 'high')) default 'medium',

  -- Auto-captured context
  page_url text,
  user_agent text,
  viewport_width int,
  viewport_height int,
  console_errors jsonb,        -- array of recent console errors
  network_errors jsonb,        -- array of recent failed requests
  screenshot_url text,         -- Supabase Storage URL
  app_state jsonb,             -- optional: redux/zustand snapshot, current route params, etc.

  -- Pipeline status
  status text check (status in ('new', 'queued', 'in_progress', 'pr_opened', 'resolved', 'wont_fix')) default 'new',
  github_issue_number int,
  github_pr_number int,
  resolved_at timestamptz
);

-- RLS: only the reporter and the other authorized user can see their reports
alter table bug_reports enable row level security;

create policy "Authorized users can read all bug reports"
  on bug_reports for select
  using (auth.uid() in (select user_id from authorized_users));

create policy "Authorized users can insert bug reports"
  on bug_reports for insert
  with check (auth.uid() in (select user_id from authorized_users));
```

(Adjust `authorized_users` to whatever you use to gate you + your friend.)

#### Frontend component

A persistent floating button in bottom-right corner, visible only when authenticated. Click opens a modal with:

- Description textarea (required)
- Severity selector (low / medium / high)
- "Include screenshot" checkbox (default on)
- Submit button

On submit, the component:

1. Captures `window.location.href`, `navigator.userAgent`, viewport dimensions.
2. Grabs the last N console errors from a global error buffer (see Console Error Capture below).
3. Grabs the last N failed network requests from a fetch wrapper or interceptor.
4. If screenshot checked, uses `html2canvas` or the browser screenshot API → uploads to Supabase Storage → stores URL.
5. Inserts row into `bug_reports`.
6. Shows a confirmation toast: "Bug reported. You'll get a notification when a fix is proposed."

#### Console Error Capture

Add a small global error buffer at app startup:

```ts
// src/lib/error-buffer.ts
const MAX_ERRORS = 20;
export const errorBuffer: Array<{ timestamp: string; message: string; stack?: string }> = [];

window.addEventListener('error', (e) => {
  errorBuffer.push({
    timestamp: new Date().toISOString(),
    message: e.message,
    stack: e.error?.stack,
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
});

window.addEventListener('unhandledrejection', (e) => {
  errorBuffer.push({
    timestamp: new Date().toISOString(),
    message: `Unhandled rejection: ${e.reason}`,
    stack: e.reason?.stack,
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
});

// Also patch console.error
const originalConsoleError = console.error;
console.error = (...args) => {
  errorBuffer.push({
    timestamp: new Date().toISOString(),
    message: args.map(String).join(' '),
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
  originalConsoleError(...args);
};
```

**Phase 1 exit criteria:** You can submit a bug from any page on the site and see the row in Supabase with full context.

---

### Phase 2 — Supabase → GitHub bridge

**What:** When a `bug_reports` row is inserted, automatically create a GitHub issue with all context formatted nicely.

**Why:** Centralizes bug tracking in GitHub (where the code lives), enables Phase 3's automation, and gives you a consistent place to triage.

#### Supabase Edge Function

Create `supabase/functions/bug-report-to-github/index.ts`:

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN')!;
const GITHUB_REPO = Deno.env.get('GITHUB_REPO')!; // e.g. "youruser/yourrepo"
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  const payload = await req.json();
  const bug = payload.record; // Supabase webhook payload

  const issueBody = `
## Bug Report

**Description:** ${bug.description}

**Severity:** ${bug.severity}

**Reported at:** ${bug.created_at}

**Page:** ${bug.page_url}

**User agent:** ${bug.user_agent}

**Viewport:** ${bug.viewport_width}x${bug.viewport_height}

### Console errors

\`\`\`json
${JSON.stringify(bug.console_errors, null, 2)}
\`\`\`

### Network errors

\`\`\`json
${JSON.stringify(bug.network_errors, null, 2)}
\`\`\`

${bug.screenshot_url ? `### Screenshot\n\n![Screenshot](${bug.screenshot_url})` : ''}

---

_Bug report ID: ${bug.id}_
`.trim();

  const labels = ['bug', 'reported-from-site'];
  if (bug.severity === 'high') labels.push('priority-high');
  // Add auto-fix label for low/medium bugs you want Claude Code to attempt
  if (bug.severity !== 'high') labels.push('auto-fix');

  const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      title: `[Bug] ${bug.description.slice(0, 80)}`,
      body: issueBody,
      labels,
    }),
  });

  const issue = await ghRes.json();

  // Update bug_reports with the issue number
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await supabase
    .from('bug_reports')
    .update({ github_issue_number: issue.number, status: 'queued' })
    .eq('id', bug.id);

  return new Response(JSON.stringify({ ok: true, issue_number: issue.number }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
```

#### Wire up the trigger

In Supabase dashboard:
1. Database → Webhooks → Create webhook
2. Table: `bug_reports`
3. Events: Insert
4. Type: Supabase Edge Functions
5. Function: `bug-report-to-github`

#### Required secrets

In Supabase Edge Function secrets:
- `GITHUB_TOKEN` — a fine-grained PAT with `issues: write` and `contents: write` on the repo
- `GITHUB_REPO` — `youruser/yourrepo`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — for updating the bug row

**Phase 2 exit criteria:** Submitting a bug from the site results in a GitHub issue with all context attached, and the `bug_reports` row gets updated with the issue number.

---

### Phase 3 — Claude Code auto-fix via GitHub Actions

**What:** When an issue gets the `auto-fix` label, GitHub Actions runs Claude Code headless against the repo with the issue as the prompt. Claude Code creates a branch, attempts a fix, opens a PR.

**Why:** This is the core "fix it while I'm away" capability.

#### Workflow file

Create `.github/workflows/auto-fix.yml`:

```yaml
name: Auto-fix labeled issues

on:
  issues:
    types: [labeled]

jobs:
  fix:
    if: github.event.label.name == 'auto-fix'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Claude Code
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            You are working on a fix for the following bug report:

            Issue title: ${{ github.event.issue.title }}

            Issue body:
            ${{ github.event.issue.body }}

            Instructions:
            1. Read CLAUDE.md and PLANNING.md to understand the project.
            2. Investigate the bug. Use the console errors and page URL from the report as starting points.
            3. Make a minimal, focused fix. Do NOT refactor unrelated code.
            4. If the bug is unclear or could have multiple valid fixes, leave a comment on the issue asking for clarification instead of guessing.
            5. If you fix it, ensure existing tests still pass. Add a regression test if practical.
            6. Commit on a new branch named `auto-fix/issue-${{ github.event.issue.number }}`.
            7. Open a PR linking the issue (use "Closes #${{ github.event.issue.number }}" in the PR body).
            8. In the PR description, explain what you changed and why, and list anything you're uncertain about.

      - name: Comment on issue if no PR opened
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: ${{ github.event.issue.number }},
              body: 'Auto-fix attempt failed. See the workflow logs for details. Manual fix needed.'
            });
```

#### Required secrets

In GitHub repo settings → Secrets and variables → Actions:
- `ANTHROPIC_API_KEY` — your Anthropic API key

#### Notes

- The action runs in an ephemeral container. `--dangerously-skip-permissions` is implied because there's no human to confirm — that's fine in this sandbox.
- Vercel will automatically deploy a preview when the PR opens (assuming your Vercel project is set up for PR previews, which is default).
- The PR is NOT auto-merged. You review it on your phone before merging.

**Phase 3 exit criteria:** Adding the `auto-fix` label to an issue (or a bug report being submitted that gets the label automatically from Phase 2) results in a PR with a preview deploy within ~5 minutes.

---

### Phase 4 — Mobile notifications

**What:** Get pinged on your phone with the preview link when a PR is opened.

**Why:** So you don't have to babysit GitHub. You get a notification, tap the preview link, review, approve.

#### Discord webhook (easiest)

Create a Discord server (or use existing), create a channel, create a webhook URL.

Add another job to `.github/workflows/auto-fix.yml` that runs after a PR is opened, OR use a separate workflow triggered on `pull_request` opened.

`.github/workflows/notify-pr.yml`:

```yaml
name: Notify on auto-fix PR

on:
  pull_request:
    types: [opened]

jobs:
  notify:
    if: startsWith(github.event.pull_request.head.ref, 'auto-fix/')
    runs-on: ubuntu-latest
    steps:
      - name: Send Discord notification
        run: |
          curl -X POST -H "Content-Type: application/json" \
            -d '{
              "content": "🤖 New auto-fix PR ready for review",
              "embeds": [{
                "title": "${{ github.event.pull_request.title }}",
                "url": "${{ github.event.pull_request.html_url }}",
                "description": "${{ github.event.pull_request.body }}",
                "fields": [
                  {"name": "Branch", "value": "${{ github.event.pull_request.head.ref }}"},
                  {"name": "Preview", "value": "Vercel preview will appear in the PR checks"}
                ]
              }]
            }' \
            ${{ secrets.DISCORD_WEBHOOK_URL }}
```

#### Telegram alternative

Same idea, use the Telegram Bot API. Slightly more setup (create a bot via @BotFather, get your chat ID) but you get real push notifications without Discord installed.

**Phase 4 exit criteria:** A new auto-fix PR triggers a phone notification with a tappable link to the PR and preview.

---

## Open Decisions

- **Severity routing:** Should `high` severity bugs skip auto-fix (current default) or attempt it anyway? Probably skip until trust is built.
- **Auto-merge for trivial fixes?** Recommended: no, ever. Always human review.
- **Notification channel:** Discord vs Telegram vs email vs Apple/Android push via Pushover or ntfy.sh?
- **Screenshot storage:** Supabase Storage public bucket (simpler, slight privacy concern) vs signed URLs (more secure, GitHub Actions needs auth to fetch).
- **What gets the `auto-fix` label?** All low/medium severity bugs automatically (current spec), or only ones you opt-in label manually?

## Build Order

Suggest tackling in this order:

1. Schema + frontend button + error buffer (Phase 1) — 1 evening
2. Supabase → GitHub bridge (Phase 2) — 1 evening
3. Test with real bugs for a few days, manually fix them, see what context is actually useful — refine Phase 1
4. Add the GitHub Action workflow (Phase 3) — 1 evening
5. Add notifications (Phase 4) — 30 minutes

Don't skip step 3. Running on manual fixes for a week will tell you what context Claude Code actually needs that you're not capturing yet.

## Cost Estimate

- Supabase: free tier handles this; no meaningful additional load
- GitHub Actions: 2000 free minutes/month; each auto-fix run is 1–5 minutes
- Anthropic API: ~$0.10–$1.00 per auto-fix attempt depending on repo size and complexity
- Discord/Telegram: free

Realistic monthly cost for personal use: under $10 unless you're filing dozens of bugs a week.

## Security Notes

- The `GITHUB_TOKEN` used by the Supabase Edge Function should be a fine-grained PAT scoped only to this repo with minimal permissions (`issues: write`, optionally `contents: read` for richer issue formatting).
- The `ANTHROPIC_API_KEY` in GitHub Actions secrets is encrypted at rest and not exposed in logs.
- `--dangerously-skip-permissions` is only safe because it runs in an ephemeral GitHub Actions container, not on your machine. Never use this flag locally.
- The auto-fix action has write access to the repo. Review every PR before merging. Never enable auto-merge for auto-fix PRs.
