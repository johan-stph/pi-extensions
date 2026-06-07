/**
 * Create MR & Poll CI Extension
 *
 * Creates a GitHub merge request for the current branch, polls CI checks in
 * the background, and delivers results as a follow-up message — no sleep/poll
 * blocking in the agent loop.
 *
 *   /create-mr --description "Fix auth bug"
 *   /create-mr --description "Add rate limiting" --base main --draft
 *
 * Tools (LLM-callable):
 *   create_mr(description, base?, draft?)   — create MR + start CI polling
 *   check_ci(mrNumber)                      — re-check CI for an existing MR
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── gh CLI helper ──────────────────────────────────────────────────────────

function gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ stdout: "", stderr: "gh not found", code: 1 }));
    child.on("close", (code: number | null) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }),
    );
  });
}

async function preflight(cwd: string): Promise<string | null> {
  const { code } = await gh(["--version"], cwd);
  if (code !== 0) return "GitHub CLI (`gh`) not found. Install from https://cli.github.com/";
  const { code: ac } = await gh(["auth", "status"], cwd);
  if (ac !== 0) return "Not authenticated with `gh`. Run `gh auth login`.";
  const { code: rc } = await gh(["repo", "view", "--json", "name"], cwd);
  if (rc !== 0) return "Not in a GitHub repository (or no remote configured).";
  return null;
}

// ── MR creation ────────────────────────────────────────────────────────────

interface MrInfo {
  number: number;
  url: string;
  title: string;
  base: string;
  head: string;
  draft: boolean;
}

/**
 * Create a PR via `gh pr create` (no --json support on older gh).
 * We pass --title and --body and parse the URL from stdout.
 */
async function createMr(cwd: string, description: string, base?: string, draft?: boolean): Promise<MrInfo> {
  const args = ["pr", "create"];

  const nl = description.indexOf("\n");
  const title = (nl === -1 ? description : description.slice(0, nl)).slice(0, 256);
  const body = nl === -1 ? undefined : description.slice(nl + 1).trim();

  args.push("--title", title);
  if (body) args.push("--body", body);
  if (base) args.push("--base", base);
  if (draft) args.push("--draft");

  const { stdout, stderr, code } = await gh(args, cwd);
  if (code !== 0) throw new Error(`gh pr create failed: ${stderr || "unknown error"}`);

  // gh prints the PR URL on success — extract it
  const urlMatch = stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
  const url = urlMatch?.[0] ?? "";
  const numMatch = url.match(/\/pull\/(\d+)/);
  const number = numMatch ? Number(numMatch[1]) : 0;

  if (!url || !number) throw new Error(`Could not parse PR URL from gh output: ${stdout}`);

  // Get additional info via gh pr view
  const { stdout: viewOut } = await gh(
    ["pr", "view", String(number), "--json", "title,baseRefName,headRefName,isDraft"],
    cwd,
  );
  let view: Record<string, unknown> = {};
  try {
    view = JSON.parse(viewOut);
  } catch {
    /* keep defaults */
  }

  return {
    number,
    url,
    title: (view.title as string) ?? title,
    base: (view.baseRefName as string) ?? base ?? "main",
    head: (view.headRefName as string) ?? "",
    draft: (view.isDraft as boolean) ?? draft ?? false,
  };
}

// ── CI checks ──────────────────────────────────────────────────────────────

interface CiCheck {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" | "";
  state: string;
  link: string;
  completedAt: string | null;
  startedAt: string | null;
  workflow: string | null;
  event: string | null;
  description: string | null;
}

interface CiReport {
  mrNumber: number;
  mrUrl: string;
  checks: CiCheck[];
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  total: number;
  verdict: "PASSED" | "FAILED" | "PENDING" | "UNKNOWN";
  polledAt: string;
}

