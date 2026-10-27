import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Line } from '../types'
import {
  TOOL_NAME,
  apply,
  cells,
  currentIndex,
  describe as describeLine,
  layout,
  nextIndex,
  statusText,
  wrap,
} from './register'

const NOW = '2026-10-26T10:00:00.000Z'
const LATER = '2026-10-26T10:30:00.000Z'

const ROUTE = {
  action: 'plan',
  goal: 'Close AG-22',
  why: 'The clock note is wrong in production',
  stops: [
    { id: 'read', title: 'Read the roadmap row', why: 'know what is claimed' },
    { id: 'merge', title: 'Merge the PR', why: 'the fix must be on master', who: 'person' },
    { id: 'deploy', title: 'Deploy and read the clock back', why: 'CI does not deploy in this repo', who: 'external' },
    { id: 'close', title: 'Close the hub note', why: 'the loop is closed in the record' },
  ],
}

const PANE = {
  plugin: 'journey',
  component: 'Pane',
  requestId: 'journey',
  props: {
    title: 'Journey',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** The line after each input in turn; throws when one is refused. */
function run(...inputs: Record<string, unknown>[]): Line {
  let line: Line | null = null
  for (const input of inputs) {
    const out = apply(line, input, NOW)
    if (out.isError) throw new Error(out.text)
    line = out.line
  }
  if (line === null) throw new Error('no line')
  return line
}

test('plan lays the route with the first stop as the one the session is at', async () => {
  const line = run(ROUTE)
  expect(line.goal).toBe('Close AG-22')
  expect(line.stops.map(s => s.id)).toEqual(['read', 'merge', 'deploy', 'close'])
  expect(line.stops.map(s => s.state)).toEqual(['here', 'todo', 'todo', 'todo'])
  expect(line.stops.map(s => s.who)).toEqual(['claude', 'person', 'external', 'claude'])
  expect(currentIndex(line)).toBe(0)
  expect(nextIndex(line)).toBe(1)
  expect(line.log.map(m => m.text)).toEqual(['Route laid — 4 stops'])
})

test('plan refuses a route with no goal, one stop, or a stop with no title', async () => {
  expect(apply(null, { action: 'plan', stops: ROUTE.stops }, NOW).text).toMatch(/needs a "goal"/)
  expect(apply(null, { action: 'plan', goal: 'x', stops: [{ title: 'only' }] }, NOW).text).toMatch(/at least two stops/)
  expect(apply(null, { action: 'plan', goal: 'x', stops: [{ title: 'a' }, { why: 'no title' }] }, NOW).text).toMatch(/stop 2 has no "title"/)
  expect(apply(null, { action: 'plan', goal: 'x' }, NOW).isError).toBe(true)
})

test('arrive needs the reason for being there and, moving forward, what came of the stop left', async () => {
  const planned = run(ROUTE)
  expect(apply(planned, { action: 'arrive', id: 'merge' }, LATER).text).toMatch(/needs a "note"/)
  expect(apply(planned, { action: 'arrive', id: 'merge', note: 'PR is open' }, LATER).text).toMatch(/what came of it/)
  expect(apply(planned, { action: 'arrive', id: 'nope', note: 'x' }, LATER).text).toMatch(/Stops: read, merge, deploy, close/)

  const moved = apply(planned, { action: 'arrive', id: 'merge', note: 'PR #146 waits for review', outcome: 'Found the AG-22 row' }, LATER)
  expect(moved.isError).toBe(false)
  expect(moved.line?.stops.map(s => s.state)).toEqual(['done', 'here', 'todo', 'todo'])
  expect(moved.line?.stops[0]?.note).toBe('Found the AG-22 row')
  expect(moved.line?.stops[1]).toMatchObject({ note: 'PR #146 waits for review', at: LATER })

  // going back needs no outcome: the stop left is simply not reached again
  const back = apply(moved.line, { action: 'arrive', id: 'read', note: 'the row was stale, reading it again' }, LATER)
  expect(back.line?.stops.map(s => s.state)).toEqual(['here', 'todo', 'todo', 'todo'])
})

test('a stop is never marked done, skipped or blocked without saying why', async () => {
  const line = run(ROUTE)
  expect(apply(line, { action: 'update', id: 'read', state: 'done' }, LATER).text).toMatch(/needs a "note": what came of it/)
  expect(apply(line, { action: 'update', id: 'read', state: 'skipped' }, LATER).text).toMatch(/why it is left out/)
  expect(apply(line, { action: 'update', id: 'read', state: 'blocked' }, LATER).text).toMatch(/what is in the way/)
  expect(apply(line, { action: 'update', id: 'read', state: 'flying', note: 'x' }, LATER).text).toMatch(/state must be one of/)
  expect(apply(line, { action: 'update', id: 'read' }, LATER).text).toMatch(/changed nothing/)

  const blocked = apply(line, { action: 'update', id: 'read', state: 'blocked', note: 'the roadmap will not open' }, LATER)
  expect(blocked.line?.stops[0]?.state).toBe('blocked')
  expect(currentIndex(blocked.line!)).toBe(0) // a blocked stop is where the session is stuck
  expect(statusText(blocked.line)).toBe('⛔ 0/4 · Read the roadmap row')

  const refreshed = apply(line, { action: 'update', id: 'read', note: 'waiting on CI', who: 'external' }, LATER)
  expect(refreshed.line?.stops[0]).toMatchObject({ state: 'here', note: 'waiting on CI', who: 'external' })
})

test('planning again keeps what the route already passed, by id or by title', async () => {
  const moved = apply(run(ROUTE), { action: 'arrive', id: 'merge', note: 'PR waits', outcome: 'row found' }, LATER).line
  const again = apply(
    moved,
    {
      action: 'plan',
      stops: [
        { id: 'read', title: 'Read the roadmap row' },
        { id: 'merge-pr', title: 'Merge the PR' }, // new id, same title: it is the same stop
        { title: 'Check CI is green' },
        { id: 'deploy', title: 'Deploy and read the clock back' },
        { id: 'close', title: 'Close the hub note' },
      ],
    },
    LATER,
  )
  expect(again.isError).toBe(false)
  expect(again.line?.goal).toBe('Close AG-22') // a re-plan without a goal keeps it
  expect(again.line?.stops.map(s => s.id)).toEqual(['read', 'merge', 'check-ci-is-green', 'deploy', 'close'])
  expect(again.line?.stops.map(s => s.state)).toEqual(['done', 'here', 'todo', 'todo', 'todo'])
  expect(again.line?.stops[1]?.note).toBe('PR waits')
  expect(again.line?.stops[0]?.why).toBe('know what is claimed') // untouched details stay
  expect(again.line?.log.at(-1)?.text).toBe('Route changed — 1 added, 0 removed')
})

test('finish is refused while a stop is open, and closes once every stop is done or skipped', async () => {
  const line = run(ROUTE)
  const refused = apply(line, { action: 'finish' }, LATER)
  expect(refused.isError).toBe(true)
  expect(refused.text).toMatch(/4 stops are not done or skipped — read \(here\), merge \(todo\)/)

  let now = line
  for (const id of ['read', 'merge', 'deploy']) {
    now = apply(now, { action: 'update', id, state: 'done', note: `${id} verified` }, LATER).line!
  }
  now = apply(now, { action: 'update', id: 'close', state: 'skipped', note: 'the note was closed in the same commit' }, LATER).line!
  const done = apply(now, { action: 'finish', note: 'live, clock read back' }, LATER)
  expect(done.isError).toBe(false)
  expect(done.line?.closedAt).toBe(LATER)
  expect(statusText(done.line)).toBe('🏁 arrived — Close AG-22')
  expect(describeLine(done.line)).toMatch(/^🏁 Arrived — Close AG-22 \(4 of 4 stops passed; live, clock read back\)/)
  // a finished journey takes no more moves until a new one is planned
  expect(apply(done.line, { action: 'arrive', id: 'read', note: 'x' }, LATER).text).toMatch(/has arrived/)
  expect(apply(done.line, ROUTE, LATER).line?.stops.map(s => s.state)).toEqual(['here', 'todo', 'todo', 'todo'])
})

test('describe reads back the line with where the session is and what comes next', async () => {
  const line = apply(run(ROUTE), { action: 'arrive', id: 'merge', note: 'PR waits for review', outcome: 'row found' }, LATER).line
  expect(describeLine(line).split('\n')).toEqual([
    '🚇 Close AG-22 — 1 of 4 stops passed',
    '✅ read: Read the roadmap row — row found',
    '▶ merge: Merge the PR [your call] — PR waits for review',
    '🔲 deploy: Deploy and read the clock back [waiting on others]',
    '🔲 close: Close the hub note',
    'Next after this: deploy.',
  ])
  expect(describeLine(null)).toMatch(/No journey yet/)
})

test('the status line names the stop the session is at, and who it waits on', async () => {
  const planned = run(ROUTE)
  expect(statusText(planned)).toBe('🚇 0/4 · Read the roadmap row')
  const atMerge = apply(planned, { action: 'arrive', id: 'merge', note: 'waiting', outcome: 'ok' }, LATER).line
  expect(statusText(atMerge)).toBe('👤 1/4 · Merge the PR')
  const atDeploy = apply(atMerge, { action: 'arrive', id: 'deploy', note: 'waiting', outcome: 'merged' }, LATER).line
  expect(statusText(atDeploy)).toBe('⏳ 2/4 · Deploy and read the clock back')
  const between = apply(atDeploy, { action: 'update', id: 'deploy', state: 'done', note: 'live' }, LATER).line
  expect(statusText(between)).toBe('🚇 3/4 · next: Close the hub note')
  expect(describeLine(between)).toMatch(/Between stops — arrive at "close"/)
  expect(statusText(null)).toBeUndefined()
})

test('cells counts emoji as two and wrap keeps every line inside the room', async () => {
  expect(cells('abc')).toBe(3)
  expect(cells('●')).toBe(1)
  expect(cells('✅')).toBe(2)
  expect(cells('👤 hi')).toBe(5)
  expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrap('', 10)).toEqual([])
  for (const l of wrap('a long sentence with 👤 emoji 🚇 and some-hyphenated-words that must wrap', 16)) {
    expect(cells(l)).toBeLessThanOrEqual(16)
  }
})

test('the line is green behind the session and dim ahead of it', async () => {
  const atDeploy = apply(
    apply(run(ROUTE), { action: 'arrive', id: 'merge', note: 'x', outcome: 'done read' }, LATER).line,
    { action: 'arrive', id: 'deploy', note: 'CI does not deploy here, so the revision is read back by hand', outcome: 'merged' },
    LATER,
  ).line!
  const rows = layout(atDeploy, 60, true)

  // one station per stop, in order, with the glyph of its state
  const stations = rows.filter(r => /^ [●◉○◌◆] $/.test(r.gutter))
  expect(stations.map(r => r.gutter.trim())).toEqual(['●', '●', '◉', '○'])
  expect(stations.map(r => r.track)).toEqual(['success', 'success', 'claude', null])

  // the connectors: green up to the stop the session is at, dim after it
  const connectors = rows.filter(r => r.gutter === ' │ ' && r.parts.length === 0)
  expect(connectors.map(r => r.track)).toEqual(['success', 'success', null])

  // where we are, and why
  const text = rows.map(r => r.parts.map(p => p.text).join('')).join('\n')
  expect(text).toMatch(/YOU ARE HERE/)
  expect(text).toMatch(/Why here: CI does not deploy here/)
  expect(text).toMatch(/Why this stop: CI does not deploy in this repo/)
  expect(text).toMatch(/✓ merged/)
  expect(text).toMatch(/🏁 Close the hub note/)
  expect(text).toMatch(/⏳ waiting on others/)

  // the stop that waits on the person says so until it is passed
  const early = layout(run(ROUTE), 60, true)
  expect(early.map(r => r.parts.map(p => p.text).join('')).join('\n')).toMatch(/Merge the PR {2}👤 your call/)
})

test('a stop passed without being marked is flagged rather than quietly counted', async () => {
  const jumped = apply(run(ROUTE), { action: 'update', id: 'deploy', state: 'done', note: 'x' }, LATER).line!
  const between = apply(jumped, { action: 'update', id: 'read', state: 'done', note: 'x' }, LATER).line!
  const rows = layout(between, 60, true)
  const text = rows.map(r => r.parts.map(p => p.text).join('')).join('\n')
  expect(text).toMatch(/Merge the PR.*⚠ passed, not marked/)
})

test('a narrow pane keeps every row inside its width', async () => {
  const line = run(ROUTE)
  for (const width of [24, 30, 45]) {
    for (const row of layout(line, width, false)) {
      expect(row.gutter.length + cells(row.parts.map(p => p.text).join(''))).toBeLessThanOrEqual(width)
    }
  }
})

test('the model lays a route and the pane, the status line and the command follow it', async ($, on) => {
  mock.clock(on, { now: Date.parse(NOW) })
  mock.store(on)
  const registered: string[] = []
  const statuses: (string | undefined)[] = []
  const opened: string[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: TOOL_NAME } }
  })
  on('command.register', () => ({ value: { command: 'journey' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are.', scope: 'shared' }] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual(['line'])

  // the system prompt carries the instruction, after the engine's own sections
  const composed = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['desktop'],
    tools: [TOOL_NAME],
    outputStyle: null,
    traits: [],
  })
  expect(composed.sections.map(s => s.id)).toEqual(['intro', 'journey:line'])
  expect(composed.sections[1]?.text).toMatch(/mcp__journey__line/)

  // before any route the pane says so
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No journey yet/ })).toBeDefined()
    await ui.unmount()
  }

  const planned = await $.tool.call({ tool: TOOL_NAME, ...ROUTE })
  expect(planned.deny).toBeUndefined()
  expect(planned.result).toMatch(/🚇 Close AG-22 — 0 of 4 stops passed/)
  expect(statuses.at(-1)).toBe('🚇 0/4 · Read the roadmap row')
  expect(opened).toEqual(['journey']) // the first route opens the pane once

  const refused = await $.tool.call({ tool: TOOL_NAME, action: 'arrive', id: 'merge' })
  expect(refused.deny).toMatch(/"arrive" needs a "note"/) // a refused move is read by the model as an error
  expect(statuses.at(-1)).toBe('🚇 0/4 · Read the roadmap row') // a refused move changes nothing

  await $.tool.call({ tool: TOOL_NAME, action: 'arrive', id: 'merge', note: 'PR #146 waits for review', outcome: 'row found' })
  expect(statuses.at(-1)).toBe('👤 1/4 · Merge the PR')
  expect(opened).toEqual(['journey']) // moves do not reopen it

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Close AG-22/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /YOU ARE HERE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Why here: PR #146 waits for review/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Next stop: Deploy and read the clock back/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 of 4 stops passed/ })).toBeDefined()
    await ui.unmount()
  }

  // /journey prints the line; /journey clear drops it and the status line
  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
  const shown = await $.command.run({ command: 'journey', args: '', ...typed })
  expect(shown.text).toMatch(/▶ merge: Merge the PR \[your call\]/)
  const cleared = await $.command.run({ command: 'journey', args: 'clear', ...typed })
  expect(cleared.text).toBe('Journey cleared.')
  expect(statuses.at(-1)).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No journey yet/ })).toBeDefined()
  await ui.unmount()
})

