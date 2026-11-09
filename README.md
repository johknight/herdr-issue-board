# Issue Board — a herdr plugin

A Kanban board of the focused repo's open GitHub issues, rendered as a full-screen TUI inside a
[herdr](https://herdr.dev) pane. Triage by moving tickets between label-backed columns, hand a single
ticket to a coding agent, or multi-select a batch and drive agent **skills** from a `/` palette —
including a prototype hand-off that posts screenshots back onto the tickets.

```
┌ herdr-issue-board · 34 open · 6 selected ─ space select · J/K extend · / slash · m actions ┐
│ Needs triage (5)  │ Needs info (2)    │ Ready for agent (9) │ Ready for human (3)        │
│ ▌#183 Board…      │  #188 Untriaged…  │  #185 Prototype…    │  #186 Screenshot…          │
└ ⠿ 6 selected · / for slash commands ───────────────────────────────────────────────────────┘
```

## Install

Needs `herdr >= 0.9.0`, [`bun`](https://bun.sh) and an authenticated [`gh`](https://cli.github.com).

```sh
git clone https://github.com/Jauki/herdr-issue-board.git
herdr plugin link ./herdr-issue-board
```

Bind a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "johknight.issue-board.open"
description = "issue board"
```

The board opens as an overlay pane for the repo of the pane that had focus.

## Board keys

| key | action |
| --- | --- |
| `←` `→` `↑` `↓` / `h` `j` `k` `l` | move the cursor (`pgup`/`pgdn`, `g`/`G` jump) |
| `space`, `x` | toggle the card in the multi-selection |
| `J`, `K` | grow the selection forward/backward, one card at a time |
| `A` | select (or unselect) every card in the focused column |
| `c` | clear the selection |
| `S` | type a selection spec: `183-192`, `183,185`, `label:bug`, `@user`, `all`, `none` |
| `/` | open the slash palette (`/report`, `/select`, `/attach`, then one entry per global skill) |
| `⏎` | ticket detail (body + comments) |
| `m`, `.`, right-click | action menu: implement in worktree / split pane, refine, slash, send to a running agent, move, browser (plus Review / Finish on wb-mapped cards under the wb launcher) |
| `r` | reload issues (also every 2 minutes) |
| `q` | quit |

Cards show the live agent badge (`◆ working|idle|blocked|done`) for agents the board started for them.

## The `/` palette

`/` lists the global agent skills found on disk — every `SKILL.md` under the dirs in
`skillDirs` (default `~/.agents/skills`, `~/.claude/skills`, `~/.opencode/skills`, plus the repo's
own `.agents/skills` and `.claude/skills`). The same list is on a card's `Slash` submenu.

- `/report` — instant local summary of the selection (no agent): per-column/label/assignee counts,
  staleness, the ticket list and the prompt an agent would get. `e` exports Markdown, `y` copies it,
  `a` hands the prompt to a new or running agent, `/` switches skill.
- `/select` — the `S` selection prompt.
- `/attach` — the prototype hand-off below.
- `/wb` — when the `wb` sandbox manager is installed: a read-only
  pool overview (see below). The entry hides itself entirely when wb is not on PATH.
- `/plan`, `/drafts`, `/orchestrate` — the plan & orchestrate surfaces below; hidden entirely
  while their config keys are off (the default).
- `/<skill>` — starts that skill on the **selected tickets**: creates a worktree on
  `slash/<range>-<skill>`, starts a herdr agent in it and prompts it with the skill, the ticket list
  and the branch, so the agent keeps every artefact there and leaves `main` alone.

Nothing selected? `/report` summarises all open tickets; `/<skill>` and `/attach` require an explicit
selection, so a stray keypress can never fan out to the whole backlog.

## Prototype → tickets

The flow this plugin was built around, for a batch like `#183–#192`:

1. Select the tickets (`/select` → `183-192`).
2. `/prototype` → new worktree, agent runs the Matt Pocock `prototype` skill for those tickets
   (`prompts.prototypeExtra` tells it to save one full-page PNG per variant under
   `prototype/screenshots/` and commit it on the branch).
3. When the prototype is done, select the same tickets on the board and run `/attach`. It picks the
   `slash/…` worktree for that range, commits and pushes any dirty artefacts, and comments on every
   ticket with the branch pointer plus the screenshots, so whoever implements the ticket sees exactly
   what to build.

Screenshots are linked as `raw.githubusercontent.com` URLs, which GitHub's image proxy can only fetch
from a public repo — on a private repo the comment lands with the branch pointer and file list but the
inline images stay blank.

## wb visibility

When the `wb` sandbox manager is installed, the board shows
its pool read-only — wb stays the execution engine, the board only watches:

- **Card badge** — `▣` on a ticket with a wb pool worktree, `▣●` when that worktree also has
  uncommitted tracked changes. Refreshed on the board's cycle (`r` and every 2 minutes), after the
  live agent badge.
- **`/wb`** — a report-style pool overview, per task: id, branch, engine (from the repo's
  `.wb.json`, `?` when unset), session count and a dirty marker. The footer prints the host commands
  you would run next (`wb diff <task>`, `wb finish <task>`) — printed, never executed.

Ticket ↔ task ids are derived, not configured: `issue-<n>` for a single ticket, `issues-<numbers>-<skill>`
for a skill run over a selection (`issues-183-192-prototype`, `issues-183-185-190-refine` — the same
selection always recomputes the same id). They resolve through pool branches `wb/<task>` and
`agent/tree-<task>`; tasks without an issue number (`hello-world`) appear in `/wb` but never on a card.

Hide both surfaces with `"wb": { "enabled": false }` — and when wb is not installed at all, the board
behaves exactly as it does without this section.

## wb as the launch engine

With `"launcher": "wb"` the board hands its actions to wb instead of starting herdr agents itself:
`Enter→Implement` (the `i` key) and `/<skill>` runs start sandboxed wb tasks on the derived task ids,
so every agent lands in a pool worktree under wb's safehouse fence with the ticket prompt as its
first message. Configured but wb missing from PATH? The actions fall back to the herdr launcher
with a one-line notice — never a hard failure mid-selection.

```json
"wb": { "enabled": true, "launcher": "wb", "agent": "pi" }
```

- **Task ids** are the derived ones above (`issue-<n>` for implement, `issues-<range>-<skill>` for
  a skill run), so `/attach` and the Review/Finish menu recompute the same task from the selection.
- **Serial repos** cannot parallelise a fan-out: a multi-ticket `/<skill>` run on a `serial`-mode
  repo is refused up front with a hint (`wb mode tree`); a single-ticket implement rotates the
  serial worktree, and a dirty serial worktree surfaces wb's own abort line in the notice.
- **`/attach`** commits dirty artefacts locally (host-side git, no network), then asks
  `push <branch> to origin? [y/N]` — `y` pushes via consented `wb publish` (the only push path on
  this launcher), `n` skips the push but still comments with the branch pointer and file list.
- **Review / Finish** (card `m` menu, only on cards that map to a wb task): Review shows
  `wb diff <task>` in a scrollable, read-only overlay; Finish picks `merge`, `squash` or `kill`
  and asks an explicit confirm naming the consequence and the parent branch. The consented
  `wb finish` is **local-only** — the task branch merges into the local parent and the worktree
  is torn down; no push, no remote delete, ever (`wb publish` remains the only push path).

Under the default `"launcher": "herdr"` the board's flow (worktrees, `slash/*` branches, the
automatic `/attach` push) is unchanged.

## Plan & orchestrate

Two optional surfaces turn the board into the cockpit for the whole work-execution loop. Both are
off by default and hidden entirely while their config keys are unset:

```json
"plan": { "enabled": true },
"orchestrate": { "enabled": true }
```

- **`/plan`** — start the planning loop at any stage. A submenu lists the configured
  `plan.stages` (Spark, Grill, To spec, To tickets, Rephrase, Free-form by default — the table
  replaces wholesale when you provide your own); pick one, type the idea or instruction at the
  inline prompt (empty is fine when selected tickets carry the context), and a conversational
  agent starts in a split pane with the stage prompt, the idea and the selection. One `/plan` is
  one stage launch — the board never chains stages; you steer the agent live in its pane. Every
  stage prompt ends with the local-fallback contract: tickets are drafted as local markdown under
  `.scratch/<slug>/issues/` (one `<NN>-<slug>.md` per ticket in dependency order, blockers first;
  rephrase proposals as `rephrase-<n>-<slug>.md`), and the agent does NOT touch GitHub.
- **`/drafts`** — review what the planning agent drafted. The overlay lists every draft found
  under `.scratch/<cluster>/issues/` (tickets as `#NN slug`, rephrases as `rephrase #n`, with
  title, cluster and the cursor row's path). `space` toggles accept/skip (all start accepted),
  `r` re-collects, `e` opens the file in `$EDITOR` (no `$EDITOR` → the path is copied to the
  clipboard), `esc` returns to the board with state intact.
- **`c` in the overlay is the only GitHub write this feature performs**: one explicit
  `create N issues and update M tickets on <repo>? [y/N]` consent. `y` creates the accepted
  ticket drafts as issues in `NN` order (blockers get the lower numbers) with the first column's
  label plus `cluster-<slug>`, and applies accepted rephrase drafts as the new body of their
  issue — bodies travel as `--body-file` paths, never argv. A label missing from the repo is
  skipped and named in the notice, never created. Anything other than `y` — including `esc` —
  changes nothing: "nothing created — drafts kept". Afterwards the new cards select via
  `S` → `label:cluster-<slug>` and fan out via any `/{skill}`.
- **`/orchestrate`** — run a sprint over the selection. Requires an explicit selection; the
  board collects each ticket's number/title/labels/body into one context file under
  `.scratch/orchestrate/<range>-<stamp>.md` and launches a HOST orchestrator agent in a split
  pane whose first prompt names the file and the pipeline contract: plan first (rephrases and
  restructuring as proposals — read-only on GitHub), dispatch workers via `wb start issue-<n>`
  (batches as `issues-<range>-<slug>`) into wb sandboxes where badges, Review, Finish and
  `/attach` apply unchanged, and finish only after your explicit yes. Replans are propose-only:
  markdown in the pane and/or files under `.scratch/`, applied through the existing flows
  (`/plan` → Rephrase, the `Refine ticket with agent` action).

**Trust model:** the planning and orchestrator agents run on the host in herdr panes, supervised
by you live — they are not sandboxed (a sandboxed orchestrator could not fan out `wb start`
itself). Their "do not touch GitHub" instructions are prompts, not fences; the board's consent
invariant covers board-initiated mutations only. Every GitHub mutation the board makes sits
behind the explicit y/N above, and the only push path anywhere remains consented `wb publish`.

## Configuration

`$HERDR_PLUGIN_CONFIG_DIR/config.json` overlays the defaults (`columns` replaces, everything else merges):

```json
{
  "agent": "omp",
  "columns": [
    { "title": "Needs triage", "label": "needs-triage" },
    { "title": "Ready for agent", "label": "ready-for-agent" }
  ],
  "skillDirs": ["~/.agents/skills"],
  "prototype": { "skill": "prototype", "branchPrefix": "slash/", "dir": "prototype" },
  "wb": { "enabled": true, "launcher": "wb", "agent": "pi" },
  "prompts": {
    "implement": "Implement GitHub issue #{number} in {repo}: \"{title}\" ({url})."
  }
}
```

Prompt placeholders — `implement`/`refine`: `{number} {title} {repo} {url} {branch}`;
`skill`: `{skill} {skillPath} {count} {repo} {tickets} {list} {branch} {range} {extra}`.

## Layout

| file | role |
| --- | --- |
| `src/board.ts` | the TUI: layout, render, hit-testing, input, actions |
| `src/config.ts` | config types, defaults, `{placeholder}` filling |
| `src/report.ts` | report blocks + Markdown export (pure, no TTY) |
| `src/selection.ts` | selection-spec parsing, range labels |
| `src/skills.ts` | `SKILL.md` discovery |
| `src/prototype.ts` | worktree lookup, artefact publish, ticket comments |
| `src/wb.ts` | wb adapter: pool worktrees, sessions, `.wb.json`, task-id mapping, launcher + `wb start/publish/diff/finish` wiring |
| `src/drafts.ts` | to-tickets local-draft scan + parse (the `/drafts` data source) |
| `src/orchestrate.ts` | orchestrator context builder + `.scratch/orchestrate/` context files |
| `src/github.ts` | `gh` wrappers (issues, labels, detail) |
| `src/herdr.ts` | `herdr` CLI wrappers (panes, worktrees, agents) |
| `src/proc.ts` | process + clipboard helpers |

## License

MIT
