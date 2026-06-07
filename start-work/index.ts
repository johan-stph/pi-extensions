/**
 * start-work Extension
 *
 * Creates an isolated git worktree from the latest main branch so agent work
 * doesn't interfere with the user's normal workflow. Encouraged as the first
 * tool call before any file writes.
 *
 * Tool (LLM-callable):
 *   start_work(name)   — fetch origin, create worktree from default branch
 *
 * Command:
 *   /start-work <name> — same, user-initiated
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── git helpers ────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ stdout: "", stderr: "git not found", code: 1 }));
    child.on("close", (code: number | null) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }),
    );
  });
}

async function getDefaultBranch(cwd: string): Promise<string> {
  // Try to get the remote HEAD branch
  const { stdout, code } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (code === 0 && stdout) {
    return stdout.replace("refs/remotes/origin/", "").trim();
  }
  // Fallback: try common names
  for (const name of ["main", "master"]) {
    const { code: c } = await git(["rev-parse", "--verify", `origin/${name}`], cwd);
    if (c === 0) return name;
  }
  return "main";
}

async function getRepoRoot(cwd: string): Promise<string> {
  const { stdout, code } = await git(["rev-parse", "--show-toplevel"], cwd);
  if (code !== 0) throw new Error("Not in a git repository");
  return stdout.trim();
}

// ── Worktree creation ─────────────────────────────────────────────────────

interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  defaultBranch: string;
}

/**
 * Fetch origin, then create a new worktree from the default branch.
 */
async function startWork(
  cwd: string,
  name: string,
  onUpdate?: (update: { content: { type: "text"; text: string }[] }) => void,
): Promise<WorktreeInfo> {
  // 1. Find repo root
  onUpdate?.({ content: [{ type: "text", text: "Finding repo root..." }] });
  const repoRoot = await getRepoRoot(cwd);

  // 2. Fetch origin
  onUpdate?.({ content: [{ type: "text", text: "Fetching origin..." }] });
  const { stderr: fetchErr, code: fetchCode } = await git(["fetch", "origin"], repoRoot);
  if (fetchCode !== 0) throw new Error(`git fetch failed: ${fetchErr || "unknown error"}`);

  // 3. Determine default branch
  onUpdate?.({ content: [{ type: "text", text: "Determining default branch..." }] });
  const defaultBranch = await getDefaultBranch(repoRoot);

  // 4. Compute worktree path: <repo-root>/../pi-worktrees/<name>
  const worktreesDir = resolve(repoRoot, "..", "pi-worktrees");
  const worktreePath = resolve(worktreesDir, name);

  // 5. Create the worktree (starts in detached HEAD at origin/<defaultBranch>)
  onUpdate?.({ content: [{ type: "text", text: `Creating worktree at ${worktreePath} from ${defaultBranch}...` }] });
  const { stderr: addErr, code: addCode } = await git(
    ["worktree", "add", worktreePath, `origin/${defaultBranch}`],
    repoRoot,
  );
  if (addCode !== 0) {
    if (addErr?.includes("already exists") || addErr?.includes("already checked out")) {
      throw new Error(
        `Worktree "${name}" already exists at ${worktreePath}. Remove it first with: git worktree remove ${worktreePath}`,
      );
    }
    throw new Error(`git worktree add failed: ${addErr || "unknown error"}`);
  }

  // 6. Create a named branch in the worktree (escape detached HEAD)
  //    This ensures create_mr and other tools that need a branch name work correctly.
  onUpdate?.({ content: [{ type: "text", text: `Creating branch "${name}" in worktree...` }] });
  const { stderr: branchErr, code: branchCode } = await git(["checkout", "-b", name], worktreePath);
  if (branchCode !== 0) {
    throw new Error(`Failed to create branch "${name}" in worktree: ${branchErr || "unknown error"}`);
  }

  // 7. Push to origin to establish upstream tracking (no new commits —
  //    just sets the remote ref so the branch is tracked from the start).
  onUpdate?.({ content: [{ type: "text", text: `Pushing branch "${name}" to origin (establish tracking)...` }] });
  const { code: pushCode, stderr: pushErr } = await git(["push", "--set-upstream", "origin", name], worktreePath);
  if (pushCode !== 0) {
    // Non-fatal — agent's first real push will set tracking
    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Note: push to origin skipped (${pushErr || "no new commits"}). Tracking will be set on first real push.`,
        },
      ],
    });
  }

  return {
    name,
    path: worktreePath,
    branch: name,
    defaultBranch,
  };
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /start-work command ─────────────────────────────────────────────────

  pi.registerCommand("start-work", {
    description: "Create an isolated worktree from the latest main branch",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /start-work <name>", "error");
        return;
      }

      // Validate name: no spaces, no special chars
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
        ctx.ui.notify(
          "Worktree name must start with alphanumeric and contain only alphanumeric, dots, hyphens, underscores.",
          "error",
        );
        return;
      }

      ctx.ui.notify(`Creating worktree "${name}"...`, "info");

      try {
        const info = await startWork(ctx.cwd, name);
        ctx.ui.notify(`Worktree created: ${info.path}`, "info");
        pi.sendMessage({
          customType: "worktree-created",
          content: `Worktree "${info.name}" ready at \`${info.path}\` (branch: ${info.branch}). Use this path for all file operations.`,
          display: true,
          details: info,
        });
      } catch (e: any) {
        ctx.ui.notify(`Failed: ${e.message}`, "error");
      }
    },
  });

  // ── start_work tool ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "start_work",
    label: "Start Work",
    description:
      "Create an isolated git worktree from the latest default branch (main/master). " +
      "Fetches origin, then creates a new worktree at <repo-root>/../pi-worktrees/<name>. " +
      "This isolates agent work from the user's working copy. Call this before any file writes or edits when the user wants to create or modify something. " +
      "Returns the absolute path to the worktree — use it as the base for all subsequent file operations (read, write, edit, bash).",
    promptSnippet: "Start work: create isolated git worktree from latest main (call before file writes)",
    promptGuidelines: [
      "Call start_work before any file write/edit when the user wants to create or modify something. For purely investigative/read-only queries, you can skip it. Provide a short, descriptive name for the worktree (e.g., the feature or task name).",
      "After start_work returns, use the returned worktree path as the base for ALL subsequent file operations (read, write, edit, bash). Do NOT operate on files in the original repo directory — all changes go in the worktree.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short, descriptive name for the worktree (alphanumeric, dots, hyphens, underscores). Used as the directory name. E.g., 'add-auth', 'fix-bug-42', 'refactor-db'.",
      }),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      // Validate name
      if (!params.name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(params.name)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: name must start with alphanumeric and contain only alphanumeric, dots, hyphens, underscores.",
            },
          ],
          details: { error: "invalid name" },
          isError: true,
        };
      }

      try {
        const info = await startWork(ctx.cwd, params.name, onUpdate);

        return {
          content: [
            {
              type: "text",
              text:
                `Worktree "${info.name}" created successfully.\n\n` +
                `**Worktree path:** \`${info.path}\`\n` +
                `**Branch:** ${info.branch} (latest from origin)\n\n` +
                `Use this path as the base directory for all subsequent file operations (read, write, edit, bash). ` +
                `Do NOT operate on files in the original repo directory \`${ctx.cwd}\` — work exclusively in \`${info.path}\`.`,
            },
          ],
          details: info,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed to create worktree: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });
}
