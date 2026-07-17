This page explains how work is tracked in this repo with **bd (beads)**, the commands you will use, and the workflow rules. GitHub Issues is retired; all task tracking lives in beads. For how bead references appear in commits and PRs, see [[Dev Contributing]].

## What beads is

Beads is an issue tracker whose data lives in a **local Dolt database** (Dolt is a versioned SQL database). Key facts about how it is wired here:

- Issues live in the Dolt DB under `.beads/embeddeddolt/`.
- Sync between machines happens over a **`refs/dolt/data`** ref on the git remote — not through the normal branches.
- `.beads/issues.jsonl` is a **passive export** (a snapshot for humans and diffs), not the source of truth. Do not edit it by hand expecting changes to take.

Run `bd prime` at the start of every session to load the full workflow context and command reference. See the [beads sync concepts](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md) for the architecture and anti-patterns.

## Essential commands

```bash
bd prime                 # load full workflow context — run first, every session
bd ready                 # list unblocked, ready-to-work issues
bd show <id>             # full detail: description, labels, deps, notes
bd create                # create a new issue
bd update <id> --claim   # atomically claim an issue before starting
bd close <id>            # mark done
bd dep <id> ...          # manage blocking / related dependencies
bd stats                 # open / blocked / closed / ready counts
bd list --status=open    # full open backlog
bd search <query>        # find issues by text
bd remember              # persist durable knowledge (replaces MEMORY.md notes)
```

Syncing to the remote is a separate, deliberate step:

```bash
bd dolt push             # push the local Dolt DB to refs/dolt/data on the remote
bd dolt pull             # pull remote bead data
```

## Priorities, types, labels

- **Priorities** run **P0 (most urgent) through P4**.
- **Types**: `epic`, `feature`, `bug`, `chore`, `task`.
- **Labels** categorize work, for example `area:dev-env`, `type:friction`.
- Issues carry dependency links (blocking or related) and free-text, timestamped `notes`.

## Workflow rules

- **Create the bead before you write code.** The bead is the unit of work; branch names and commits reference its id.
- **Use `bd` for all task tracking** — not TodoWrite, not a markdown TODO list.
- **Claim before starting**: `bd update <id> --claim` so parallel sessions do not collide.
- **Do not use `bd edit`** to hand-edit issue internals; use the structured commands (`update`, `dep`, `close`, `remember`).
- **Use `bd remember` for durable knowledge**, not a MEMORY.md file.
- Reference the bead id in commits and PRs (see [[Dev Contributing]]), never `Closes #N`.

## Git and sync policy

The repo defines agent context profiles. The default is **conservative**: use `bd` for tracking, but do **not** run `git commit`, `git push`, or `bd dolt push` unless explicitly asked. Only the **team-maintainer** profile (an explicit opt-in) may commit, push, and sync as part of session close. A current "do not commit / do not push" instruction always wins. When a required push is blocked, stop and report the exact command and error rather than forcing it.

## Session-close protocol

When you finish a work session that changed code:

1. **File beads for remaining work** — anything that needs follow-up.
2. **Run the quality gates** — `yarn lint`, `yarn build`, `yarn test` (see [[Dev Contributing]]).
3. **Update issue status** — close finished beads, update in-progress ones.
4. **Handle git/sync by the active profile** — conservative reports status and proposed commands and waits; team-maintainer may `git pull --rebase`, push, and `bd dolt push`.
5. **Hand off** — summarize changed files, validation results, issue status, and any blocked sync step.

## Milestone epic structure

Work is organized as one epic per milestone plus loose hardening items. The milestones (`M1` Foundation through `M6` Post-launch hardening) are largely built even where their epics still show open — an epic stays open while follow-up children under it are open, not because the milestone has not started. A separate Layer 2 test-harness epic (`wh5`) carries numbered children. When you plan a new chunk of work, hang typed children off the relevant epic rather than creating loose top-level issues.

## Anti-patterns

- Do not edit `.beads/issues.jsonl` by hand — it is an export, not the database.
- Do not treat the git branches as the bead sync channel — bead data travels on `refs/dolt/data`.
- Do not push Dolt data under the conservative profile without being asked.
- Do not track tasks outside bd (no markdown TODOs, no TaskCreate).

## Related pages

- [[Dev Contributing]]
- [[Dev Testing]]
- [[Dev Architecture]]
