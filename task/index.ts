/**
 * Task Extension — global, repo-aware task manager
 *
 * Commands:
 *   /task "text"                  Add task for current repo
 *   /task -g "text"               Add global/unscoped task
 *   /task -r <path> "text"        Add task for a specific repo
 *   /task --refine "text" [+flags]  Same as above but triggers LLM to elaborate
 *
 *   /tasks                        List tasks for current repo
 *   /tasks -a                     List all tasks (every repo + global)
 *   /tasks -g                     List global/unscoped tasks
 *   /tasks -r <path>              List tasks for a specific repo
 *
 *   /done <id>                    Mark task as done
 *   /undone <id>                  Reopen a done task
 *
 * LLM tool: task  (list/add/toggle/update)
 *
 * Storage: ~/.pi/tasks.json
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

interface Task {
  id: string; // UUID
  text: string;
  repo: string | null; // absolute path, null = global/unscoped
  done: boolean;
  context: string; // LLM-provided elaboration
  createdAt: string; // ISO 8601
  doneAt: string | null;
}

interface TasksFile {
  tasks: Task[];
}

// ── Storage ──────────────────────────────────────────────────────────────────

const TASKS_PATH = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".pi", "tasks.json");

function readTasks(): TasksFile {
  try {
    const raw = fs.readFileSync(TASKS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

function writeTasks(data: TasksFile): void {
  fs.mkdirSync(path.dirname(TASKS_PATH), { recursive: true });
  fs.writeFileSync(TASKS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function findTask(id: string): Task | undefined {
  return readTasks().tasks.find((t) => t.id === id);
}

function updateTask(
  id: string,
  patch: Partial<Pick<Task, "text" | "done" | "context" | "repo" | "doneAt">>,
): Task | null {
  const data = readTasks();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  data.tasks[idx] = { ...data.tasks[idx], ...patch };
  writeTasks(data);
  return data.tasks[idx];
}

function addTask(text: string, repo: string | null): Task {
  const data = readTasks();
  const task: Task = {
    id: crypto.randomUUID(),
    text,
    repo,
    done: false,
    context: "",
    createdAt: new Date().toISOString(),
    doneAt: null,
  };
  data.tasks.push(task);
  writeTasks(data);
  return task;
}

// ── Argument Parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  refine: boolean;
  scope: { type: "current" | "global" | "repo"; repoPath?: string };
  text: string;
}

interface ViewArgs {
  scope: { type: "current" | "all" | "global" | "repo"; repoPath?: string };
}

/** Parse arguments for /task (add) command */
function parseTaskArgs(raw: string, cwd: string): ParsedArgs {
  let refine = false;
  let scope: ParsedArgs["scope"] = { type: "current" };
  let remaining = raw.trim();

  // Parse flags
  while (true) {
    if (remaining.startsWith("--refine")) {
      refine = true;
      remaining = remaining.slice("--refine".length).trimStart();
    } else if (remaining.startsWith("-g")) {
      scope = { type: "global" };
      remaining = remaining.slice(2).trimStart();
    } else if (remaining.startsWith("-r")) {
      const afterFlag = remaining.slice(2).trimStart();
      const match = afterFlag.match(/^(\S+)\s+(.*)$/s);
      if (match) {
        scope = { type: "repo", repoPath: path.resolve(cwd, match[1]) };
        remaining = match[2].trim();
      } else {
        remaining = afterFlag;
      }
    } else {
      break;
    }
  }

  // Strip surrounding quotes from text
  let text = remaining;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }

  return { refine, scope, text };
}

/** Parse arguments for /tasks (view) command */
function parseViewArgs(raw: string, cwd: string): ViewArgs {
  let scope: ViewArgs["scope"] = { type: "current" };
  let remaining = raw.trim();

  if (remaining.startsWith("-a")) {
    scope = { type: "all" };
    remaining = remaining.slice(2).trimStart();
  } else if (remaining.startsWith("-g")) {
    scope = { type: "global" };
    remaining = remaining.slice(2).trimStart();
  } else if (remaining.startsWith("-r")) {
    const afterFlag = remaining.slice(2).trimStart();
    const match = afterFlag.match(/^(\S+)/);
    if (match) {
      scope = { type: "repo", repoPath: path.resolve(cwd, match[1]) };
    }
  }

  return { scope };
}

/** Filter tasks by view scope */
function filterTasks(tasks: Task[], scope: ViewArgs["scope"], cwd: string): Task[] {
  switch (scope.type) {
    case "current":
      return tasks.filter((t) => t.repo === cwd);
    case "all":
      return tasks;
    case "global":
      return tasks.filter((t) => t.repo === null || t.repo === "");
    case "repo":
      return tasks.filter((t) => t.repo === scope.repoPath);
  }
}

