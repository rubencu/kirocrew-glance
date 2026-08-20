// Tests for the Glance v2 pure logic: brief parsing/validation and live
// blocker extraction. Run: node --test tests/
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { toEpoch, rel, parseBrief, extractBlockers, blockerKey, handlerSlotFor, pruneSent, STALE_AFTER, SENT_TTL_SECS } from '../ui/brief.mjs'

const NOW = 1_800_000_000

// ---------- time ----------

test('toEpoch normalizes secs, millis, ISO, and garbage', () => {
  assert.equal(toEpoch(NOW), NOW)
  assert.equal(toEpoch(NOW * 1000), NOW)
  assert.equal(toEpoch(new Date(NOW * 1000).toISOString()), NOW)
  assert.equal(toEpoch(null), 0)
  assert.equal(toEpoch('not a date'), 0)
})

test('rel formats past durations', () => {
  assert.equal(rel(NOW - 45, NOW), '45s')
  assert.equal(rel(NOW - 120, NOW), '2m')
  assert.equal(rel(NOW - 7200, NOW), '2h')
  assert.equal(rel(NOW - 3 * 86400, NOW), '3d')
  assert.equal(rel(NOW + 999, NOW), '0s') // future clamps to 0
})

// ---------- parseBrief ----------

function validBrief(over = {}) {
  return JSON.stringify({
    v: 1,
    generated_at: NOW - 300,
    headline: 'One PR needs your merge; 2 questions waiting.',
    items: [
      { id: 'pr-2431', priority: 'now', text: 'PR #2431 has been review-ready for 9h — only needs your merge.', session: 'pr-babysit', action: { label: 'Merge it', message: 'Merge PR #2431 at https://github.com/x/y/pull/2431 after confirming checks are green.' } },
      { id: 'stall-exit', priority: 'soon', text: 'Exit-gate session looks stalled 40m on a failing test.', session: 'exit-gate' },
      { id: 'done-overnight', priority: 'fyi', text: 'Overnight babysit loop finished: both PRs merged.' },
    ],
    quiet: '11 sessions idle >1d; nothing stalled.',
    ...over,
  })
}

test('parseBrief accepts a valid brief and computes age', () => {
  const b = parseBrief(validBrief(), NOW)
  assert.equal(b.ok, true)
  assert.equal(b.generatedAt, NOW - 300)
  assert.equal(b.ageSecs, 300)
  assert.equal(b.stale, false)
  assert.equal(b.items.length, 3)
  assert.equal(b.items[0].action.label, 'Merge it')
  assert.equal(b.items[1].action, null)
  assert.ok(b.headline.includes('needs your merge'))
  assert.ok(b.quiet.includes('11 sessions'))
})

test('parseBrief rejects garbage, wrong version, missing generated_at', () => {
  assert.equal(parseBrief('not json', NOW).ok, false)
  assert.equal(parseBrief('[1,2]', NOW).ok, false)
  assert.equal(parseBrief(validBrief({ v: 2 }), NOW).ok, false)
  assert.equal(parseBrief(validBrief({ generated_at: undefined }), NOW).ok, false)
})

test('parseBrief marks stale after 3 missed curator runs', () => {
  const b = parseBrief(validBrief({ generated_at: NOW - STALE_AFTER - 1 }), NOW)
  assert.equal(b.ok, true)
  assert.equal(b.stale, true)
})

test('parseBrief drops invalid items, normalizes priority, clamps to 10', () => {
  const items = [
    { text: 'no id or priority' },                       // kept: defaults
    { id: 'x', priority: 'urgent!!', text: 'bad prio' }, // kept: prio → fyi
    { id: 'y', priority: 'now' },                        // dropped: no text
    'not an object',                                     // dropped
    { id: 'z', priority: 'now', text: 'half action', action: { label: 'Go' } }, // action dropped (no message)
    ...Array.from({ length: 12 }, (_, i) => ({ id: 'bulk-' + i, priority: 'fyi', text: 'bulk ' + i })),
  ]
  const b = parseBrief(validBrief({ items }), NOW)
  assert.equal(b.ok, true)
  assert.equal(b.items.length, 10) // clamped
  const noId = b.items.find((i) => i.text === 'no id or priority')
  assert.ok(noId && noId.id.startsWith('item-'))
  assert.equal(noId.priority, 'fyi')
  assert.equal(b.items.find((i) => i.text === 'bad prio').priority, 'fyi')
  assert.equal(b.items.find((i) => i.text === 'half action').action, null)
  assert.ok(!b.items.some((i) => i.id === 'y'))
})

