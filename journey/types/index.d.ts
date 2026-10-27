/** Where a stop stands on the line. */
export type StopState =
  /** Not reached yet. */
  | 'todo'
  /** The session is at this stop now. At most one stop is `here`. */
  | 'here'
  /** Passed, and what came of it is in `note`. */
  | 'done'
  /** Left out on purpose; `note` says why. */
  | 'skipped'
  /** Cannot move on from here; `note` says what is in the way. */
  | 'blocked'

/** Who has to act for the line to move past a stop. */
export type Who =
  /** Claude does the work. */
  | 'claude'
  /** A decision or action only the person can make. */
  | 'person'
  /** Something outside the session: CI, a deploy, a review, someone else. */
  | 'external'

/** One station on the line. */
export type Stop = {
  /** A short slug, unique on the line; how the model names the stop in later calls. */
  id: string
  title: string
  /** Why the stop is on the line — what would go wrong without it. */
  why: string
  state: StopState
  who: Who
  /**
   * At `here`: why the session is at this stop right now. At `done`: what came of it.
   * At `skipped` and `blocked`: the reason. Empty at `todo`.
   */
  note: string
  /** When the session last arrived here, ISO 8601; null if it never has. */
  at: string | null
}

/** One line of the log: a move, with when. */
export type Move = {
  at: string
  text: string
}

/** The journey: the goal, the stops in order, and what has happened on the way. */
export type Line = {
  /** What "done" is for this task. */
  goal: string
  /** Why the task matters; may be empty. */
  why: string
  stops: Stop[]
  startedAt: string
  updatedAt: string
  /** When the journey arrived; null while it is under way. */
  closedAt: string | null
  /** What the arrival came to; empty until `closedAt` is set. */
  closing: string
  /** The last moves, oldest first. */
  log: Move[]
}

declare module 'claude-code' {
  interface PluginState {
    journey: { line: Line | null }
  }
}
