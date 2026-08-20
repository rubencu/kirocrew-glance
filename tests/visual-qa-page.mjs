// One-off visual QA: render the Board with realistic v2.3 props into a
// dark-themed static page for screenshotting. Not part of the test suite.
import { writeFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Board } from './index.test-rewired.mjs'
import { parseBrief, extractBlockers } from '../ui/brief.mjs'

const NOW = Math.floor(Date.now() / 1000)

const brief = parseBrief(JSON.stringify({
  v: 1,
  generated_at: NOW - 240,
  headline: '11 review-ready PRs wait on your merge; one test run silent 1.6h.',
  pulse: { working: 9, waiting: 4, stalled: 1 },
  items: [
    { id: 'campaign-merge', priority: 'now', text: "The memory-protection campaign's 5 PRs are review-ready and blocked on your merge alone.", session: 'chat-37', since: NOW - 32400, action: { label: 'Summarize them', message: 'Summarize the campaign PRs.' } },
    { id: 'decide-history', priority: 'now', text: 'Conflicted PR #4487 waits on your history-strategy pick — its monitor may not rewrite history, so only your call ends the wait.', session: 'chat-89', since: NOW - 90000, choices: ['Squash with force-with-lease', 'Fresh single-commit PR', 'Leave it'] },
    { id: 'pr-backlog', priority: 'now', text: 'Six more PRs from other workstreams are also review-ready awaiting your merge.', action: { label: 'List them', message: 'List the review-ready PRs.' } },
    { id: 'test-stall', priority: 'soon', text: "'Skills Approved But Notifications Persist' has been silent ~1.6 hours on the full test suite.", session: 'chat-55', since: NOW - 5760 },
  ],
  quiet: 'Left out: 3 healthy babysit loops, ~40 idle sessions, day-old option trailers; 0 approvals.',
}), NOW)

const blockers = extractBlockers({
  slots: [
    { key: 'q1', title: 'Deploy decision', mode: 'chat', app: '', pending_approval: false, has_options: false, options: [], last_activity_ts: NOW - 900 },
    { key: 'a1', title: 'Refactor session', mode: 'chat', app: '', pending_approval: true, pending_approval_info: { tool: 'execute_bash', tool_input: 'npm run build', request_id: 'r9' }, has_options: false, options: [], last_activity_ts: NOW - 1800 },
    { key: 'c1', title: 'PR babysit', mode: 'chat', app: '', pending_approval: false, has_options: true, options: ['Strip it back', 'Park it'], prompt_preview: 'GPT blocked round 5', last_activity_ts: NOW - 7200 },
  ],
  questions: [
    { ask_id: 'ask1', slot: 'q1', ts: NOW - 900, questions: [{ question: 'Which AWS account should I deploy to?', options: ['dev', 'prod'] }] },
  ],
  approvals: [
    { id: 'bg1', source: 'cron:log-patrol', tool: 'execute_bash', tool_purpose: 'rotate logs', ts: NOW - 50 },
  ],
}, NOW)

const noop = () => {}
const body = renderToStaticMarkup(h(Board, {
  brief, blockers, now: NOW, navigate: noop, onAction: noop,
  sent: { 'pr-backlog': { slot: 'glance-h-pr-backlog', ts: NOW - 30 } }, onSent: noop,
  sentFree: false, onSentFree: noop, onRefresh: noop, refreshBusy: false,
}))

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg: #16161e; --card: #1d1d28; --text: #e4e4ef; --muted: #8a8a9a;
          --border: #33334a; --accent: #7c3aed; --accent-fg: #fff;
          --danger: #f87171; --ok: #34d399; }
  body { background: var(--bg); color: var(--text); margin: 0;
         font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
</style></head><body><div style="padding:14px 18px;max-width:980px;margin:0 auto">${body}</div></body></html>`

writeFileSync('/tmp/glance-v23-qa.html', page)
console.log('WROTE /tmp/glance-v23-qa.html')
