# pi-extensions

Personal pi coding agent extensions.

## Extensions

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

## Adding new extensions

1. Create a subdirectory: `my-tool/index.ts`
2. Add it to `pi.extensions` in `package.json`: `"./my-tool/index.ts"`
3. Commit, push — `pi update` in any project to pick it up
