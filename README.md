# pi-extensions

Personal [pi coding agent](https://github.com/earendil-works/pi) extensions.

## Installation

```bash
pi install git:github.com/johan-stph/pi-extensions
```

Run `pi update` in any project to pick up changes.

> **Last tested:** 2026-06-07 — workflow validated ✅

## Extensions

### start-work

Creates an isolated git worktree from the latest main branch so agent work
doesn't interfere with your working copy. The agent calls this before any
file writes or edits.

**Tool:** `start_work` — callable by the LLM.

**Usage:**

```
/start-work add-auth
/start-work fix-bug-42
```

Worktrees are created at `<repo-root>/../pi-worktrees/<name>`. The LLM uses
the returned path for all subsequent file operations.

### create-mr

Creates a GitHub MR for the current branch and polls CI checks in the background.

**Tool:** `create_mr` — callable by the LLM. Also provides `check_ci` for re-checking CI status.

**Usage:**

```
/create-mr --description "Fix auth bug"
/create-mr --description "Add rate limiting" --base main --draft
```

**Requirements:** `gh` CLI installed and authenticated (`gh auth login`).

### new-work-check

Assesses workspace readiness before starting new work. The agent calls this
at the start of every new request before `start_work`.

**Tool:** `check_workspace` — callable by the LLM.

**What it does:**

1. Checks for uncommitted changes
2. Detects current branch (main vs feature)
3. Queries GitHub for MR status (merged / open / none)
4. **Happy path** (clean + no blockers): auto-switches to main, pulls latest, confirms readiness → agent proceeds to `start_work`
5. **Blocked path** (uncommitted changes, open MR, etc.): returns blockers → agent presents them to the user

**Requirements:** `gh` CLI for MR status checks (gracefully degrades without it).

## Adding new extensions

1. Create a subdirectory: `my-tool/index.ts`
2. Add it to `pi.extensions` in `package.json`: `"./my-tool/index.ts"`
3. Commit, push
