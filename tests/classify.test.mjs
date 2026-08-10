// Unit tests for the Glance classifier. Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, toEpoch, rel, loopKind, loopGoal, planOptions, loopNearCap, loopNextFire, itemKey, DAY, STALL_SECS, STALL_ESCALATE_SECS } from '../ui/classify.mjs'

const NOW = 1_800_000_000

function slot(over = {}) {
  return {
    key: 'chat-1', title: 'A session', agent: 'kirocrew', mode: 'chat', app: '',
    running: false, orchestrating: false, stopping: false, queue_depth: 0,
    pending_approval: false, pending_approval_info: null,
    has_options: false, options: [], last_activity_ts: NOW - 60, created: NOW - 3600,
    ...over,
  }
}

function loop(over = {}) {
  return {
    id: 'aabbccdd', slot_key: 'chat-1', message: 'Check PR #1 every cycle',
    idle_secs: 300, max_cycles: 24, cycle_count: 3, active: true,
    last_fire_ts: NOW - 120, created_ts: NOW - 7200, stop_sentinel_path: '',
    max_runtime_secs: 0, stopped_reason: '',
    ...over,
  }
}

const empty = { slots: [], loops: [], questions: [], approvals: [] }

// ---------- helpers ----------

test('toEpoch handles seconds, millis, ISO, junk', () => {
  assert.equal(toEpoch(NOW), NOW)
  assert.equal(toEpoch(NOW * 1000), NOW)
  assert.equal(toEpoch('2027-01-15T08:00:00Z'), Date.parse('2027-01-15T08:00:00Z') / 1000)
  assert.equal(toEpoch(null), 0)
  assert.equal(toEpoch('garbage'), 0)
})

test('rel formats durations', () => {
  assert.equal(rel(NOW - 5, NOW), 'now')
  assert.equal(rel(NOW - 300, NOW), '5m')
  assert.equal(rel(NOW - 7200, NOW), '2h')
  assert.equal(rel(NOW - 3 * DAY, NOW), '3d')
  assert.equal(rel(0, NOW), '')
})

test('loopKind: research / goal / monitor', () => {
  assert.equal(loopKind(loop({ slot_key: 'research-abc123' })), 'research')
  assert.equal(loopKind(loop({ stop_sentinel_path: '/x/goal-stop/y.stop' })), 'goal')
  assert.equal(loopKind(loop()), 'monitor')
})

test('loopGoal: Goal-line extraction and first-line fallback', () => {
  assert.equal(loopGoal(loop({ message: 'Goal: ship the fix\nthen stop' })), 'ship the fix')
  assert.equal(loopGoal(loop({ message: 'Check PR #99\nmore detail' })), 'Check PR #99')
})

test('planOptions: orchestrator Go trailer only', () => {
  assert.ok(planOptions(slot({ mode: 'orchestrator', has_options: true, options: ['Go', 'Go All', 'Cancel'] })))
  assert.ok(!planOptions(slot({ mode: 'chat', has_options: true, options: ['Go', 'Go All', 'Cancel'] })))
  assert.ok(!planOptions(slot({ mode: 'orchestrator', has_options: true, options: ['Merge it', 'Park it'] })))
})

// ---------- per-slot classification ----------

test('app-owned slots are hidden', () => {
  const c = classify({ ...empty, slots: [slot({ app: 'auto-research' })] }, NOW)
  for (const k of Object.keys(c)) assert.equal(c[k].length, 0, k)
})

test('pending question wins over everything, keeps text', () => {
  const s = slot({ running: true, pending_approval: true })
  const q = { ask_id: 'q1', slot: 'chat-1', ts: NOW - 900, questions: [{ question: 'Which account?', options: ['dev', 'prod'] }] }
  const c = classify({ ...empty, slots: [s], questions: [q] }, NOW)
  assert.equal(c.needsYou.length, 1)
  assert.equal(c.needsYou[0].kind, 'question')
  assert.equal(c.needsYou[0].asks[0].questions[0].question, 'Which account?')
  assert.equal(c.working.length, 0)
})

test('pending approval → approval card with info', () => {
  const s = slot({ pending_approval: true, pending_approval_info: { tool: 'execute_bash', request_id: 'r1' } })
  const c = classify({ ...empty, slots: [s] }, NOW)
  assert.equal(c.needsYou[0].kind, 'approval')
  assert.equal(c.needsYou[0].info.request_id, 'r1')
})

