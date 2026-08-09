// Headless render smoke test — renders the FULL component tree (every card and
// row kind) via react-dom/server, no browser needed. Run via tests/run-render-test.sh
// which maps 'react' / '@kirocrew/app-sdk' imports to real/stub modules.
import { strict as assert } from 'node:assert'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GlanceApp, { Board } from './index.test-rewired.mjs'
import { classify } from '../ui/classify.mjs'

const NOW = 1_800_000_000
const DAY = 86400

const fixture = {
  slots: [
    { key: 'q1', title: 'Deploy decision', agent: 'kirocrew', mode: 'chat', app: '', running: false, options: [], has_options: false, pending_approval: false, last_activity_ts: NOW - 900 },
    { key: 'a1', title: 'Refactor session', agent: 'kirocrew', mode: 'chat', app: '', running: true, options: [], has_options: false, pending_approval: true, pending_approval_info: { tool: 'execute_bash', tool_input: 'rm -v build/', request_id: 'r9' }, last_activity_ts: NOW - 1800 },
    { key: 'p1', title: 'Auth migration', agent: 'kirocrew', mode: 'orchestrator', app: '', running: false, has_options: true, options: ['Go', 'Go All', 'Cancel'], pending_approval: false, prompt_preview: 'Plan: migrate auth', last_activity_ts: NOW - 3600 },
    { key: 'c1', title: 'PR #2131 babysit', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: true, options: ['Strip it back', 'Park it'], pending_approval: false, prompt_preview: 'GPT blocked round 5', last_activity_ts: NOW - 7200 },
    { key: 'w1', title: 'Building the fix', agent: 'kirocrew', mode: 'chat', app: '', running: true, has_options: false, options: [], pending_approval: false, last_message: 'running pytest…', queue_depth: 2, last_activity_ts: NOW - 30 },
    { key: 'w2', title: 'Hung migration', agent: 'kirocrew', mode: 'chat', app: '', running: true, has_options: false, options: [], pending_approval: false, last_message: 'applying schema…', queue_depth: 0, last_activity_ts: NOW - 1200 },
    { key: 'w3', title: 'Frozen deploy', agent: 'kirocrew', mode: 'chat', app: '', running: true, has_options: false, options: [], pending_approval: false, last_message: 'waiting on lock…', queue_depth: 0, last_activity_ts: NOW - 2700 },
    { key: 'cap1', title: 'PR #2121 babysit', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW - 3000 },
    { key: 'm1', title: 'PR #2279 watch', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW - 400 },
    { key: 'm2', title: 'Nearly-capped watch', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW - 200 },
    { key: 'quiet1', title: 'Yesterday chat', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW - 2 * 3600 },
    { key: 'quiet2', title: 'Last week thing', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW - 3 * DAY },
    { key: 'old1', title: 'Ancient session', agent: 'kirocrew', mode: 'chat', app: '', running: false, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW - 30 * DAY },
    { key: 'hidden1', title: 'research worker', agent: 'kirocrew', mode: 'chat', app: 'auto-research', running: true, has_options: false, options: [], pending_approval: false, last_activity_ts: NOW },
  ],
  loops: [
    { id: 'lp1', slot_key: 'm1', message: 'Check PR #2279 CI and reviews every cycle', idle_secs: 300, max_cycles: 24, cycle_count: 7, active: true, last_fire_ts: NOW - 400, created_ts: NOW - 9000, stop_sentinel_path: '', max_runtime_secs: 0, stopped_reason: '' },
    { id: 'lp2', slot_key: 'research-cafebabe', message: 'Run the next research cycle for campaign cafebabe', idle_secs: 60, max_cycles: 0, cycle_count: 4, active: true, last_fire_ts: NOW - 100, created_ts: NOW - 5000, stop_sentinel_path: '/x/STOP', max_runtime_secs: 0, stopped_reason: '' },
    { id: 'lp3', slot_key: 'm2', message: 'Watch the deploy until healthy', idle_secs: 300, max_cycles: 24, cycle_count: 22, active: true, last_fire_ts: NOW - 200, created_ts: NOW - 20000, stop_sentinel_path: '', max_runtime_secs: 0, stopped_reason: '' },
    { id: 'lp4', slot_key: 'cap1', message: 'Check PR #2121 for verdicts every cycle', idle_secs: 300, max_cycles: 24, cycle_count: 24, active: false, last_fire_ts: NOW - 3000, created_ts: NOW - 90000, stop_sentinel_path: '', max_runtime_secs: 0, stopped_reason: 'cycle_cap' },
  ],
  questions: [
    { ask_id: 'ask1', slot: 'q1', ts: NOW - 900, questions: [{ question: 'Which AWS account should I deploy to?', options: ['dev', 'prod'] }] },
  ],
  approvals: [
    { id: 'bg1', source: 'cron:log-patrol', tool: 'execute_bash', tool_purpose: 'rotate logs', ts: NOW - 50 },
  ],
}

// --- Full board with every card/row kind ---
const c = classify(fixture, NOW)
assert.equal(c.needsYou.length, 7, 'needsYou: question, approval, plan, choice, bgApproval, stalled, capped')
const html = renderToStaticMarkup(h(Board, {
  c, now: NOW, navigate: () => {}, onAction: () => {}, showOlder: true, setShowOlder: () => {},
  firstSeen: { 'q-ask1': NOW - 10 }, // question just appeared → NEW pill
}))

const mustContain = [
  'Needs you', 'Working', 'On a mission', 'Quiet',
  'Which AWS account should I deploy to?', 'dev', 'prod',            // question card w/ text + options
  'execute_bash', 'Approve', 'Deny',                                  // approval card
  'PLAN GATE', 'Go All',                                              // plan card
  'Strip it back', 'Park it',                                         // choice card
  'cron:log-patrol',                                                  // bg approval card
  'Building the fix', 'running pytest…', '+2',                        // working tile w/ queue pill
  'Hung migration', 'stalled 20m',                                    // stalled working tile
  'STALLED', 'Frozen deploy', 'Stop turn',                            // escalated hung turn card
  'LOOP ENDED', 'Resume loop', 'Check PR #2121',                      // capped loop card w/ resume
  'Check PR #2279 CI and reviews', '7/24',                            // mission tile (monitor)
  '⚠ 22/24', 'in 1m',                                                 // near-cap mission tile w/ next-fire ETA
  '4/∞', 'Research cafebabe',                                         // standalone research loop
  'NEW',                                                              // fresh attention item pill
  'Yesterday chat', 'Last week thing',                                // quiet chips
  '1 older', 'Ancient session',                                       // older chips expanded
]
for (const s of mustContain) {
  assert.ok(html.includes(s), `board HTML missing: ${s}`)
}
assert.ok(!html.includes('research worker'), 'app-owned slot must be hidden')

// --- Empty board: celebration state ---
const cEmpty = classify({ slots: [], loops: [], questions: [], approvals: [] }, NOW)
const emptyHtml = renderToStaticMarkup(h(Board, {
  c: cEmpty, now: NOW, navigate: () => {}, onAction: () => {}, showOlder: false, setShowOlder: () => {},
}))
assert.ok(emptyHtml.includes('Nothing needs you right now'), 'empty celebration')

// --- Root component initial render (loading state, no effects server-side) ---
const rootHtml = renderToStaticMarkup(h(GlanceApp))
assert.ok(rootHtml.includes('Glance') && rootHtml.includes('loading…'), 'root loading state')

console.log('RENDER_TEST_OK — full board, empty board, and root loading state all render')