/** The engine beneath the mod, enough for a session to start and a route to be laid. */
function engine(on: On, statuses: (string | undefined)[]): void {
  on('session.id', () => ({ value: 'sess-2' }))
  on('tool.register', () => ({ value: { tool: TOOL_NAME } }))
  on('command.register', () => ({ value: { command: 'journey' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
}

test('every move is written to the store under the session id, newest journeys only', async ($, on) => {
  mock.clock(on, { now: Date.parse(NOW) })
  // a store of the test's own, so the writes can be read back
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  engine(on, [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL_NAME, ...ROUTE })
  await $.tool.call({ tool: TOOL_NAME, action: 'arrive', id: 'merge', note: 'PR waits', outcome: 'row found' })

  const kept = store.get('lines') as Record<string, Line>
  expect(Object.keys(kept)).toEqual(['sess-2'])
  expect(kept['sess-2']?.goal).toBe('Close AG-22')
  expect(kept['sess-2']?.stops.map(s => s.state)).toEqual(['done', 'here', 'todo', 'todo'])

  // clearing removes it
  await $.tool.call({ tool: TOOL_NAME, action: 'clear' })
  expect(store.get('lines')).toEqual({})
})

test('a resumed session finds its route again, and shows it in the status line', async ($, on) => {
  const planned = run(ROUTE)
  const resumed = apply(planned, { action: 'arrive', id: 'merge', note: 'PR waits for review', outcome: 'row found' }, LATER).line
  mock.clock(on, { now: Date.parse(LATER) })
  mock.store(on, { lines: { 'sess-2': resumed, 'other-session': planned } })
  const statuses: (string | undefined)[] = []
  engine(on, statuses)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(statuses.at(-1)).toBe('👤 1/4 · Merge the PR')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Why here: PR waits for review/ })).toBeDefined()
  await ui.unmount()
})
