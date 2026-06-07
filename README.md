# pi-extensions

Personal pi coding agent extensions.

> **Last tested:** 2026-06-07 — workflow validated ✅

## Extensions

### start-work

Creates an isolated git worktree from the latest main branch so agent work doesn't interfere with the user's working copy. Encouraged as the first tool call before any file writes.

**Tool:** `start_work` — callable by the LLM.

**Usage:**

```
/start-work add-auth
/start-work fix-bug-42
```

Worktrees are created at `<repo-root>/../pi-worktrees/<name>`. The LLM is instructed to use the returned path for all subsequent file operations.

### create-mr

Creates a GitHub MR for the current branch and polls CI checks in the background.

**Install:**

```bash
pi install git:github.com/johan-stph/pi-extensions
```

**Usage:**

```
/create-mr --description "Fix auth bug"
/create-mr --description "Add rate limiting" --base main --draft
```

Or let the agent call the `create_mr` tool directly — it also provides `check_ci` for re-checking CI status.

**Requirements:** `gh` CLI installed and authenticated (`gh auth login`).

### new-work-check

Assesses workspace readiness before starting new work. Called by the LLM at the start of every new user request before `start_work`.

**Tool:** `check_workspace` — callable by the LLM.

**What it does:**

1. Checks for uncommitted changes
2. Detects current branch (main vs feature)
3. Queries GitHub for MR status (merged / open / none)
4. **Happy path** (clean + no blockers): auto-switches to main, pulls latest, confirms readiness → LLM proceeds to `start_work`
5. **Blocked path** (uncommitted changes, open MR, etc.): returns blockers → LLM presents them to the user

**Requirements:** `gh` CLI for MR status checks (gracefully degrades without it).

## Adding new extensions

1. Create a subdirectory: `my-tool/index.ts`
2. Add it to `pi.extensions` in `package.json`: `"./my-tool/index.ts"`
3. Commit, push — `pi update` in any project to pick it up