test('parseBrief parses decision choices: trimmed, clamped, session-gated', () => {
  const items = [
    { id: 'dec', priority: 'now', text: 'Pick a strategy.', session: 'chat-9',
      choices: ['  Squash with force-with-lease ', 'Fresh single-commit PR', 'Leave it', '', 42, 'x'.repeat(80), 'fifth', 'sixth'] },
    { id: 'no-sess', priority: 'now', text: 'Choices without a session.', choices: ['A', 'B'] },
    { id: 'no-choices', priority: 'soon', text: 'Plain item.', session: 'chat-3' },
  ]
  const b = parseBrief(validBrief({ items }), NOW)
  assert.equal(b.ok, true)
  const dec = b.items.find((i) => i.id === 'dec')
  // trimmed, empties/non-strings dropped, each clamped to 60, max 4 kept
  assert.deepEqual(dec.choices.slice(0, 3), ['Squash with force-with-lease', 'Fresh single-commit PR', 'Leave it'])
  assert.equal(dec.choices.length, 4)
  assert.equal(dec.choices[3].length, 60)
  // choices are guidance into the item's session — dropped without one
  assert.deepEqual(b.items.find((i) => i.id === 'no-sess').choices, [])
  assert.deepEqual(b.items.find((i) => i.id === 'no-choices').choices, [])
})

test('parseBrief choices tolerate malformed shapes', () => {
  const items = [
    { id: 'obj', priority: 'now', text: 'Object, not array.', session: 's1', choices: { a: 1 } },
    { id: 'null', priority: 'now', text: 'Null choices.', session: 's2', choices: null },
  ]
  const b = parseBrief(validBrief({ items }), NOW)
  assert.equal(b.ok, true)
  assert.deepEqual(b.items.find((i) => i.id === 'obj').choices, [])
  assert.deepEqual(b.items.find((i) => i.id === 'null').choices, [])
})

test('parseBrief orders now → soon → fyi, stable within priority', () => {
  const items = [
    { id: 'f1', priority: 'fyi', text: 'fyi first' },
    { id: 'n1', priority: 'now', text: 'now one' },
    { id: 's1', priority: 'soon', text: 'soon one' },
    { id: 'n2', priority: 'now', text: 'now two' },
  ]
  const b = parseBrief(validBrief({ items }), NOW)
  assert.deepEqual(b.items.map((i) => i.id), ['n1', 'n2', 's1', 'f1'])
})

test('parseBrief empty items renders as all-quiet (ok with zero items)', () => {
  const b = parseBrief(validBrief({ items: [], headline: 'All quiet — nothing needs you.' }), NOW)
  assert.equal(b.ok, true)
  assert.equal(b.items.length, 0)
})

test('handlerSlotFor: stable, sanitized, clamped per-item slots', () => {
  assert.equal(handlerSlotFor('pr-2431-review'), 'glance-h-pr-2431-review')
  assert.equal(handlerSlotFor('pr-2431-review'), handlerSlotFor('pr-2431-review')) // stable
  assert.equal(handlerSlotFor('Weird ID!! with spaces'), 'glance-h-weird-id-with-spaces')
  assert.equal(handlerSlotFor(''), 'glance-h-item')
  assert.equal(handlerSlotFor(null), 'glance-h-item')
  assert.ok(handlerSlotFor('x'.repeat(100)).length <= 'glance-h-'.length + 32)
})

test('pruneSent keeps live+fresh entries, drops resolved/expired/malformed', () => {
  const sent = {
    live: { slot: 'glance-h-live', ts: NOW - 60 },            // kept
    resolved: { slot: 'glance-h-resolved', ts: NOW - 60 },    // dropped: id gone from brief
    expired: { slot: 'glance-h-expired', ts: NOW - SENT_TTL_SECS - 1 }, // dropped: too old
    noSlot: { ts: NOW },                                      // dropped: malformed
    badTs: { slot: 'x', ts: 'yesterday' },                    // dropped: malformed
  }
  const out = pruneSent(sent, ['live', 'expired', 'noSlot', 'badTs'], NOW)
  assert.deepEqual(Object.keys(out), ['live'])
  assert.deepEqual(out.live, { slot: 'glance-h-live', ts: NOW - 60 })
  // garbage input degrades to empty, never throws
  assert.deepEqual(pruneSent(null, ['a'], NOW), {})
  assert.deepEqual(pruneSent('nope', ['a'], NOW), {})
})

test('parseBrief parses pulse counts; clamps garbage; null when absent or malformed', () => {
  const withPulse = parseBrief(validBrief({ pulse: { working: 9, waiting: 2, stalled: 1 } }), NOW)
  assert.deepEqual(withPulse.pulse, { working: 9, waiting: 2, stalled: 1 })
  assert.equal(parseBrief(validBrief(), NOW).pulse, null)
  assert.equal(parseBrief(validBrief({ pulse: [1, 2] }), NOW).pulse, null)
  const garbage = parseBrief(validBrief({ pulse: { working: -3, waiting: 'many', stalled: 4000 } }), NOW)
  assert.deepEqual(garbage.pulse, { working: 0, waiting: 0, stalled: 999 })
})

