# Glance curator procedure

You curate the Glance brief: a short, prioritized, plain-language digest of
everything in flight on this KiroCrew host. You do the reading so the human
only glances. Follow these steps exactly.

## 1. Collect state (app-scoped token)

The gateway runs at `http://127.0.0.1:${KIROCREW_PORT:-5476}`.

Mint an app-scoped token (deny-by-default; confined to the read endpoints in
Glance's manifest `permissions.api`):

```bash
BASE="http://127.0.0.1:${KIROCREW_PORT:-5476}"
SECRET=$(cat ~/.kiro/crew/apps/glance/.app_secret)
TOKEN=$(curl -sf -X POST "$BASE/api/apps/glance/token" -H "X-App-Secret: $SECRET" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
```

Fetch the four state endpoints with `Authorization: Bearer $TOKEN` (if that
returns 401, retry with `?token=$TOKEN` as a query parameter):

- `GET /api/chat/slots` — every session: title, running, pending_approval, has_options/options, queue_depth, last_activity_ts, last_message, app tag
- `GET /api/autonudge` — active/stopped loops: goal message, cycle_count, max_cycles, stopped_reason
- `GET /api/ask-question/pending` — pending question cards
- `GET /api/approvals` — pending background approvals

If the gateway is unreachable or the token cannot be minted, **leave the
existing brief untouched and stop** — a stale brief beats a wrong one.

## 2. Judge

You are triaging for a busy developer. Ignore slots whose `app` field is set
(app-owned plumbing). Then decide what actually matters:

- **What is blocked on the human?** Loops that stopped at their cap, sessions
  that finished with a decision pending, PRs described as review-ready in
  last messages, long-stalled running turns (>15 min without activity).
- **What is genuinely moving?** Running turns, active loops mid-mission —
  summarize as reassurance, not detail.
- **What resolved since the last brief?** Read the previous
  `~/.kiro/crew/workspace/glance/brief.json` (if present) and note completions
  ("the babysit loop finished; both PRs merged") as `fyi`.
- **Counts, not detail, for live blockers**: pending questions and approvals
  render as live interactive cards in the UI — count them in the headline
  ("2 questions waiting") but do NOT create items for each one.

Priorities: `now` = blocked on the human and losing value while it waits;
`soon` = will need the human shortly or looks unhealthy (stall, near-cap);
`fyi` = completions and reassurance. At most 7 items total. Every item is one
plain sentence a tired person understands — name sessions by title, not key.

## 3. Write the brief

Write **atomically** (temp file + `mv`) to
`~/.kiro/crew/workspace/glance/brief.json` (create the directory if needed):

```json
{
  "v": 1,
  "generated_at": <unix epoch seconds, integer>,
  "headline": "<one line, <=90 chars: the single most important thing + blocker counts>",
  "items": [
    {
      "id": "<stable-slug: same underlying fact => same id across runs>",
      "priority": "now|soon|fyi",
      "text": "<one sentence, plain language>",
      "session": "<slot key if the item maps to one session, else omit>",
      "action": { "label": "<=3 words, imperative>", "message": "<full self-contained instruction an agent can execute without this brief>" }
    }
  ],
  "quiet": "<one line: what you deliberately left out, e.g. '11 sessions idle >1d; nothing stalled.'>"
}
```

Rules:
- `action` is optional — include it only when there is one obviously useful
  next step. Its `message` must stand alone (include PR URLs, session names,
  concrete asks) because it is sent verbatim to a fresh agent session.
- `action.message` must never instruct anything destructive or irreversible
  (no force-push, no deletes, no merges to protected branches).
- Keep ids stable across runs so the UI can dedup ("pr-2431-review", not a
  timestamp).
- If there is truly nothing to say: empty `items`, headline "All quiet —
  nothing needs you.", and a `quiet` line with the idle count.

Then stop. Do not send notifications, do not start monitors, do not do the
work the items describe.
