/**
 * check-workspace Extension
 *
 * Before starting new work, assesses the current git workspace state.
 * Detects uncommitted changes, identifies feature branches, checks
 * MR merge status, and either:
 *   → happy path: auto checkout main, pull latest, suggest start_work
 *   → blocked:     report blockers so the agent can ask the user
 *
 * Tool (LLM-callable):
 *   check_workspace() — assess readiness and auto-clean on happy path
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── helpers ────────────────────────────────────────────────────────────────

type SpawnResult = { stdout: string; stderr: string; code: number };

function run(cmd: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ stdout: "", stderr: `${cmd} not found`, code: 1 }));
    child.on("close", (code: number | null) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }),
    );
  });
}

function git(args: string[], cwd: string) {
  return run("git", args, cwd);
}
function gh(args: string[], cwd: string) {
  return run("gh", args, cwd);
}

// ── types ──────────────────────────────────────────────────────────────────

type MrStatus = "merged" | "open" | "none" | "unknown";

interface WorkspaceStatus {
  readyForNewWork: boolean;
  currentBranch: string;
  defaultBranch: string;
  isDefaultBranch: boolean;
  hasUncommittedChanges: boolean;
  uncommittedFiles: string[];
  mrStatus: MrStatus;
  mrUrl: string | null;
  blockers: string[];
  actionsTaken: string[];
  suggestedAction: string;
}

// ── main logic ─────────────────────────────────────────────────────────────

/** Detect the default branch name (main or master). */
async function getDefaultBranch(cwd: string): Promise<string> {
  const { stdout, code } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (code === 0 && stdout) {
    return stdout.replace("refs/remotes/origin/", "").trim();
  }
  // fallback: try common names
  for (const name of ["main", "master"]) {
    const { code: c } = await git(["rev-parse", "--verify", `origin/${name}`], cwd);
    if (c === 0) return name;
  }
  return "main";
}

async function checkWorkspace(cwd: string): Promise<WorkspaceStatus> {
  const blockers: string[] = [];
  const actionsTaken: string[] = [];

  // ── 1. Detect default branch ──────────────────────────────────────────
  const defaultBranch = await getDefaultBranch(cwd);

  // ── 2. Get current branch ─────────────────────────────────────────────
  const { stdout: branch } = await git(["branch", "--show-current"], cwd);
  const currentBranch = branch || "unknown";
  const isDefaultBranch = currentBranch === "main" || currentBranch === "master";

  // ── 3. Check for uncommitted changes ──────────────────────────────────
  const { stdout: statusOut } = await git(["status", "--porcelain"], cwd);
  const uncommittedFiles = statusOut
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());
  const hasUncommittedChanges = uncommittedFiles.length > 0;

  if (hasUncommittedChanges) {
    blockers.push(
      `${uncommittedFiles.length} uncommitted file(s): ${uncommittedFiles.slice(0, 5).join(", ")}${uncommittedFiles.length > 5 ? " …" : ""}`,
    );
  }

  // ── 4. Feature branch: check MR status ────────────────────────────────
  let mrStatus: MrStatus = "none";
  let mrUrl: string | null = null;
  let ghAvailable = false;
  {
    const { code } = await gh(["--version"], cwd);
    ghAvailable = code === 0;
  }

  if (!isDefaultBranch) {
    // Does this branch exist on the remote?
    const { code: remoteCode } = await git(["rev-parse", "--verify", `origin/${currentBranch}`], cwd);

    if (remoteCode === 0 && ghAvailable) {
      const { stdout: mergedOut } = await gh(
        ["pr", "list", "--head", currentBranch, "--state", "merged", "--json", "number,url", "--limit", "1"],
        cwd,
      );
      const { stdout: openOut } = await gh(
        ["pr", "list", "--head", currentBranch, "--state", "open", "--json", "number,url", "--limit", "1"],
        cwd,
      );

      let mergedPrs: { number: number; url: string }[] = [];
      let openPrs: { number: number; url: string }[] = [];
      try {
        mergedPrs = JSON.parse(mergedOut);
      } catch {
        /* ok */
      }
      try {
        openPrs = JSON.parse(openOut);
      } catch {
        /* ok */
      }

      if (mergedPrs.length > 0) {
        mrStatus = "merged";
        mrUrl = mergedPrs[0].url;
      } else if (openPrs.length > 0) {
        mrStatus = "open";
        mrUrl = openPrs[0].url;
        blockers.push(`MR !${openPrs[0].number} is still open (not merged): ${openPrs[0].url}`);
      }
      // else: branch on remote but no PR → "none"
    } else if (!ghAvailable) {
      mrStatus = "unknown";
    }
    // else: branch only local → "none"
  }

  // ── 5. Happy path: auto-switch to default branch and pull ─────────────
  const readyForNewWork = blockers.length === 0;

  if (readyForNewWork) {
    // If not already on default branch, switch to it
    if (!isDefaultBranch) {
      const { code: coCode, stderr: coErr } = await git(["checkout", defaultBranch], cwd);
      if (coCode === 0) {
        actionsTaken.push(`Switched to ${defaultBranch}`);
      } else {
        blockers.push(`Could not checkout ${defaultBranch}: ${coErr}`);
      }
    }

    // Pull latest
    if (blockers.length === 0) {
      const { code: pullCode, stderr: pullErr } = await git(["pull", "origin", defaultBranch], cwd);
      if (pullCode === 0) {
        actionsTaken.push(`Pulled latest ${defaultBranch}`);
      } else {
        // Non-fatal: might just be up to date
        actionsTaken.push(`git pull: ${pullErr || "up to date"}`);
      }
    }
  }

  // Re-check readiness after auto-actions
  const finalReady = blockers.length === 0;

  // ── 6. Build suggested action ─────────────────────────────────────────
  let suggestedAction: string;
  if (finalReady) {
    suggestedAction = "Workspace is clean and on latest default branch. Call start_work for the new task.";
  } else if (hasUncommittedChanges && mrStatus === "open") {
    suggestedAction =
      "Uncommitted changes on feature branch with open MR. Ask user: stash/discard changes? Wait for MR to merge?";
  } else if (hasUncommittedChanges) {
    suggestedAction = "Uncommitted changes present. Ask user: stash, commit, or discard?";
  } else if (mrStatus === "open") {
    suggestedAction = "Open MR on feature branch. Ask user: close MR? Wait for merge? Switch branches?";
  } else if (mrStatus === "unknown") {
    suggestedAction = "gh CLI not available — cannot check MR status. Ask user about feature branch intentions.";
  } else {
    suggestedAction = "Blockers found. Present to user and ask how to proceed.";
  }

  return {
    readyForNewWork: finalReady,
    currentBranch,
    defaultBranch,
    isDefaultBranch,
    hasUncommittedChanges,
    uncommittedFiles: uncommittedFiles.slice(0, 20),
    mrStatus,
    mrUrl,
    blockers,
    actionsTaken,
    suggestedAction,
  };
}

// ── extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_workspace",
    label: "Check Workspace",
    description:
      "Check if the current git workspace is ready for new work. " +
      "Detects uncommitted changes, identifies feature branches, checks MR merge status. " +
      "On happy path: auto-switches to main, pulls latest, and confirms readiness for start_work. " +
      "On blocked path: returns blockers so the agent can present them to the user.",
    promptSnippet: "Check workspace readiness for new work (call before start_work on new requests)",
    promptGuidelines: [
      "Call check_workspace at the start of every new user request, before start_work. " +
        "If readyForNewWork is true: the workspace has been auto-cleaned (switched to main, pulled) — proceed to call start_work. " +
        "If readyForNewWork is false: present the blockers to the user and ask how they want to proceed. " +
        "Do NOT call start_work when readyForNewWork is false.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Checking workspace state…" }] });

      try {
        const status = await checkWorkspace(ctx.cwd);

        let text = "";
        if (status.readyForNewWork) {
          text = `✅ Workspace is ready for new work.\n\n`;
          text += `**Branch:** \`${status.defaultBranch}\` (was \`${status.currentBranch}\`)\n`;
          if (status.actionsTaken.length > 0) {
            text += `**Actions taken:**\n`;
            for (const a of status.actionsTaken) {
              text += `- ${a}\n`;
            }
          }
          text += `**Uncommitted:** none\n`;
          if (status.mrStatus === "merged") {
            text += `**MR:** merged (${status.mrUrl})\n`;
          }
          text += `\n${status.suggestedAction}`;
        } else {
          text = `⚠️ Workspace is NOT ready for new work.\n\n`;
          text += `**Branch:** \`${status.currentBranch}\`\n`;
          text += `**Uncommitted changes:** ${status.hasUncommittedChanges ? `yes (${status.uncommittedFiles.length} files)` : "none"}\n`;
          if (status.mrStatus === "open") {
            text += `**MR:** open (${status.mrUrl})\n`;
          } else if (status.mrStatus === "merged") {
            text += `**MR:** merged (${status.mrUrl})\n`;
          } else if (status.mrStatus === "unknown") {
            text += `**MR:** unknown (gh CLI unavailable)\n`;
          }
          text += `\n**Blockers:**\n`;
          for (const b of status.blockers) {
            text += `- ${b}\n`;
          }
          text += `\n**Suggested:** ${status.suggestedAction}\n`;
          text += `\nPresent these blockers to the user and ask how to proceed.`;
        }

        return {
          content: [{ type: "text", text }],
          details: status,
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to check workspace: ${e.message}`,
            },
          ],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });
}
