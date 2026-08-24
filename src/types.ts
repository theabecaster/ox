import type { ChatMessage, ToolDef, Usage } from "./sse.js";

export { type ChatMessage, type ToolDef, type ToolCall, type Usage } from "./sse.js";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ToolContext {
  sessionId: string;
  /** Session working directory (absolute). */
  cwd: string;
  /** Additional readable/writable directory roots. */
  addDirRoots: string[];
  abort: AbortSignal;
  /** Session-scoped scratch dir for oversized outputs/background tasks. */
  scratchDir: string;
  /** Ask the user (or policy engine) for permission. */
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Emit a live progress line while a tool runs (e.g. streaming bash output). */
  onProgress?: (line: string) => void;
  /** Run an isolated subagent and return its final report (injected by the agent loop). */
  runSubagent?: (opts: { prompt: string; subagentType?: string; model?: string }) => Promise<string>;
  /** Ask the end user a multiple-choice question (REPL renders UI; headless denies). */
  askUser?: (questions: AskQuestion[]) => Promise<Record<string, string>>;
}

export interface PermissionRequest {
  toolName: string;
  summary: string;
  input: Record<string, unknown>;
  suggestRule?: string | null;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

export interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface ToolResult {
  /** Text handed back to the model as the tool result content. */
  output: string;
  isError?: boolean;
  /** Optional images attached to the tool result (data URLs or https URLs). */
  images?: Array<{ url: string }>;
}

export interface ToolImpl {
  def: ToolDef;
  /** Fast check used by auto-approval logic; may still be overridden by mode/rules. */
  readonly?: boolean;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  validate?: (input: Record<string, unknown>) => string | null;
}

export interface ToolRegistry {
  get(name: string): ToolImpl | undefined;
  names(): string[];
  defs(): ToolDef[];
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_progress"; callId: string; line: string }
  | { type: "tool_end"; callId: string; name: string; output: string; isError: boolean }
  | { type: "assistant_message"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "notice"; text: string }
  | { type: "error"; message: string };

export type AgentEventSink = (event: AgentEvent) => void;

export interface Settings {
  model?: string;
  gateway?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: PermissionMode;
    additionalDirectories?: string[];
  };
  env?: Record<string, string>;
  hooks?: Record<string, HookMatcher[]>;
  autoCompactTokens?: number;
  contextWindowTokens?: number;
  theme?: "dark" | "light";
  todoEnabled?: boolean;
}

export interface HookMatcher {
  matcher?: string;
  hooks: Array<{
    type?: "command";
    command: string;
    timeout?: number;
  }>;
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
}

export const DEFAULT_MODEL = "stealth/ox-alpha";
export const DEFAULT_GATEWAY_URL = "https://openrouter.ai/api/v1";

export function assistantText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return "";
}
