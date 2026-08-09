# Glance — auto-triaged session board

One promise: the sidebar tells you what exists; Glance tells you what matters.
Zero management: no folders, no tags, no pinning, no archiving. The board is
derived from live gateway state, never curated.

## Classification (first match wins, evaluated per slot)

Signals come from `GET /api/chat/slots` (slot.to_dict()), `GET /api/autonudge`
(NudgeLoop list), `GET /api/ask-question/pending`, `GET /api/approvals`.

### 0. Hidden
- `slot.app` is set (app-owned worker slots, e.g. auto-research workers) — plumbing,
  not user sessions. Their work surfaces via the Mission section (loops) instead.

### 1. NEEDS YOU — rich attention cards, top of board
Explicit asks only (taste call: `waiting_for_input` alone is too noisy — nearly
every finished session ends on an assistant message):
- **Question**: pending ask_question card → show the actual question text + choice
  buttons inline (payload from /api/ask-question/pending).
- **Approval**: `pending_approval` → show tool + one-line input preview
  (`pending_approval_info`), Approve/Deny inline.
- **Choice**: `has_options` → render `options[]` as buttons + `prompt_preview`.
- **Plan gate**: plan present, not `orchestrating`, options are the Go trailer →
  "Plan awaiting Go — Stage titles…" card.
- **Loop ran out of rope**: bound NudgeLoop with `stopped_reason` in
  {cycle_cap, runtime_budget} → "loop hit its cap without finishing" card.

Card shows: title, agent, what it's asking (verbatim), and **how long it has been
waiting** (from question `ts` / `last_activity_ts`). Sort: longest-waiting first
(most overdue on top).

### 2. WORKING — compact live rows
`running` or `orchestrating` or `stopping`, and no active loop.
Row: pulsing dot · title · last tool/message preview · elapsed · queue badge if
`queue_depth > 0`. Sort: most recent activity first.

### 3. ON A MISSION — goal rows
Slot has an **active** NudgeLoop. Kind derived (from Stage-1 findings):
- `slot_key.startswith("research-")` → research campaign (label from message cid)
- `stop_sentinel_path` under `goal-stop/` → goal loop (goal = message "Goal: …" line)
- else → monitor/babysit (goal = first line of loop message)

Row: 🎯 · title · goal text (one line, truncated) · cycle N/M (or N/∞) ·
last fire time · live pulsing dot if a turn is running right now.
Sort: most recently fired first.

### 4. QUIET — auto-decaying remainder
Everything else. No "done" button — done-ness is inferred by decay:
- **Today** (last activity < 24h): one-line rows (title · relative time).
- **Earlier** (24h–7d): denser one-liners, muted.
- **Older**: collapsed to a single count row ("N older sessions") — expandable,
  never expanded by default.

## Header strip
`2 need you · 3 working · 4 on a mission · 28 quiet` — the whole state of the
world in one line. Tab badge count = NEEDS YOU count only.

## Interactions (all optional — reading is the product)
- Click any row/card → navigate to the session in chat (useNavigate).
- Question/choice cards: answer inline (POST the same endpoints the chat UI uses)
  — answering from the board without opening the session is the killer feature.
- Approvals: Approve/Deny inline via the approvals endpoint.
- No drag, no dismiss, no mark-as-read. State changes only through the real
  underlying signals resolving.

## Polling
One `load()` fanning out to the 3–4 endpoints, every 5s while tab visible
(document.visibilitychange gates it), 30s when hidden. All reads, no writes.

## Non-goals
- No folders/tags/manual grouping (explicit user requirement).
- No persistence of board state — stateless projection of live gateway state.
- No plan-stage persistence work in v1 (gateway gap noted in Stage 1); "plan
  awaiting Go" detection via options trailer covers the visible case.

## Open (pending probe 4)
- Pure-UI app calling existing /api/* endpoints (preferred if app pages carry
  session auth) vs. thin Python backend route aggregating server-side.
- permissions.api allowlist entries required either way.
