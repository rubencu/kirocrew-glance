// Headless render smoke test — renders the FULL v2 component tree (brief items,
// every blocker card kind, empty/first-run states) via react-dom/server.
// Run via tests/run-render-test.sh which maps 'react' / '@kirocrew/app-sdk'
// imports to real/stub modules.
import { strict as assert } from 'node:assert'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GlanceApp, { Board } from './index.test-rewired.mjs'
import { parseBrief, extractBlockers } from '../ui/brief.mjs'

const NOW = 1_800_000_000

const brief = parseBrief(JSON.stringify({
  v: 1,
  generated_at: NOW - 240,
  headline: 'PR #2431 only needs your merge; 1 question waiting.',
  pulse: { working: 9, waiting: 2, stalled: 1 },
  items: [
    { id: 'pr-2431', priority: 'now', text: 'PR #2431 has been review-ready for 9h — only needs your merge.', session: 'pr-babysit', action: { label: 'Merge it', message: 'Merge PR #2431.' } },
    { id: 'stall', priority: 'soon', text: 'Exit-gate session looks stalled 40m on a failing test.', session: 'exit-gate' },
    { id: 'done', priority: 'fyi', text: 'Overnight babysit loop finished: both PRs merged.' },
  ],
  quiet: '11 sessions idle >1d; nothing stalled.',
}), NOW)
assert.equal(brief.ok, true)

const blockers = extractBlockers({
  slots: [
    { key: 'q1', title: 'Deploy decision', mode: 'chat', app: '', pending_approval: false, has_options: false, options: [], last_activity_ts: NOW - 900 },
    { key: 'a1', title: 'Refactor session', mode: 'chat', app: '', pending_approval: true, pending_approval_info: { tool: 'execute_bash', tool_input: 'rm -v build/', request_id: 'r9' }, has_options: false, options: [], last_activity_ts: NOW - 1800 },
    { key: 'p1', title: 'Auth migration', mode: 'orchestrator', app: '', pending_approval: false, has_options: true, options: ['Go', 'Go All', 'Cancel'], prompt_preview: 'Plan: migrate auth', last_activity_ts: NOW - 3600 },
    { key: 'c1', title: 'PR #2131 babysit', mode: 'chat', app: '', pending_approval: false, has_options: true, options: ['Strip it back', 'Park it'], prompt_preview: 'GPT blocked round 5', last_activity_ts: NOW - 7200 },
    { key: 'hidden1', title: 'research worker', mode: 'chat', app: 'auto-research', pending_approval: true, has_options: false, options: [], last_activity_ts: NOW },
  ],
  questions: [
    { ask_id: 'ask1', slot: 'q1', ts: NOW - 900, questions: [{ question: 'Which AWS account should I deploy to?', options: ['dev', 'prod'] }] },
    { ask_id: 'ask2', slot: 'q1', ts: NOW - 800, questions: [{ question: 'Also: which region?', options: ['us-east-1'] }] },
  ],
  approvals: [
    { id: 'bg1', source: 'cron:log-patrol', tool: 'execute_bash', tool_purpose: 'rotate logs', ts: NOW - 50 },
  ],
}, NOW)
assert.equal(blockers.length, 5, 'question, approval, plan, choice, bgApproval')

const noop = () => {}
const html = renderToStaticMarkup(h(Board, {
  brief, blockers, now: NOW, navigate: noop, onAction: noop,
  sent: { done: { slot: 'glance-handler', ts: NOW - 30 } }, onSent: noop, sentFree: false, onSentFree: noop,
  onRefresh: noop, refreshBusy: false,
}))

const mustContain = [
  'Needs you now · 5',
  'Approve all 2',                                        // bulk unblock (slot + bg approval)
  // brief
  'PR #2431 only needs your merge',                       // headline
  '9 working', '2 waiting on you', '1 stalled',           // pulse strip
  'as of 4m ago', '↻ refresh',                            // freshness + refresh
  'review-ready for 9h', 'Merge it',                      // now item + curated action
  'stalled 40m', 'Handle it',                             // soon item + generic delegation
  'guide…',                                               // per-session guidance affordance
  'Overnight babysit loop finished',                      // fyi item
  '✓ sent — open ↗',                                      // sent state (item id 'done')
  '11 sessions idle',                                     // quiet line
  // blocker cards
  'Which AWS account should I deploy to?', 'dev', 'prod', // question card
  '+1 queued', 'custom…',                                 // queued ask + custom reveal
  'QUESTION · 15m',                                       // wait-age in pill
  'execute_bash', 'Approve', 'Deny',                      // approval card
  'PLAN GATE', 'Go All',                                  // plan gate
  'Strip it back', 'Park it',                             // choice card
  'cron:log-patrol',                                      // bg approval card
  'Tell the agent…',                                      // free-text bar
]
for (const s of mustContain) {
  assert.ok(html.includes(s), `board HTML missing: ${s}`)
}
assert.ok(!html.includes('research worker'), 'app-owned slot must be hidden')

// --- Stale brief warns ---
const staleBrief = { ...brief, stale: true }
const staleHtml = renderToStaticMarkup(h(Board, {
  brief: staleBrief, blockers: [], now: NOW, navigate: noop, onAction: noop,
  sent: {}, onSent: noop, sentFree: false, onSentFree: noop, onRefresh: noop, refreshBusy: false,
}))
assert.ok(staleHtml.includes('⚠ stale — written'), 'stale brief warning')

// --- Empty brief: all-quiet state ---
const quietBrief = { ...brief, items: [], headline: 'All quiet — nothing needs you.' }
const quietHtml = renderToStaticMarkup(h(Board, {
  brief: quietBrief, blockers: [], now: NOW, navigate: noop, onAction: noop,
  sent: {}, onSent: noop, sentFree: false, onSentFree: noop, onRefresh: noop, refreshBusy: false,
}))
assert.ok(quietHtml.includes('All quiet'), 'all-quiet state')

// --- No brief at all: first-run state ---
const firstRunHtml = renderToStaticMarkup(h(Board, {
  brief: null, blockers: [], now: NOW, navigate: noop, onAction: noop,
  sent: {}, onSent: noop, sentFree: false, onSentFree: noop, onRefresh: noop, refreshBusy: false,
}))
assert.ok(firstRunHtml.includes('No brief yet'), 'first-run state')
assert.ok(firstRunHtml.includes('Write the first brief'), 'first-run CTA')

// --- Root component initial render (loading state, no effects server-side) ---
const rootHtml = renderToStaticMarkup(h(GlanceApp))
assert.ok(rootHtml.includes('Glance') && rootHtml.includes('loading…'), 'root loading state')

console.log('RENDER_TEST_OK — brief, blockers, stale, all-quiet, first-run, and loading states all render')
