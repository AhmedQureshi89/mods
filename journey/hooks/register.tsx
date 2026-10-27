// journey — a metro line for the task in hand.
//
// Claude lays the whole route out first (every stop from now to done, each with why it is on the
// line and who has to act), then keeps it true as the work moves. The mod draws it:
//   🚇 a pane — the stops as a vertical metro line; green where the session has been, dim where it
//      has not, ◉ YOU ARE HERE with why the session is stopped there, 👤 on a stop only the person
//      can pass, ⏳ on one that waits on something outside the session;
//   🚇 the status line under the prompt — "3/7 · Deploy and read the clock back".
//
// How it is fed: a tool the model calls, `mcp__journey__line`, with six actions —
//   plan    lay the route (again, when it changes: stops keep their state by id)
//   arrive  the session reaches a stop — needs `note`, why it is there; leaving a stop forward
//           needs `outcome`, what came of it
//   update  change a stop: done / skipped / blocked need a `note` — a stop is never ticked
//           without saying what came of it
//   finish  close the journey — refused while any stop is still todo, here or blocked
//   clear   drop it
//   show    read it back
// and a short section the mod adds to the system prompt, so the model reaches for the tool on a
// task with more than a couple of steps. `/journey` opens the pane, `/journey plan <goal>` asks
// Claude to lay the route, `/journey clear` drops it.
//
// The route is kept in `$.state` (survives a reload) and in `$.store`, per session id, so a
// resumed session finds it again. The mod reads and writes nothing else: no files, no processes.

import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Line, Move, Stop, StopState, Who } from '../types'

const PANE = 'journey'
const TITLE = 'Journey'
const TOOL = 'line'
export const TOOL_NAME = 'mcp__journey__line'
const STATES = ['todo', 'here', 'done', 'skipped', 'blocked'] as const
const WHO = ['claude', 'person', 'external'] as const
const ACTIONS = ['plan', 'arrive', 'update', 'finish', 'clear', 'show'] as const
const MAX_STOPS = 30
/** Moves the log keeps. */
const MAX_LOG = 12
/** Journeys kept across sessions, newest first. */
const KEPT = 10
/** Moves the pane lists when it is docked. */
const MOVES_SHOWN = 4

const journey = atom({ plugin: 'journey', key: 'line' } as const, null)

type Raw = Record<string, unknown>

/** What an action came to: the line afterwards, what the model reads back, whether it was refused. */
export type Outcome = { line: Line | null; text: string; isError: boolean; changed: boolean }

// ---- reading what the model sent ---------------------------------------------

function isState(v: unknown): v is StopState {
  return (STATES as readonly unknown[]).includes(v)
}

function isWho(v: unknown): v is Who {
  return (WHO as readonly unknown[]).includes(v)
}

/** A one-line string, cut at `max` characters. */
function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(/\s+/g, ' ').trim()
  const chars = Array.from(t)
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : t
}

function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
}