/** Human-readable scope label */
function scopeLabel(scope: ViewArgs["scope"], cwd: string): string {
  switch (scope.type) {
    case "current":
      return cwd;
    case "all":
      return "all repos";
    case "global":
      return "global";
    case "repo":
      return scope.repoPath ?? "unknown";
  }
}

function repoLabel(task: Task, cwd: string): string {
  if (!task.repo) return "global";
  if (task.repo === cwd) return ".";
  return task.repo;
}

// ── TUI Component ────────────────────────────────────────────────────────────

class TaskListComponent {
  private tasks: Task[];
  private theme: Theme;
  private onClose: () => void;
  private scopeLabel: string;
  private cwd: string;

  constructor(tasks: Task[], theme: Theme, onClose: () => void, scopeLabel: string, cwd: string) {
    this.tasks = tasks;
    this.theme = theme;
    this.onClose = onClose;
    this.scopeLabel = scopeLabel;
    this.cwd = cwd;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const th = this.theme;

    lines.push("");
    const title = th.fg("accent", ` Tasks — ${this.scopeLabel} `);
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 6)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    const pending = this.tasks.filter((t) => !t.done);
    const done = this.tasks.filter((t) => t.done);

    if (this.tasks.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", 'No tasks. Use /task "text" to add one.')}`, width));
    } else {
      lines.push(truncateToWidth(`  ${th.fg("muted", `${pending.length} pending, ${done.length} done`)}`, width));
      lines.push("");

      // Pending first
      for (const task of pending) {
        const check = th.fg("dim", "○");
        const id = th.fg("accent", task.id.slice(0, 8));
        const repo = this.scopeLabel === "all repos" ? ` ${th.fg("dim", `[${repoLabel(task, this.cwd)}]`)}` : "";
        const text = th.fg("text", task.text);
        const contextPreview = task.context
          ? `  ${th.fg(
              "dim",
              task.context.slice(0, Math.min(60, task.context.length)) + (task.context.length > 60 ? "…" : ""),
            )}`
          : "";
        lines.push(truncateToWidth(`  ${check} ${id} ${text}${repo}`, width));
        if (contextPreview) lines.push(truncateToWidth(contextPreview, width));
      }

      // Done
      if (done.length > 0) {
        lines.push("");
        for (const task of done) {
          const check = th.fg("success", "✓");
          const id = th.fg("dim", task.id.slice(0, 8));
          const text = th.fg("dim", task.text);
          lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
        }
      }
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", 'Esc to close  |  /done <id>  |  /task "text"')}`, width));
    lines.push("");

    return lines;
  }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── LLM Tool ─────────────────────────────────────────────────────────────

  const TaskParams = Type.Object({
    action: StringEnum(["list", "add", "toggle", "update"] as const),
    text: Type.Optional(Type.String({ description: "Task text (for add/update)" })),
    id: Type.Optional(Type.String({ description: "Task UUID (for toggle/update)" })),
    context: Type.Optional(Type.String({ description: "Elaborated context (for add/update)" })),
    repo: Type.Optional(
      Type.String({
        description: 'Repo path filter. "__all__" = all, "__global__" = global only. Default: current repo.',
      }),
    ),
  });

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Manage a persistent task list (stored globally at ~/.pi/tasks.json). " +
      "Tasks are repo-scoped by default. Use list/add/toggle/update.",
    promptSnippet: "List, add, toggle, or update persistent tasks",
    promptGuidelines: [
      "Use task with action=list to see current tasks before adding or updating.",
      "Use task action=add to create a new task with optional repo and context.",
      "Use task action=toggle with the task id to mark a task done/undone.",
      "Use task action=update with the task id to change text or add context.",
    ],
    parameters: TaskParams,

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;