test('orchestrator Go options → plan; plain options → choice', () => {
  const plan = slot({ key: 'p', mode: 'orchestrator', has_options: true, options: ['Go', 'Go All', 'Cancel'] })
  const choice = slot({ key: 'c', has_options: true, options: ['Merge it now', 'Park it'] })
  const c = classify({ ...empty, slots: [plan, choice] }, NOW)
  assert.deepEqual(c.needsYou.map((i) => i.kind).sort(), ['choice', 'plan'])
})

test('capped loop (recent) → needsYou; stale capped loop decays to quiet', () => {
  const recent = loop({ active: false, stopped_reason: 'cycle_cap', last_fire_ts: NOW - 3600 })
  const c1 = classify({ ...empty, slots: [slot()], loops: [recent] }, NOW)
  assert.equal(c1.needsYou[0].kind, 'capped')

  const stale = loop({ active: false, stopped_reason: 'cycle_cap', last_fire_ts: NOW - 3 * DAY })
  const c2 = classify({ ...empty, slots: [slot()], loops: [stale] }, NOW)
  assert.equal(c2.needsYou.length, 0)
  assert.equal(c2.quietToday.length, 1)
})

test('manually-stopped loop is not an attention card', () => {
  const c = classify({ ...empty, slots: [slot()], loops: [loop({ active: false, stopped_reason: 'manual', last_fire_ts: NOW - 60 })] }, NOW)
  assert.equal(c.needsYou.length, 0)
})

test('active loop → mission even while a turn is running', () => {
  const c = classify({ ...empty, slots: [slot({ running: true })], loops: [loop()] }, NOW)
  assert.equal(c.mission.length, 1)
  assert.equal(c.working.length, 0)
})

test('running / orchestrating / stopping without loop → working', () => {
  const c = classify({
    ...empty,
    slots: [slot({ key: 'a', running: true }), slot({ key: 'b', orchestrating: true }), slot({ key: 'c', stopping: true })],
  }, NOW)
  assert.equal(c.working.length, 3)
})

test('quiet decay buckets: today / earlier / older', () => {
  const c = classify({
    ...empty,
    slots: [
      slot({ key: 'a', last_activity_ts: NOW - 3600 }),
      slot({ key: 'b', last_activity_ts: NOW - 2 * DAY }),
      slot({ key: 'c', last_activity_ts: NOW - 30 * DAY }),
    ],
  }, NOW)
  assert.deepEqual([c.quietToday.length, c.quietEarlier.length, c.older.length], [1, 1, 1])
})

// ---------- standalone signals ----------

test('unmatched active research loop → standalone mission row', () => {
  const c = classify({ ...empty, loops: [loop({ slot_key: 'research-deadbeef' })] }, NOW)
  assert.equal(c.mission.length, 1)
  assert.equal(c.mission[0].slot, null)
  assert.equal(loopKind(c.mission[0].loop), 'research')
})

test('background approvals → needsYou', () => {
  const c = classify({ ...empty, approvals: [{ id: 'x', source: 'cron:patrol', tool: 'execute_bash', ts: NOW - 30 }] }, NOW)
  assert.equal(c.needsYou[0].kind, 'bgApproval')
})

// ---------- ordering ----------

test('needsYou sorted longest-waiting first', () => {
  const s1 = slot({ key: 'newer', pending_approval: true, last_activity_ts: NOW - 60 })
  const s2 = slot({ key: 'older', pending_approval: true, last_activity_ts: NOW - 9000 })
  const c = classify({ ...empty, slots: [s1, s2] }, NOW)
  assert.deepEqual(c.needsYou.map((i) => i.slot.key), ['older', 'newer'])
})

test('working sorted most-recent first', () => {
  const c = classify({
    ...empty,
    slots: [slot({ key: 'stale', running: true, last_activity_ts: NOW - 900 }), slot({ key: 'fresh', running: true, last_activity_ts: NOW - 10 })],
  }, NOW)
  assert.deepEqual(c.working.map((i) => i.slot.key), ['fresh', 'stale'])
})

// ---------- v1.2: proactive signals ----------

test('stall detection: running with no activity past STALL_SECS → stalled', () => {
  const c = classify({
    ...empty,
    slots: [
      slot({ key: 'live', running: true, last_activity_ts: NOW - 30 }),
      slot({ key: 'stuck', running: true, last_activity_ts: NOW - STALL_SECS - 60 }),
      slot({ key: 'stopping', stopping: true, last_activity_ts: NOW - STALL_SECS - 60 }),
    ],
  }, NOW)
  const byKey = Object.fromEntries(c.working.map((i) => [i.slot.key, i.stalled]))
  assert.equal(byKey.live, false)
  assert.equal(byKey.stuck, true)
  assert.equal(byKey.stopping, false, 'stopping is expected to be slow — never flagged')
})

