/**
 * Minimal type declarations for @earendil-works/pi-coding-agent.
 * Covers the ExtensionAPI surface used by pi-extensions.
 */

declare module "@earendil-works/pi-coding-agent" {
  interface ToolRegistration {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: any;
    execute: (
      id: string,
      params: any,
      signal: AbortSignal,
      onUpdate: ((update: ToolUpdate) => void) | undefined,
      ctx: ToolContext,
    ) => Promise<ToolResult>;
  }

  interface ToolUpdate {
    content: { type: "text"; text: string }[];
  }

  interface ToolResult {
    content: { type: "text"; text: string }[];
    details?: unknown;
    isError?: boolean;
  }

  interface ToolContext {
    cwd: string;
  }

  interface CommandRegistration {
    description: string;
    handler: (args: string, ctx: CommandContext) => Promise<void>;
  }

  interface CommandContext {
    cwd: string;
    ui: {
      notify: (message: string, level: "info" | "warn" | "error") => void;
    };
  }

  interface MessagePayload {
    customType?: string;
    content: string;
    display?: boolean;
    details?: unknown;
    deliverAs?: "followUp";
    triggerTurn?: boolean;
  }

  interface ExtensionAPI {
    registerCommand(name: string, registration: CommandRegistration): void;
    registerTool(registration: ToolRegistration): void;
    sendMessage(payload: MessagePayload): void;
    sendUserMessage(message: string, options?: { deliverAs?: string; triggerTurn?: boolean }): void;
  }
}