// ---------- extractBlockers ----------

const slot = (over) => ({
  key: 'k', title: 'T', mode: 'chat', app: '', running: false,
  pending_approval: false, has_options: false, options: [],
  last_activity_ts: NOW - 60, ...over,
})

test('questions group per slot: oldest active, rest queued', () => {
  const out = extractBlockers({
    slots: [slot({ key: 'q1' })],
    questions: [
      { ask_id: 'a2', slot: 'q1', ts: NOW - 100, questions: [{ question: 'second?' }] },
      { ask_id: 'a1', slot: 'q1', ts: NOW - 500, questions: [{ question: 'first?' }] },
    ],
    approvals: [],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'question')
  assert.equal(out[0].asks[0].ask_id, 'a1') // oldest is active
  assert.equal(out[0].asks.length, 2)
  assert.equal(out[0].waitTs, NOW - 500)
  assert.equal(blockerKey(out[0]), 'q-a1')
})

test('slotless questions still surface', () => {
  const out = extractBlockers({ slots: [], questions: [{ ask_id: 'a1', slot: 'ghost', ts: NOW, questions: [] }], approvals: [] })
  assert.equal(out.length, 1)
  assert.equal(out[0].slot, null)
})

test('approvals, choices, and plan gates map from slot state', () => {
  const out = extractBlockers({
    slots: [
      slot({ key: 'ap', pending_approval: true, pending_approval_info: { tool: 'execute_bash', request_id: 'r1' }, last_activity_ts: NOW - 900 }),
      slot({ key: 'ch', has_options: true, options: ['A', 'B'], last_activity_ts: NOW - 300 }),
      slot({ key: 'pl', mode: 'orchestrator', has_options: true, options: ['Go', 'Cancel'], last_activity_ts: NOW - 600 }),
      slot({ key: 'idle' }),
    ],
    questions: [], approvals: [],
  })
  assert.deepEqual(out.map((b) => b.kind), ['approval', 'choice', 'choice'])
  assert.deepEqual(out.map((b) => b.slot.key), ['ap', 'pl', 'ch']) // oldest-first
  assert.equal(out.find((b) => b.slot.key === 'pl').plan, true)
  assert.equal(out.find((b) => b.slot.key === 'ch').plan, false)
})

test('approval wins over options on the same slot', () => {
  const out = extractBlockers({
    slots: [slot({ key: 'both', pending_approval: true, has_options: true, options: ['A'] })],
    questions: [], approvals: [],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'approval')
})

test('app-owned slots are hidden entirely (including their questions)', () => {
  const out = extractBlockers({
    slots: [
      slot({ key: 'worker', app: 'auto-research', pending_approval: true }),
      slot({ key: 'worker2', app: 'glance', has_options: true, options: ['A'] }),
    ],
    questions: [{ ask_id: 'a1', slot: 'worker', ts: NOW, questions: [] }],
    approvals: [],
  })
  assert.equal(out.length, 0)
})

test('background approvals surface with stable keys', () => {
  const out = extractBlockers({
    slots: [], questions: [],
    approvals: [{ id: 'bg1', source: 'cron:log-patrol', tool: 'execute_bash', ts: NOW - 50 }],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'bgApproval')
  assert.equal(blockerKey(out[0]), 'bga-bg1')
})

test('option gates older than 48h are dropped; questions/approvals never age out', () => {
  const out = extractBlockers({
    slots: [
      slot({ key: 'stale-choice', has_options: true, options: ['A'], last_activity_ts: NOW - 3 * 86400 }),
      slot({ key: 'fresh-choice', has_options: true, options: ['B'], last_activity_ts: NOW - 3600 }),
      slot({ key: 'old-approval', pending_approval: true, last_activity_ts: NOW - 5 * 86400 }),
    ],
    questions: [{ ask_id: 'a1', slot: 'nq', ts: NOW - 5 * 86400, questions: [] }],
    approvals: [],
  }, NOW)
  const kinds = out.map((b) => b.kind + ':' + (b.slot ? b.slot.key : b.asks[0].ask_id))
  assert.ok(!kinds.includes('choice:stale-choice'), 'stale option trailer dropped')
  assert.ok(kinds.includes('choice:fresh-choice'))
  assert.ok(kinds.includes('approval:old-approval'), 'approvals never age out')
  assert.ok(kinds.includes('question:a1'), 'questions never age out')
})

test('mixed board sorts longest-waiting first across kinds', () => {
  const out = extractBlockers({
    slots: [slot({ key: 'ap', pending_approval: true, last_activity_ts: NOW - 100 })],
    questions: [{ ask_id: 'a1', slot: 'nq', ts: NOW - 5000, questions: [] }],
    approvals: [{ id: 'bg1', ts: NOW - 10 }],
  })
  assert.deepEqual(out.map((b) => b.kind), ['question', 'approval', 'bgApproval'])
})