test('loopNearCap: cycle cap at 80%, runtime budget at 80%, inactive never', () => {
  assert.ok(loopNearCap(loop({ cycle_count: 20, max_cycles: 24 }), NOW))
  assert.ok(!loopNearCap(loop({ cycle_count: 10, max_cycles: 24 }), NOW))
  assert.ok(!loopNearCap(loop({ cycle_count: 100, max_cycles: 0 }), NOW), 'uncapped loop never warns')
  assert.ok(loopNearCap(loop({ max_cycles: 0, max_runtime_secs: 1000, created_ts: NOW - 900 }), NOW))
  assert.ok(!loopNearCap(loop({ max_cycles: 0, max_runtime_secs: 1000, created_ts: NOW - 100 }), NOW))
  assert.ok(!loopNearCap(loop({ active: false, cycle_count: 24, max_cycles: 24 }), NOW))
})

test('classify stamps nearCap on bound and standalone mission rows', () => {
  const bound = loop({ slot_key: 'chat-1', cycle_count: 23, max_cycles: 24 })
  const standalone = loop({ id: 'lp2', slot_key: 'research-feed', cycle_count: 1, max_cycles: 24 })
  const c = classify({ ...empty, slots: [slot()], loops: [bound, standalone] }, NOW)
  const byId = Object.fromEntries(c.mission.map((i) => [i.loop.id, i.nearCap]))
  assert.equal(byId['aabbccdd'], true)
  assert.equal(byId['lp2'], false)
})

test('itemKey: stable identity per attention item kind', () => {
  assert.equal(itemKey({ kind: 'question', slot: slot(), asks: [{ ask_id: 'a9' }] }), 'q-a9')
  assert.equal(itemKey({ kind: 'approval', slot: slot({ key: 's7' }) }), 'approval-s7')
  assert.equal(itemKey({ kind: 'bgApproval', appr: { id: 'bg3' } }), 'bg-bg3')
  assert.equal(itemKey({ kind: 'choice', slot: slot({ key: 's7' }) }), 'choice-s7')
  assert.equal(itemKey({ kind: 'stalled', slot: slot({ key: 's7' }) }), 'stalled-s7')
})

// ---------- v1.3: act from the board ----------

test('stall escalation: hung past STALL_ESCALATE_SECS → needsYou stalled card', () => {
  const c = classify({
    ...empty,
    slots: [slot({ key: 'hung', running: true, last_activity_ts: NOW - STALL_ESCALATE_SECS - 60 })],
  }, NOW)
  assert.equal(c.needsYou.length, 1)
  assert.equal(c.needsYou[0].kind, 'stalled')
  assert.equal(c.working.length, 0)
})

test('stall escalation beats mission for a hung loop-bound turn', () => {
  const c = classify({
    ...empty,
    slots: [slot({ running: true, last_activity_ts: NOW - STALL_ESCALATE_SECS - 60 })],
    loops: [loop()],
  }, NOW)
  assert.equal(c.needsYou[0].kind, 'stalled')
  assert.equal(c.mission.length, 0)
})

test('stall escalation guards: stopping exempt, missing timestamps exempt, 10–30 min stays working', () => {
  const c = classify({
    ...empty,
    slots: [
      slot({ key: 'stopping', stopping: true, running: true, last_activity_ts: NOW - 2 * STALL_ESCALATE_SECS }),
      slot({ key: 'no-ts', running: true, last_activity_ts: null, created: null }),
      slot({ key: 'mid', running: true, last_activity_ts: NOW - STALL_SECS - 60 }),
    ],
  }, NOW)
  assert.equal(c.needsYou.length, 0)
  assert.equal(c.working.length, 3)
  assert.equal(c.working.find((w) => w.slot.key === 'mid').stalled, true)
})

test('loopNextFire: last fire + idle gap, created fallback, 0 when unknowable', () => {
  assert.equal(loopNextFire(loop({ last_fire_ts: NOW - 100, idle_secs: 300 })), NOW + 200)
  assert.equal(loopNextFire(loop({ last_fire_ts: null, created_ts: NOW - 50, idle_secs: 60 })), NOW + 10)
  assert.equal(loopNextFire(loop({ last_fire_ts: null, created_ts: null })), 0)
  assert.equal(loopNextFire(loop({ idle_secs: 0 })), 0)
})

// ---------- v1.4 interaction helpers ----------

import { filterClassified, flattenBoard, boardKey, sectionMap, sectionDeltas } from '../ui/classify.mjs'