async function fetchChecks(mrNumber: number, cwd: string): Promise<CiCheck[]> {
  const { stdout, code } = await gh(
    [
      "pr",
      "checks",
      String(mrNumber),
      "--json",
      "name,bucket,state,link,completedAt,startedAt,workflow,event,description",
    ],
    cwd,
  );
  if (code !== 0 || !stdout) return [];
  try {
    return JSON.parse(stdout) as CiCheck[];
  } catch {
    return [];
  }
}

function buildReport(mr: MrInfo, checks: CiCheck[]): CiReport {
  const passed = checks.filter((c) => c.bucket === "pass").length;
  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").length;
  const pending = checks.filter((c) => c.bucket === "pending" || c.bucket === "").length;
  const skipped = checks.filter((c) => c.bucket === "skipping").length;

  let verdict: CiReport["verdict"];
  if (checks.length === 0) verdict = "UNKNOWN";
  else if (pending > 0) verdict = "PENDING";
  else if (failed > 0) verdict = "FAILED";
  else verdict = "PASSED";

  return {
    mrNumber: mr.number,
    mrUrl: mr.url,
    checks,
    passed,
    failed,
    pending,
    skipped,
    total: checks.length,
    verdict,
    polledAt: new Date().toISOString(),
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatMd(report: CiReport): string {
  const icon =
    report.verdict === "PASSED"
      ? "✅"
      : report.verdict === "FAILED"
        ? "❌"
        : report.verdict === "PENDING"
          ? "🔄"
          : "🔵";
  let md = `## ${icon} CI — [MR !${report.mrNumber}](${report.mrUrl})\n\n`;
  md += `**Verdict:** ${report.verdict}  \n`;
  md += `**Checks:** ${report.passed} passed, ${report.failed} failed, ${report.pending} pending, ${report.skipped} skipped (${report.total} total)\n\n`;
  md += `| Check | State | Bucket |\n|---|---|---|\n`;
  for (const c of report.checks) {
    const bi =
      c.bucket === "pass"
        ? "✅"
        : c.bucket === "fail"
          ? "❌"
          : c.bucket === "pending"
            ? "⏳"
            : c.bucket === "skipping"
              ? "⏭️"
              : "⚪";
    md += `| ${bi} ${c.name} | ${c.state} | ${c.bucket || "—"} |\n`;
  }
  return md;
}

function formatJson(report: CiReport): string {
  return JSON.stringify(
    {
      verdict: report.verdict,
      passed: report.passed,
      failed: report.failed,
      pending: report.pending,
      skipped: report.skipped,
      url: report.mrUrl,
      checks: report.checks.map((c) => ({
        name: c.name,
        state: c.state,
        bucket: c.bucket,
        link: c.link,
      })),
    },
    null,
    2,
  );
}

// ── Background polling ─────────────────────────────────────────────────────

function startCiPolling(pi: ExtensionAPI, mr: MrInfo, cwd: string, intervalMs = 30_000, maxPolls = 120) {
  let polls = 0;

  const poll = async () => {
    polls++;
    try {
      const checks = await fetchChecks(mr.number, cwd);

      // gh exit code 8 means checks still pending — same as empty/partial json
      const done = checks.length > 0 && checks.every((c) => c.bucket !== "pending" && c.bucket !== "");

      if (done || polls >= maxPolls) {
        const report = buildReport(mr, checks);
        let msg = formatMd(report);
        if (!done && polls >= maxPolls) {
          msg = `⏰ CI polling timed out after ${Math.round((intervalMs * polls) / 60_000)}m.\n\n${msg}`;
        }
        pi.sendUserMessage(msg, { deliverAs: "followUp", triggerTurn: true });
        return;
      }
      setTimeout(poll, intervalMs).unref?.();
    } catch {
      setTimeout(poll, intervalMs).unref?.();
    }
  };

  setTimeout(poll, 5_000).unref?.();
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /create-mr command ──────────────────────────────────────────────────

  pi.registerCommand("create-mr", {
    description: "Create a GitHub MR and poll CI",
    handler: async (args, ctx) => {
      const dq = args.match(/--description\s+"([^"]*)"|--description\s+'([^']*)'/);
      const du = args.match(/--description\s+(\S+)/);
      const description = dq?.[1] ?? dq?.[2] ?? du?.[1] ?? "";
      const base = (args.match(/--base\s+(\S+)/) ?? [])[1];
      const draft = args.includes("--draft");

      if (!description) {
        ctx.ui.notify('Usage: /create-mr --description "title\\nbody" [--base branch] [--draft]', "error");
        return;
      }

      const err = await preflight(ctx.cwd);
      if (err) {
        ctx.ui.notify(err, "error");
        return;
      }

      try {
        const mr = await createMr(ctx.cwd, description, base, draft);
        ctx.ui.notify(`MR !${mr.number} created: ${mr.url}`, "info");
        startCiPolling(pi, mr, ctx.cwd);
        pi.sendMessage({
          customType: "mr-created",
          content: `MR !${mr.number}: ${mr.url}\nCI polling started — results will follow when checks complete.`,
          display: true,
          details: mr,
        });
      } catch (e: any) {
        ctx.ui.notify(`Failed: ${e.message}`, "error");
      }
    },
  });

  // ── create_mr tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "create_mr",
    label: "Create MR",
    description:
      "Create a GitHub merge request for the current branch, then poll CI checks in the background and report results. Use when the user asks to create an MR/PR.",
    promptSnippet: "Create a GitHub MR/PR for the current branch",
    promptGuidelines: [
      "Use create_mr when the user wants to open a pull request or merge request. Provide a clear, descriptive title and body describing all changes made.",
    ],
    parameters: Type.Object({
      description: Type.String({
        description:
          "MR title and description. First line becomes the title, remaining lines (if any) become the body.",
      }),
      base: Type.Optional(
        Type.String({
          description:
            "Target/base branch for the MR. Defaults to the repository default branch (usually main/master).",
        }),
      ),
      draft: Type.Optional(
        Type.Boolean({
          description: "Create as draft MR. Defaults to false.",
          default: false,
        }),
      ),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const err = await preflight(ctx.cwd);
      if (err) return { content: [{ type: "text", text: `Error: ${err}` }], details: { error: err } };

      onUpdate?.({ content: [{ type: "text", text: "Creating MR..." }] });

      try {
        const mr = await createMr(ctx.cwd, params.description, params.base, params.draft);

        let initialChecks: CiCheck[] = [];
        try {
          initialChecks = await fetchChecks(mr.number, ctx.cwd);
        } catch {
          /* ok */
        }

        startCiPolling(pi, mr, ctx.cwd);
        const report = buildReport(mr, initialChecks);

        return {
          content: [
            {
              type: "text",
              text: `MR !${mr.number}: ${mr.url}\n\nCI polling started in background. Results reported when complete.\n\n${formatJson(report)}`,
            },
          ],
          details: { mr, ciPollingStarted: true, initialReport: report },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });

  // ── check_ci tool ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "check_ci",
    label: "Check CI",
    description:
      "Fetch the current CI check status for a GitHub MR. Use when the user asks about CI status, or when the MR was created earlier and results haven't been reported yet.",
    promptSnippet: "Fetch CI check status for a GitHub MR",
    promptGuidelines: [
      "Use check_ci when the user asks about CI/checks status for a specific MR number, or wants to know if checks have passed.",
    ],
    parameters: Type.Object({
      mrNumber: Type.Number({
        description: "The MR/PR number to check CI status for.",
      }),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Fetching CI checks..." }] });
      try {
        const checks = await fetchChecks(params.mrNumber, ctx.cwd);
        let url = "";
        try {
          const { stdout } = await gh(["pr", "view", String(params.mrNumber), "--json", "url"], ctx.cwd);
          url = (JSON.parse(stdout) as { url: string }).url ?? "";
        } catch {
          /* ok */
        }
        const report = buildReport(
          { number: params.mrNumber, url, title: "", base: "", head: "", draft: false },
          checks,
        );
        return { content: [{ type: "text", text: formatJson(report) }], details: report };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        };
      }
    },
  });
}
