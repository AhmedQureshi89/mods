# journey — a metro line for the task in hand

Every stop from now to done, which stop the session is at, and **why** — drawn as a metro line in a
pane, and pinned in the status line under the prompt.

```
 ●  Read the roadmap row and the inbox note
 │    ✓ both say "no holiday calendar"
 │
 ●  Merge PR #146
 │    ✓ Merged by Ahmed
 │
 ◉  Deploy and read the clock back      ⏳ waiting on others
 │     YOU ARE HERE   since 13:41
 │    Why here: merged as 5919019; the clock is not read back yet
 │    Why this stop: CI does not deploy in this repo
 │
 ○  Record it in the hub                 (dim: not reached)
 │
 ○  🏁 Close the note and offer to archive
```

Green is where the session has been, dim is where it has not. `◉` is where it is now. `👤 your call`
marks a stop only the person can pass; `⏳ waiting on others` one that waits on CI, a deploy or a
review.

## How it is fed

Claude draws the line; the mod does not guess. It registers a tool, `mcp__journey__line`, and adds a
short section to the system prompt so Claude lays the route out before a task with more than a couple
of steps, then keeps it true.

| Action | What it does | What it insists on |
|---|---|---|
| `plan` | Lays the route: a goal and every stop (`id`, `title`, `why`, `who`). Called again when the route changes — stops keep their state by id, or by title. | a goal; at least two stops |
| `arrive` | The session reaches a stop. | `note` — why it is there. Moving forward also needs `outcome` — what came of the stop left. |
| `update` | Changes a stop. | `done`, `skipped` and `blocked` each need a `note`: a stop is never ticked without saying what came of it. |
| `finish` | Closes the journey. | refused while any stop is still `todo`, `here` or `blocked` |
| `clear` · `show` | Drops it · reads it back. | |

A stop the session jumped past without marking is flagged `⚠ passed, not marked` rather than quietly
counted.

## Commands

| | |
|---|---|
| `/journey` | Opens the pane and prints the line as text. |
| `/journey plan <goal>` | Asks Claude to lay the route out for that goal (or for the task in hand). |
| `/journey clear` | Drops the journey. |

## What it keeps

The route lives in the session's state (it survives a reload of the mod) and in the mod's store under
the session's id, so a resumed session finds it again; the newest ten journeys are kept. The mod reads
and writes nothing else — no files, no processes, no network.

## Working on it

```
claude plugin validate journey
claude plugin test     journey
```

`hooks/register.tsx` exports the pure parts (`apply`, `describe`, `layout`, `wrap`, `statusText`) so
`hooks/register.test.tsx` tests the rules and the layout without a session.