function norm(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function fail(line: Line | null, text: string): Outcome {
  return { line, text, isError: true, changed: false }
}

function pushLog(log: readonly Move[], at: string, text: string): Move[] {
  return [...log, { at, text }].slice(-MAX_LOG)
}

/** The stops of a `plan` call, each keeping the state and note of the stop it matches on the old line. */
function readStops(raw: unknown, old: readonly Stop[]): Stop[] | string {
  if (!Array.isArray(raw)) return '"stops" must be a list: every stop from now to done, in order.'
  if (raw.length < 2) return 'a journey needs at least two stops — where it starts and where it arrives.'
  if (raw.length > MAX_STOPS) return `a journey holds at most ${MAX_STOPS} stops; group the small ones.`
  const seen = new Set<string>()
  const out: Stop[] = []
  for (const [i, item] of raw.entries()) {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Raw
    const title = str(r.title, 80)
    if (title === '') return `stop ${i + 1} has no "title".`
    const byId = old.find(s => s.id === slug(str(r.id, 40)))
    const known = byId ?? old.find(s => norm(s.title) === norm(title))
    const base = byId ? slug(str(r.id, 40)) : known ? known.id : slug(str(r.id, 40)) || slug(title) || `stop-${i + 1}`
    let id = base
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`
    seen.add(id)
    const was = known && !out.some(s => s.id === known.id) ? known : undefined
    out.push({
      id,
      title,
      why: r.why !== undefined ? str(r.why, 240) : (was?.why ?? ''),
      who: isWho(r.who) ? r.who : (was?.who ?? 'claude'),
      state: isState(r.state) ? r.state : (was?.state ?? 'todo'),
      note: r.note !== undefined ? str(r.note, 400) : (was?.note ?? ''),
      at: was?.at ?? null,
    })
  }
  return out
}

/** At most one stop is `here`: the first. */
function oneHere(stops: readonly Stop[]): Stop[] {
  let seen = false
  return stops.map(s => {
    if (s.state !== 'here') return s
    if (!seen) {
      seen = true
      return s
    }
    return { ...s, state: 'todo' as const }
  })
}

// ---- the line itself ---------------------------------------------------------

export function progress(line: Line): { total: number; done: number; skipped: number; passed: number } {
  const total = line.stops.length
  const done = line.stops.filter(s => s.state === 'done').length
  const skipped = line.stops.filter(s => s.state === 'skipped').length
  return { total, done, skipped, passed: done + skipped }
}

/** The stop the session is at: the one marked `here`, else the first `blocked`; -1 between stops. */
export function currentIndex(line: Line): number {
  const here = line.stops.findIndex(s => s.state === 'here')
  return here >= 0 ? here : line.stops.findIndex(s => s.state === 'blocked')
}

/** The next stop still to come after the current one; -1 when there is none. */
export function nextIndex(line: Line): number {
  const from = currentIndex(line)
  return line.stops.findIndex((s, i) => i > from && s.state === 'todo')
}

/** How far the line has been travelled: the index of the farthest stop touched; -1 before the first. */
function reachedIndex(line: Line): number {
  if (line.closedAt !== null) return line.stops.length - 1
  let at = -1
  line.stops.forEach((s, i) => {
    if (s.state !== 'todo') at = i
  })
  return at
}

function touch(line: Line, stops: Stop[], now: string, text: string): Line {
  return { ...line, stops, updatedAt: now, log: pushLog(line.log, now, text) }
}

function stopIds(line: Line): string {
  return line.stops.map(s => s.id).join(', ')
}

function plan(prev: Line | null, input: Raw, now: string): Outcome {
  const base = prev !== null && prev.closedAt === null ? prev : null
  const goal = str(input.goal, 120) || (base?.goal ?? '')
  if (goal === '') return fail(prev, '"plan" needs a "goal": what done means for this task.')
  const read = readStops(input.stops, base?.stops ?? [])
  if (typeof read === 'string') return fail(prev, `plan: ${read}`)
  let stops = oneHere(read)
  if (base === null && !stops.some(s => s.state === 'here' || s.state === 'done')) {
    const first = stops[0]
    if (first) stops = stops.map(s => (s === first ? { ...s, state: 'here' as const, at: now } : s))
  }
  let text: string
  if (base === null) {
    text = `Route laid — ${stops.length} stops`
  } else {
    const had = new Set(base.stops.map(s => s.id))
    const has = new Set(stops.map(s => s.id))
    const added = stops.filter(s => !had.has(s.id)).length
    const removed = base.stops.filter(s => !has.has(s.id)).length
    text = added + removed === 0 ? 'Route details updated' : `Route changed — ${added} added, ${removed} removed`
  }
  const line: Line = {
    goal,
    why: input.why !== undefined ? str(input.why, 300) : (base?.why ?? ''),
    stops,
    startedAt: base?.startedAt ?? now,
    updatedAt: now,
    closedAt: null,
    closing: '',
    log: pushLog(base?.log ?? [], now, text),
  }
  return { line, text: describe(line), isError: false, changed: true }
}

/** The stops after the session reaches `index`; a string when the move is refused. */
function arriveAt(stops: readonly Stop[], index: number, note: string, outcome: string, now: string): Stop[] | string {
  const hereIdx = stops.findIndex(s => s.state === 'here')
  if (hereIdx >= 0 && hereIdx < index && outcome === '') {
    const leaving = stops[hereIdx]
    return `you are leaving "${leaving?.title ?? ''}": say what came of it in "outcome" — or mark it skipped or blocked with "update" first.`
  }
  return stops.map((s, i) => {
    if (i === index) return { ...s, state: 'here' as const, note, at: now }
    if (i !== hereIdx) return s
    return hereIdx < index ? { ...s, state: 'done' as const, note: outcome } : { ...s, state: 'todo' as const, note: '' }
  })
}

function openLine(prev: Line | null, action: string): Outcome | null {
  if (prev === null) return fail(prev, `"${action}": there is no journey yet. Lay the route out first with action "plan".`)
  if (prev.closedAt !== null) return fail(prev, `"${action}": this journey has arrived. Start a new one with action "plan".`)
  return null
}

function arrive(prev: Line | null, input: Raw, now: string): Outcome {
  const refused = openLine(prev, 'arrive')
  if (refused !== null || prev === null) return refused ?? fail(prev, 'no journey')
  const id = str(input.id, 40)
  const index = prev.stops.findIndex(s => s.id === id)
  const stop = prev.stops[index]
  if (index < 0 || !stop) return fail(prev, `"arrive": no stop "${id}". Stops: ${stopIds(prev)}.`)
  const note = str(input.note, 400)
  if (note === '') return fail(prev, `"arrive" needs a "note": why the session is at "${stop.title}" right now.`)
  const stops = arriveAt(prev.stops, index, note, str(input.outcome, 400), now)
  if (typeof stops === 'string') return fail(prev, `arrive: ${stops}`)
  const line = touch(prev, stops, now, `Arrived at ${stop.title}`)
  return { line, text: describe(line), isError: false, changed: true }
}

function amend(prev: Line | null, input: Raw, now: string): Outcome {
  const refused = openLine(prev, 'update')
  if (refused !== null || prev === null) return refused ?? fail(prev, 'no journey')
  const id = str(input.id, 40)
  const index = prev.stops.findIndex(s => s.id === id)
  const stop = prev.stops[index]
  if (index < 0 || !stop) return fail(prev, `"update": no stop "${id}". Stops: ${stopIds(prev)}.`)
  if (input.state !== undefined && !isState(input.state)) {
    return fail(prev, `"update": state must be one of ${STATES.join(', ')}.`)
  }
  if (input.state === 'here') return arrive(prev, input, now)

  const patch: Partial<Stop> = {}
  const title = str(input.title, 80)
  if (title !== '') patch.title = title
  if (input.why !== undefined) patch.why = str(input.why, 240)
  if (isWho(input.who)) patch.who = input.who
  const note = input.note !== undefined ? str(input.note, 400) : undefined
  if (input.state === 'done' || input.state === 'skipped' || input.state === 'blocked') {
    if (!note) {
      const what = input.state === 'done' ? 'what came of it' : input.state === 'skipped' ? 'why it is left out' : 'what is in the way'
      return fail(prev, `"update": marking "${stop.title}" ${input.state} needs a "note": ${what}.`)
    }
    patch.state = input.state
    patch.note = note
  } else if (input.state === 'todo') {
    patch.state = 'todo'
    patch.note = note ?? ''
  } else if (note !== undefined) {
    patch.note = note
  }
  if (Object.keys(patch).length === 0) {
    return fail(prev, '"update" changed nothing: give a state, note, title, why or who.')
  }
  const stops = prev.stops.map((s, i) => (i === index ? { ...s, ...patch } : s))
  const label = patch.state ? `${stop.title}: ${patch.state}` : `${stop.title}: updated`
  const line = touch(prev, stops, now, label)
  return { line, text: describe(line), isError: false, changed: true }
}

function finish(prev: Line | null, input: Raw, now: string): Outcome {
  const refused = openLine(prev, 'finish')
  if (refused !== null || prev === null) return refused ?? fail(prev, 'no journey')
  const open = prev.stops.filter(s => s.state === 'todo' || s.state === 'here' || s.state === 'blocked')
  if (open.length > 0) {
    const list = open.map(s => `${s.id} (${s.state})`).join(', ')
    return fail(
      prev,
      `"finish": ${open.length} stop${open.length === 1 ? ' is' : 's are'} not done or skipped — ${list}. ` +
        'Mark each done (with what came of it) or skipped (with why), then finish.',
    )
  }
  const line: Line = {
    ...prev,
    closedAt: now,
    closing: str(input.note, 300),
    updatedAt: now,
    log: pushLog(prev.log, now, 'Arrived'),
  }
  return { line, text: describe(line), isError: false, changed: true }
}

/** One call of the tool, on the line as it stands. */
export function apply(prev: Line | null, input: Raw, now: string): Outcome {
  const action = typeof input.action === 'string' ? input.action : ''
  switch (action) {
    case 'plan':
      return plan(prev, input, now)
    case 'arrive':
      return arrive(prev, input, now)
    case 'update':
      return amend(prev, input, now)
    case 'finish':
      return finish(prev, input, now)
    case 'clear':
      return { line: null, text: prev ? 'Journey cleared.' : 'There was no journey.', isError: false, changed: prev !== null }
    case 'show':
      return { line: prev, text: describe(prev), isError: false, changed: false }
    default:
      return fail(prev, `Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`)
  }
}

// ---- words ---------------------------------------------------------------------

const MARK: Record<StopState, string> = { done: '✅', here: '▶', todo: '🔲', skipped: '➖', blocked: '⛔' }
const WHO_TAG: Record<Who, string> = { claude: '', person: ' [your call]', external: ' [waiting on others]' }

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text
}

/** The line as plain text — what the model reads back after each call, and what `/journey` prints. */
export function describe(line: Line | null): string {
  if (line === null) return 'No journey yet. Lay the route out with action "plan".'
  const p = progress(line)
  const head = line.closedAt !== null
    ? `🏁 Arrived — ${line.goal} (${p.passed} of ${p.total} stops passed${line.closing ? `; ${line.closing}` : ''})`
    : `🚇 ${line.goal} — ${p.passed} of ${p.total} stops passed`
  const rows = line.stops.map(s => {
    const tag = s.state === 'done' || s.state === 'skipped' ? '' : WHO_TAG[s.who]
    const note = s.note !== '' && s.state !== 'todo' ? ` — ${clip(s.note, 120)}` : ''
    return `${MARK[s.state]} ${s.id}: ${s.title}${tag}${note}`
  })
  const tail: string[] = []
  if (line.closedAt === null) {
    const next = line.stops[nextIndex(line)]
    if (currentIndex(line) < 0) {
      tail.push(next ? `Between stops — arrive at "${next.id}" when you start it.` : 'Every stop is passed — finish the journey.')
    } else if (next) {
      tail.push(`Next after this: ${next.id}.`)
    } else {
      tail.push('This is the last stop.')
    }
  }
  return [head, ...rows, ...tail].join('\n')
}

/** The status line under the prompt; undefined clears it. */
export function statusText(line: Line | null): string | undefined {
  if (line === null) return undefined
  const p = progress(line)
  if (line.closedAt !== null) return clip(`🏁 arrived — ${line.goal}`, 80)
  const cur = line.stops[currentIndex(line)]
  if (cur) {
    const icon = cur.state === 'blocked' ? '⛔' : cur.who === 'person' ? '👤' : cur.who === 'external' ? '⏳' : '🚇'
    return clip(`${icon} ${p.passed}/${p.total} · ${cur.title}`, 80)
  }
  const next = line.stops[nextIndex(line)]
  return clip(`🚇 ${p.passed}/${p.total} · ${next ? `next: ${next.title}` : 'ready to finish'}`, 80)
}

// ---- drawing: cells, wrapping, layout ------------------------------------------

const WIDE = new Set([0x231a, 0x231b, 0x23f0, 0x23f3, 0x2614, 0x2615, 0x26a1, 0x26d4, 0x2705, 0x274c, 0x2728, 0x2b50, 0x2b55])

/** How many terminal cells a string takes: emoji and CJK count two, joiners none. */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0xfe0f || c === 0x200d || (c >= 0x0300 && c <= 0x036f)) continue
    const isWide =
      c >= 0x1f300 || WIDE.has(c) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xff60)
    n += isWide ? 2 : 1
  }
  return n
}

/** The longest start of `text` that fits `room` cells. */
function head(text: string, room: number): string {
  let n = 0
  let out = ''
  for (const ch of text) {
    const w = cells(ch)
    if (n + w > room) break
    out += ch
    n += w
  }
  return out
}

/** `text` broken into lines of at most `width` cells, at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(4, width)
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    let w = word
    while (cells(w) > room) {
      if (cur !== '') {
        lines.push(cur)
        cur = ''
      }
      const piece = head(w, room)
      lines.push(piece)
      w = w.slice(piece.length)
    }
    if (cur === '') cur = w
    else if (cells(cur) + 1 + cells(w) <= room) cur += ' ' + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur !== '') lines.push(cur)
  return lines
}

/** At most `max` lines; the last one ends in … when something was cut. */
function limit(lines: string[], max: number, room: number): string[] {
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  const last = kept[kept.length - 1] ?? ''
  kept[max - 1] = cells(last) >= room ? head(last, room - 1) + '…' : last + '…'
  return kept
}

export type Part = { text: string; color?: Color; bold?: boolean; dim?: boolean; inverse?: boolean; strike?: boolean }
/** One row of the line: its three-cell track and what stands beside it. `track` null draws dim. */
export type Row = { gutter: string; track: Color | null; parts: Part[] }

const GLYPH: Record<StopState, { mark: string; color: Color | null }> = {
  done: { mark: '●', color: 'success' },
  here: { mark: '◉', color: 'claude' },
  blocked: { mark: '◆', color: 'error' },
  skipped: { mark: '◌', color: null },
  todo: { mark: '○', color: null },
}

function hhmm(iso: string | null): string {
  if (iso === null) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A label, then the text wrapped under it with a hanging indent. */
function labelled(label: string, text: string, room: number, max: number, color?: Color): Part[][] {
  const lines = limit(wrap(text, room - cells(label)), max, room - cells(label))
  const pad = ' '.repeat(cells(label))
  return lines.map((l, i) => [
    i === 0 ? { text: label, dim: true } : { text: pad },
    color ? { text: l, color } : { text: l },
  ])
}

/**
 * The line as rows: a station per stop, a connector between stops, and under each stop what the
 * reader needs — at the stop the session is at, why it is there and why the stop exists; at a
 * passed stop, what came of it; at one still to come, why it is on the line.
 */
export function layout(line: Line, width: number, isDock: boolean): Row[] {
  const room = Math.max(12, width - 3 - 1)
  const body = room - 2
  const detailMax = isDock ? 2 : 1
  const reached = reachedIndex(line)
  const rows: Row[] = []
  const last = line.stops.length - 1

  line.stops.forEach((s, i) => {
    if (i > 0) rows.push({ gutter: ' │ ', track: i <= reached ? 'success' : null, parts: [] })

    const glyph = GLYPH[s.state]
    const isOver = s.state === 'done' || s.state === 'skipped'
    const flag: Part[] = []
    if (!isOver && s.who === 'person') flag.push({ text: '👤 your call', color: 'warning' })
    if (!isOver && s.who === 'external') flag.push({ text: body >= 22 ? '⏳ waiting on others' : '⏳ waiting', color: 'suggestion' })
    if (s.state === 'todo' && i < reached) flag.push({ text: body >= 22 ? '⚠ passed, not marked' : '⚠ unmarked', color: 'warning' })
    const flagWidth = flag.reduce((n, p) => n + 2 + cells(p.text), 0)
    const name = (i === last ? '🏁 ' : '') + s.title
    const nameLines = wrap(name, room)
    const style: Omit<Part, 'text'> =
      s.state === 'here' ? { bold: true, color: 'claude' }
      : s.state === 'blocked' ? { bold: true, color: 'error' }
      : s.state === 'skipped' ? { dim: true, strike: true }
      : s.state === 'todo' ? { dim: true }
      : {}
    const trackColor = glyph.color
    nameLines.forEach((text, k) => {
      const isFirst = k === 0
      const isEnd = k === nameLines.length - 1
      const parts: Part[] = [{ text, ...style }]
      if (isEnd && flag.length > 0 && cells(text) + flagWidth <= room) {
        for (const f of flag) parts.push({ text: '  ' }, f)
        flag.length = 0
      }
      rows.push({ gutter: isFirst ? ` ${glyph.mark} ` : i === last ? '   ' : ' │ ', track: isFirst ? trackColor : i < reached ? 'success' : null, parts })
    })

    const lineBelow: Color | null = i < reached ? 'success' : null
    const below = (parts: Part[]): void => {
      rows.push({ gutter: i === last ? '   ' : ' │ ', track: lineBelow, parts: [{ text: '  ' }, ...parts] })
    }
    // flags that did not fit beside the name each get a row of their own
    flag.forEach(f => below([f]))

    if (s.state === 'here') {
      const tag = ' YOU ARE HERE '
      const since = hhmm(s.at) !== '' ? `  since ${hhmm(s.at)}` : ''
      below([
        { text: tag, bold: true, inverse: true, color: 'claude' },
        ...(since !== '' && cells(tag) + cells(since) <= body ? [{ text: since, dim: true }] : []),
      ])
      const isNarrow = body < 30
      if (s.note !== '') labelled(isNarrow ? 'Here: ' : 'Why here: ', s.note, body, 4).forEach(below)
      if (s.why !== '') labelled(isNarrow ? 'Why: ' : 'Why this stop: ', s.why, body, 3).forEach(below)
    } else if (s.state === 'done' && s.note !== '') {
      labelled('✓ ', s.note, body, detailMax, 'success').forEach(below)
    } else if (s.state === 'skipped' && s.note !== '') {
      labelled('skipped — ', s.note, body, detailMax).forEach(below)
    } else if (s.state === 'blocked') {
      labelled('⛔ ', s.note || 'blocked', body, 3, 'error').forEach(below)
      if (s.why !== '') labelled(body < 30 ? 'Why: ' : 'Why this stop: ', s.why, body, 2).forEach(below)
    } else if (s.state === 'todo' && s.why !== '') {
      limit(wrap(s.why, body), detailMax, body).forEach(l => below([{ text: l, dim: true }]))
    }
  })
  return rows
}

function bar(done: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return ''
  let filled = Math.round((done / total) * width)
  if (done > 0 && filled === 0) filled = 1
  if (done < total && filled === width) filled = width - 1
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Props of a Text for a Part, leaving out what is not set. */
function textProps(p: Part): Record<string, unknown> {
  return {
    ...(p.color ? { color: p.color } : {}),
    ...(p.bold ? { bold: true } : {}),
    ...(p.dim ? { dimColor: true } : {}),
    ...(p.inverse ? { inverse: true } : {}),
    ...(p.strike ? { strikethrough: true } : {}),
  }
}

// ---- keeping -------------------------------------------------------------------

function isLine(v: unknown): v is Line {
  const l = v as Partial<Line> | null | undefined
  return typeof l?.goal === 'string' && Array.isArray(l.stops) && typeof l.startedAt === 'string'
}

function isKept(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function sessionId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

/** Writes the journey under the session's id so a resumed session finds it; the newest few stay. */
async function keep($: EngineInterface, line: Line | null): Promise<void> {
  const id = await sessionId($)
  if (id === '') return
  const stored = await $.store.get('lines')
  const all: Record<string, Line> = {}
  if (isKept(stored)) for (const [k, v] of Object.entries(stored)) if (isLine(v)) all[k] = v
  if (line === null) delete all[id]
  else all[id] = line
  const newest = Object.keys(all)
    .sort((a, b) => (all[b]?.updatedAt ?? '').localeCompare(all[a]?.updatedAt ?? ''))
    .slice(0, KEPT)
  const out: Record<string, Line> = {}
  for (const k of newest) {
    const v = all[k]
    if (v) out[k] = v
  }
  await $.store.set('lines', out)
}

let hasWarned = false

/** Makes `line` the journey: state, status line, and the copy a resumed session reads. */
async function set($: EngineInterface, line: Line | null): Promise<void> {
  await update($, journey, () => line)
  $.ui.status(statusText(line))
  try {
    await keep($, line)
  } catch {
    // the move stands; only a resume would miss it — say so once rather than on every move
    if (!hasWarned) {
      hasWarned = true
      $.ui.toast('journey: the route could not be saved, so a resumed session will not find it')
    }
  }
}

// ---- what the model is told ------------------------------------------------------

const PROMPT_SECTION = [
  'The journey line (tool mcp__journey__line) is a metro-style timeline the person watches beside the chat.',
  'For any task with more than a couple of steps, lay it out before you start: action "plan" with the goal and every stop from now to done —',
  'each with a short title, why it is on the line, and who acts (claude; person for a decision or action only they can take; external for CI, a deploy or a review).',
  'Then keep it true: "arrive" when you reach a stop, with a note on why you are there (and the outcome of the stop you leave);',
  '"update" to mark a stop done (what came of it), skipped or blocked (why); "plan" again when the route changes, reusing the stop ids; "finish" when every stop is done or skipped.',
  'A stop is done when it is verified, not when it is written. Skip the line for a one-step request.',
].join(' ')

const TOOL_DESCRIPTION = [
  'The journey line: a metro-style timeline of the task, drawn beside the chat for the person — every stop from now to done, which stop the session is at, and why.',
  'Use it for any task with more than a couple of steps; skip it for a one-step request.',
  'Actions: plan — lay the route out (goal, optional why, stops: [{id, title, why, who}]); call it again when the route changes and reuse the ids, so stops keep their state.',
  'arrive — the session reaches a stop (id, note = why it is there; outcome = what came of the stop it leaves, required when moving forward).',
  'update — change a stop (id; state todo|done|skipped|blocked, with a note saying what came of it, why it is left out, or what is in the way; or just a fresh note, title, why or who).',
  'finish — close the journey; refused while any stop is todo, here or blocked. clear — drop it. show — read it back.',
  'who: claude (you do it), person (only they can decide or act), external (CI, a deploy, a review, someone else).',
  'Every call answers with the line as it now stands.',
].join(' ')

const STOP_PROPS = {
  id: { type: 'string', description: 'Short stable slug, unique on the line, e.g. "tests". Reuse it when you plan again.' },
  title: { type: 'string', description: 'What happens at this stop, in a few words.' },
  why: { type: 'string', description: 'Why the stop is on the line — what goes wrong without it.' },
  who: { type: 'string', enum: [...WHO], description: 'Who has to act: claude, person (a decision or action only they can take), external (CI, deploy, review).' },
  state: { type: 'string', enum: [...STATES], description: 'Where the stop stands. Leave out at plan time; the first stop starts as "here".' },
  note: { type: 'string', description: 'At "here": why the session is there. At done/skipped/blocked: what came of it, why it is left out, or what is in the way.' },
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS], description: 'What to do with the line.' },
    goal: { type: 'string', description: 'plan: what done means for this task.' },
    stops: {
      type: 'array',
      description: 'plan: every stop from now to done, in order; at least two, the last being the arrival.',
      items: { type: 'object', properties: STOP_PROPS, required: ['title'] },
    },
    ...STOP_PROPS,
    why: {
      type: 'string',
      description: 'plan: why the task matters (optional). update: why the stop is on the line.',
    },
    outcome: { type: 'string', description: 'arrive: what came of the stop you are leaving; required when moving forward from a "here" stop.' },
  },
  required: ['action'],
}

/** What the model reads back: the line as `result`; a refused move as `deny`, which it reads as an error. */
function answer(text: string, isError: boolean): { result: string } | { deny: string } {
  return isError ? { deny: text } : { result: text }
}

// ---- hooks -----------------------------------------------------------------------

export const register: Register = on => {
  let hasOpened = false

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({
      name: 'journey',
      description: 'The journey line — every step to close the task, where we are and why. "plan <goal>" asks Claude to lay it out',
      argumentHint: '[plan <goal> | clear]',
    })
    // a resumed session finds its route again
    const id = await sessionId($)
    if (id !== '' && (await read($, journey)) === null) {
      const stored = await $.store.get('lines')
      const kept = isKept(stored) ? stored[id] : undefined
      if (isLine(kept)) {
        await update($, journey, () => kept)
        $.ui.status(statusText(kept))
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await set($, null)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (e.traits.includes('bare')) return out
    return { sections: [...out.sections, { id: 'journey:line', text: PROMPT_SECTION, scope: 'session' as const }] }
  })

  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    if (e.agentId !== undefined) {
      return answer('The journey line belongs to the main conversation; a subagent leaves it alone — report back and let the main conversation move it.', true)
    }
    const now = new Date(await $.clock.now()).toISOString()
    const prev = await read($, journey)
    const out = apply(prev, e as unknown as Raw, now)
    if (out.changed) {
      await set($, out.line)
      if (out.line !== null && prev === null && !hasOpened) {
        hasOpened = true
        void $.ui.open({ id: PANE, title: TITLE })
      }
    }
    return answer(out.text, out.isError)
  }).catch(() => answer('journey: the line could not be updated (internal error) — carry on without it.', true))

  on('command.run', { command: 'journey' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const cmd = word.toLowerCase()
    if (cmd === 'clear') {
      await set($, null)
      return { text: 'Journey cleared.' }
    }
    if (cmd === 'plan') {
      const goal = rest.join(' ').trim()
      await $.ui.open({ id: PANE, title: TITLE })
      hasOpened = true
      try {
        await $.prompt.submit({
          text:
            `Lay out the journey for ${goal === '' ? 'the task we are on' : `this task: ${goal}`} with the journey line tool (${TOOL_NAME}, action "plan"): ` +
            'every stop from here to done, in order, each with why it is on the line and who acts (claude, person, external). Then arrive at the first stop.',
        })
        return { text: 'Asked Claude to lay out the route — it will appear in the pane.' }
      } catch {
        return { text: 'Could not queue the request — ask Claude to plan the journey with the journey line tool.' }
      }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    hasOpened = true
    return { text: describe(await read($, journey)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = await read($, journey)
    const width = Math.max(24, e.props.bodyColumns)
    const isDock = e.props.placement === 'dock'

    if (line === null) {
      return (
        <Box flexDirection="column" gap={1} width={width}>
          <Box gap={1} flexWrap="wrap">
            <Text bold>🚇 {TITLE}</Text>
            <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          </Box>
          <Text>No journey yet.</Text>
          <Text dimColor>
            When a task has more than a couple of steps, Claude lays it out here as a metro line: every stop from now to done, where the session is, and why.
          </Text>
          <Text dimColor>/journey plan {'<goal>'} asks Claude to draw it now.</Text>
        </Box>
      )
    }

    const p = progress(line)
    const isOver = line.closedAt !== null
    const barWidth = Math.max(8, Math.min(40, width - 16))
    const rows = layout(line, width, isDock)
    const next = line.stops[nextIndex(line)]
    const moves = line.log.slice(-MOVES_SHOWN).reverse()

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box gap={1} flexWrap="wrap">
          <Text bold>{isOver ? '🏁' : '🚇'} {TITLE}</Text>
          <Text dimColor>{p.passed} of {p.total} stops passed</Text>
          {isOver ? <Button key="clear" label="Clear" onPress={() => void set($, null)} /> : null}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>

        <Box flexDirection="column">
          <Text bold>{line.goal}</Text>
          {line.why !== '' ? <Text dimColor>{line.why}</Text> : null}
          <Text>
            <Text color={isOver ? 'success' : 'claude'}>{bar(p.passed, p.total, barWidth)}</Text>
            <Text bold> {Math.floor((p.passed / Math.max(1, p.total)) * 100)} %</Text>
          </Text>
        </Box>

        <Box flexDirection="column">
          {rows.map(r => (
            <Text wrap="truncate-end">
              <Text {...(r.track ? { color: r.track } : { dimColor: true })}>{r.gutter}</Text>
              {r.parts.map(part => (
                <Text {...textProps(part)}>{part.text}</Text>
              ))}
            </Text>
          ))}
        </Box>

        {isOver ? (
          <Text color="success">🏁 Arrived{line.closing !== '' ? ` — ${line.closing}` : ''}</Text>
        ) : next ? (
          <Text dimColor>Next stop: {next.title}</Text>
        ) : null}

        {isDock && moves.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor>Recent moves</Text>
            {moves.map(m => (
              <Text dimColor>
                {hhmm(m.at)} {m.text}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
