# journey — a metro line for the task in hand

Every stop from now to done, which stop the session is at, and **why** — drawn as a metro line in a
pane, and pinned in the status line under the prompt.

<p align="center"><img src="docs/screenshot.png" width="640" alt="The journey pane: three passed stops with what came of each, the current stop marked YOU ARE HERE with why the session is there, a stop flagged your call, and the status line under the prompt"></p>

<sub>The pane and the status line for a sample task, drawn by the mod's own layout code.</sub>

Green is where the session has been, dim is where it has not. `◉` is where it is now. `👤 your call`
marks a stop only the person can pass; `⏳ waiting on others` one that waits on CI, a deploy or a
review.

## Why you would want it

A long task in Claude Code is a wall of scrolling text. You come back after ten minutes and cannot
tell what is finished, what Claude is doing now, or whether it is waiting on you. journey answers
those three questions at a glance:

- **What is done, and what came of it.** A stop is never ticked without saying what it produced.
- **Where the session is, and why.** The current stop says why Claude is there and why the stop exists.
- **Who has to act next.** Stops only you can pass say `👤 your call`; stops waiting on CI or a review
  say `⏳ waiting on others`.

It also keeps Claude honest: the whole route is laid out before the work starts, so a skipped step
shows up as `⚠ passed, not marked` instead of disappearing.

## Install

In Claude Code 2.1.275 or later:

```
/plugin install journey --marketplace AhmedQureshi89/mods
```

Or from a shell, in two steps:

```
claude plugin marketplace add AhmedQureshi89/mods
claude plugin install journey@ahmed-mods
```

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

## License

MIT — see [LICENSE](../LICENSE).