function busyBoard() {
  return classify({
    slots: [
      slot({ key: 'q1', title: 'Deploy decision' }),
      slot({ key: 'w1', title: 'Building the fix', running: true, last_message: 'running pytest' }),
      slot({ key: 'm1', title: 'PR watch' }),
      slot({ key: 'quiet1', title: 'Old chat', last_activity_ts: NOW - 2 * 3600 }),
      slot({ key: 'ancient', title: 'Ancient thing', last_activity_ts: NOW - 30 * DAY }),
    ],
    loops: [loop({ id: 'lp1', slot_key: 'm1', message: 'Watch the deploy until healthy' })],
    questions: [{ ask_id: 'ask1', slot: 'q1', ts: NOW - 60, questions: [{ question: 'Which region?', options: ['us-east-1'] }] }],
    approvals: [{ id: 'bg1', source: 'cron:patrol', tool: 'execute_bash', tool_purpose: 'rotate logs', ts: NOW - 30 }],
  }, NOW)
}

test('boardKey: attention items reuse itemKey, tiles key by loop/slot', () => {
  const c = busyBoard()
  assert.equal(boardKey(c.needsYou.find((i) => i.kind === 'question')), 'q-ask1')
  assert.equal(boardKey(c.needsYou.find((i) => i.kind === 'bgApproval')), 'bg-bg1')
  assert.equal(boardKey(c.working[0]), 's-w1')
  assert.equal(boardKey(c.mission[0]), 'l-lp1')
  assert.equal(boardKey(c.quietToday[0]), 's-quiet1')
})

test('filterClassified: matches title, last message, loop goal, question text, approval source; empty query is identity', () => {
  const c = busyBoard()
  assert.equal(filterClassified(c, ''), c)
  assert.equal(filterClassified(c, '   '), c)
  const byTitle = filterClassified(c, 'building')
  assert.equal(byTitle.working.length, 1)
  assert.equal(byTitle.needsYou.length, 0)
  assert.equal(filterClassified(c, 'PYTEST').working.length, 1) // case-insensitive, last_message
  assert.equal(filterClassified(c, 'until healthy').mission.length, 1) // loop goal
  assert.equal(filterClassified(c, 'which region').needsYou.length, 1) // question text
  assert.equal(filterClassified(c, 'cron:patrol').needsYou.length, 1) // approval source
  const none = filterClassified(c, 'zzz-no-match')
  assert.equal(none.needsYou.length + none.working.length + none.mission.length +
    none.quietToday.length + none.quietEarlier.length + none.older.length, 0)
})

test('flattenBoard: section order, identity keys, older gated on expansion', () => {
  const c = busyBoard()
  const flat = flattenBoard(c, false)
  // needsYou (question + bgApproval) → working → mission → quiet; older collapsed
  assert.equal(flat.length, 5)
  assert.equal(flat[0].key[0] === 'q' || flat[0].key.startsWith('bg-'), true)
  assert.ok(flat.some((f) => f.key === 's-w1' && f.slotKey === 'w1'))
  assert.ok(flat.some((f) => f.key === 'l-lp1' && f.slotKey === 'm1'))
  assert.ok(!flat.some((f) => f.key === 's-ancient'))
  const flatAll = flattenBoard(c, true)
  assert.equal(flatAll.length, 6)
  assert.ok(flatAll.some((f) => f.key === 's-ancient'))
  // working comes after every needsYou item
  const wIdx = flatAll.findIndex((f) => f.key === 's-w1')
  const lastNeed = Math.max(flatAll.findIndex((f) => f.key === 'q-ask1'), flatAll.findIndex((f) => f.key === 'bg-bg1'))
  assert.ok(wIdx > lastNeed)
})

test('sectionDeltas: null prev yields none; section moves and new items flagged; unchanged silent', () => {
  const c1 = busyBoard()
  const m1 = sectionMap(c1)
  assert.deepEqual(sectionDeltas(null, m1), [])
  assert.deepEqual(sectionDeltas(m1, m1), [])
  // w1 finishes → moves working → quiet; a brand-new slot appears
  const c2 = classify({
    slots: [
      slot({ key: 'w1', title: 'Building the fix', running: false, last_activity_ts: NOW - 10 }),
      slot({ key: 'newbie', title: 'Fresh session', running: true }),
    ],
    loops: [], questions: [], approvals: [],
  }, NOW)
  const d = sectionDeltas(m1, sectionMap(c2))
  assert.ok(d.includes('s-w1'), 'moved section')
  assert.ok(d.includes('s-newbie'), 'new item')
  assert.ok(!d.includes('s-quiet1'), 'departed items are not flagged')
})