      switch (params.action) {
        case "list": {
          let tasks = readTasks().tasks;
          if (params.repo === "__all__") {
            // no filter
          } else if (params.repo === "__global__") {
            tasks = tasks.filter((t) => !t.repo);
          } else if (params.repo) {
            tasks = tasks.filter((t) => t.repo === params.repo);
          } else {
            tasks = tasks.filter((t) => t.repo === cwd);
          }

          const lines = tasks.length
            ? tasks
                .map((t) => {
                  const check = t.done ? "x" : " ";
                  const repoTag = t.repo ? (t.repo === cwd ? "" : ` [${t.repo}]`) : " [global]";
                  const ctxLine = t.context ? `\n    context: ${t.context.slice(0, 100)}` : "";
                  return `  [${check}] ${t.id.slice(0, 8)} ${t.text}${repoTag}${ctxLine}`;
                })
                .join("\n")
            : "  No tasks";

          const summary = `${tasks.filter((t) => !t.done).length} pending, ${tasks.filter((t) => t.done).length} done`;

          return {
            content: [{ type: "text", text: `${summary}\n${lines}` }],
            details: { action: "list", tasks, summary },
          };
        }

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: text required for add" }],
              details: { action: "add", error: "text required" },
            };
          }
          let repo: string | null = cwd;
          if (params.repo === "__global__") repo = null;
          else if (params.repo) repo = params.repo;

          const task = addTask(params.text, repo);
          if (params.context) updateTask(task.id, { context: params.context });

          return {
            content: [
              {
                type: "text",
                text:
                  `Added task ${task.id.slice(0, 8)}: ${task.text}` +
                  (task.repo ? ` [${task.repo === cwd ? "." : task.repo}]` : " [global]"),
              },
            ],
            details: { action: "add", task },
          };
        }

        case "toggle": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: id required for toggle" }],
              details: { action: "toggle", error: "id required" },
            };
          }
          const existing = findTask(params.id);
          if (!existing) {
            return {
              content: [{ type: "text", text: `Task ${params.id.slice(0, 8)} not found` }],
              details: { action: "toggle", error: "not found" },
            };
          }
          const updated = updateTask(params.id, {
            done: !existing.done,
            doneAt: existing.done ? null : new Date().toISOString(),
          });
          const status = updated?.done ? "completed" : "reopened";
          return {
            content: [{ type: "text", text: `Task ${params.id.slice(0, 8)} ${status}` }],
            details: { action: "toggle", task: updated },
          };
        }

        case "update": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: id required for update" }],
              details: { action: "update", error: "id required" },
            };
          }
          const existing = findTask(params.id);
          if (!existing) {
            return {
              content: [{ type: "text", text: `Task ${params.id.slice(0, 8)} not found` }],
              details: { action: "update", error: "not found" },
            };
          }
          const patch: Partial<Pick<Task, "text" | "context">> = {};
          if (params.text !== undefined) patch.text = params.text;
          if (params.context !== undefined) patch.context = params.context;
          const updated = updateTask(params.id, patch);
          return {
            content: [{ type: "text", text: `Updated task ${params.id.slice(0, 8)}` }],
            details: { action: "update", task: updated },
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action: ${(params as any).action}`,
              },
            ],
          };
      }
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("muted", args.action);
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id) text += ` ${theme.fg("accent", args.id.slice(0, 8))}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as any;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      switch (details.action) {
        case "list": {
          const tasks = details.tasks as Task[];
          if (!tasks || tasks.length === 0) {
            return new Text(theme.fg("dim", "No tasks"), 0, 0);
          }
          let listText = theme.fg("muted", details.summary ?? `${tasks.length} tasks`);
          const display = expanded ? tasks : tasks.slice(0, 5);
          for (const t of display) {
            const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
            const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
            listText += `\n${check} ${theme.fg("accent", t.id.slice(0, 8))} ${itemText}`;
          }
          if (!expanded && tasks.length > 5) {
            listText += `\n${theme.fg("dim", `... ${tasks.length - 5} more`)}`;
          }
          return new Text(listText, 0, 0);
        }

        case "add": {
          const task = details.task as Task;
          if (!task) return new Text(theme.fg("error", "Error: missing task"), 0, 0);
          return new Text(
            theme.fg("success", "✓ Added ") +
              theme.fg("accent", task.id.slice(0, 8)) +
              " " +
              theme.fg("muted", task.text),
            0,
            0,
          );
        }

        case "toggle": {
          const task = details.task as Task;
          if (!task) return new Text(theme.fg("error", "Error: missing task"), 0, 0);
          const status = task.done ? theme.fg("success", "done") : theme.fg("dim", "reopened");
          return new Text(theme.fg("success", "✓ ") + theme.fg("accent", task.id.slice(0, 8)) + ` ${status}`, 0, 0);
        }

        case "update": {
          const task = details.task as Task;
          if (!task) return new Text(theme.fg("error", "Error: missing task"), 0, 0);
          return new Text(theme.fg("success", "✓ Updated ") + theme.fg("accent", task.id.slice(0, 8)), 0, 0);
        }

        default: {
          const t = result.content[0];
          return new Text(t?.type === "text" ? t.text : "", 0, 0);
        }
      }
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  // /task — add a task
  pi.registerCommand("task", {
    description: "Add a task. Flags: -g (global), -r <path> (specific repo), --refine (LLM elaborate)",
    getArgumentCompletions: (prefix) => {
      const flags = ["-g", "-r", "--refine"];
      const filtered = flags.filter((f) => f.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((f) => ({ value: f, label: f })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
      }

      const { refine, scope, text } = parseTaskArgs(args, ctx.cwd);

      if (!text) {
        ctx.ui.notify('Usage: /task [-g|-r <path>] [--refine] "task text"', "error");
        return;
      }

      // Resolve repo path for the add
      let repo: string | null;
      switch (scope.type) {
        case "global":
          repo = null;
          break;
        case "repo":
          repo = scope.repoPath ?? ctx.cwd;
          break;
        default:
          repo = ctx.cwd;
      }

      const task = addTask(text, repo);
      const scopeDesc = repo ? (repo === ctx.cwd ? "." : repo) : "global";
      ctx.ui.notify(`Task ${task.id.slice(0, 8)} added [${scopeDesc}]: ${task.text}`, "info");

      if (refine) {
        // Trigger LLM to elaborate
        const repoNote = repo ? (repo === ctx.cwd ? "current repo" : `repo \`${repo}\``) : "global scope";
        pi.sendUserMessage(
          `I just added a task: **"${text}"** (task ID: ${task.id.slice(0, 8)}, ${repoNote}).\n\n` +
            `Please expand on this task:\n` +
            `1. Think about what needs to be done. If relevant, read the codebase to understand context.\n` +
            `2. Break it into concrete subtasks or steps if appropriate.\n` +
            `3. Ask clarifying questions if the task is ambiguous.\n` +
            `4. Use the \`task\` tool with action=update to set the context field on this task with your elaboration. Also update the text if you have a better title.`,
        );
      }
    },
  });

  // /tasks — view tasks
  pi.registerCommand("tasks", {
    description: "View tasks. Flags: -a (all), -g (global), -r <path> (specific repo). Default: current repo.",
    getArgumentCompletions: (prefix) => {
      const flags = ["-a", "-g", "-r"];
      const filtered = flags.filter((f) => f.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((f) => ({ value: f, label: f })) : null;
    },
    handler: async (args, ctx) => {
      const { scope } = parseViewArgs(args, ctx.cwd);
      const allTasks = readTasks().tasks;
      const filtered = filterTasks(allTasks, scope, ctx.cwd);

      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          return new TaskListComponent(filtered, theme, () => done(), scopeLabel(scope, ctx.cwd), ctx.cwd);
        });
      } else {
        // Non-TUI: print plain text
        const label = scopeLabel(scope, ctx.cwd);
        const pending = filtered.filter((t) => !t.done);
        const done = filtered.filter((t) => t.done);

        let out = `\nTasks — ${label}\n`;
        out += `${pending.length} pending, ${done.length} done\n\n`;

        if (filtered.length === 0) {
          out += "  No tasks.\n";
        } else {
          for (const task of pending) {
            out += `  ○ ${task.id.slice(0, 8)}  ${task.text}\n`;
            if (task.context) out += `    ${task.context.slice(0, 80)}${task.context.length > 80 ? "…" : ""}\n`;
          }
          for (const task of done) {
            out += `  ✓ ${task.id.slice(0, 8)}  ${task.text}\n`;
          }
        }

        ctx.ui.notify(out, "info");
      }
    },
  });

  // /done — mark task as done
  pi.registerCommand("done", {
    description: "Mark a task as done: /done <uuid-or-prefix>",
    handler: async (rawArgs, ctx) => {
      const idPrefix = rawArgs.trim();
      if (!idPrefix) {
        ctx.ui.notify("Usage: /done <task-id>", "error");
        return;
      }

      const tasks = readTasks().tasks;
      const match = tasks.find((t) => t.id.startsWith(idPrefix));
      if (!match) {
        ctx.ui.notify(`No task found matching "${idPrefix}"`, "error");
        return;
      }

      if (match.done) {
        ctx.ui.notify(`Task ${match.id.slice(0, 8)} is already done: ${match.text}`, "info");
        return;
      }

      updateTask(match.id, { done: true, doneAt: new Date().toISOString() });
      ctx.ui.notify(`Done: ${match.id.slice(0, 8)} — ${match.text}`, "info");
    },
  });

  // /undone — reopen a done task
  pi.registerCommand("undone", {
    description: "Reopen a done task: /undone <uuid-or-prefix>",
    handler: async (rawArgs, ctx) => {
      const idPrefix = rawArgs.trim();
      if (!idPrefix) {
        ctx.ui.notify("Usage: /undone <task-id>", "error");
        return;
      }

      const tasks = readTasks().tasks;
      const match = tasks.find((t) => t.id.startsWith(idPrefix));
      if (!match) {
        ctx.ui.notify(`No task found matching "${idPrefix}"`, "error");
        return;
      }

      if (!match.done) {
        ctx.ui.notify(`Task ${match.id.slice(0, 8)} is already open: ${match.text}`, "info");
        return;
      }

      updateTask(match.id, { done: false, doneAt: null });
      ctx.ui.notify(`Reopened: ${match.id.slice(0, 8)} — ${match.text}`, "info");
    },
  });
}
