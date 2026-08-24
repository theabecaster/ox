import { runAgentTurns } from "./agent.js";
import type { PermissionManager } from "./permissions.js";
import type { AgentEventSink, ToolRegistry } from "./types.js";
import type { SubagentDef } from "./subagents.js";

const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch"]);

export interface SubagentRunOptions {
  prompt: string;
  def: SubagentDef;
  parentRegistry: ToolRegistry;
  permissions: PermissionManager;
  apiKey: string;
  model: string;
  baseUrl?: string;
  abort: AbortSignal;
  sessionId: string;
  cwd: string;
  addDirRoots: string[];
  scratchDir: string;
  depth: number;
  events?: AgentEventSink;
}

function filteredRegistry(parent: ToolRegistry, allowed: Set<string> | null): ToolRegistry {
  return {
    get: (name) => {
      const t = parent.get(name);
      if (!t) return undefined;
      if (allowed && !allowed.has(name)) return undefined;
      if (name === "AskUserQuestion" || name === "Agent" || name === "TodoWrite") return undefined;
      return t;
    },
    names: () => parent.names().filter((n) => (!allowed || allowed.has(n)) && n !== "AskUserQuestion" && n !== "Agent"),
    defs: () =>
      parent
        .defs()
        .filter((d) => (!allowed || allowed.has(d.name)) && d.name !== "AskUserQuestion" && d.name !== "Agent" && d.name !== "TodoWrite"),
  };
}

export async function runSubagent(o: SubagentRunOptions): Promise<string> {
  const allowed =
    o.def.name === "Explore" ? EXPLORE_TOOLS : o.def.tools ? new Set(o.def.tools) : null;
  const registry = filteredRegistry(o.parentRegistry, allowed);
  const events = o.events ?? (() => {});
  const res = await runAgentTurns({
    messages: [{ role: "user", content: o.prompt }],
    systemPrompt: o.def.systemPrompt,
    registry,
    permissions: o.permissions,
    hooks: undefined,
    apiKey: o.apiKey,
    model: o.model,
    baseUrl: o.baseUrl,
    abort: o.abort,
    events,
    interactive: false,
    maxTurns: 30,
    scratchDir: o.scratchDir,
    sessionId: o.sessionId,
    cwd: o.cwd,
    addDirRoots: o.addDirRoots,
  });
  let finalText = "";
  for (let i = res.messages.length - 1; i >= 0; i--) {
    const m = res.messages[i]!;
    if (m.role === "assistant") {
      finalText =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (p.type === "text" ? p.text : "")).join("")
            : "";
      break;
    }
  }
  return finalText || "(subagent produced no final message)";
}
