import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runAgentTurns } from "./agent.js";
import { loadSettings, resolveApiKeyOrFile, resolveModel } from "./config.js";
import { HookRunner } from "./hooks.js";
import { loadMemory } from "./memory.js";
import { McpManager } from "./mcp.js";
import { PermissionManager } from "./permissions.js";
import { buildRegistry, ensureScratchDir } from "./tools/index.js";
import { buildSystemPrompt } from "./systemprompt.js";
import { loadSkills, renderSkill, type SkillDef } from "./skills.js";
import { loadSubagents } from "./subagents.js";
import { runSubagent } from "./subagent-runner.js";
import { resolveEndpoint } from "./endpoint.js";
import { explainApiError } from "./errors.js";
import type { AgentEvent, PermissionMode } from "./types.js";

export interface HeadlessOptions {
  prompt: string;
  cwd: string;
  modelFlag?: string;
  permissionMode?: PermissionMode;
  bypassPermissions: boolean;
  maxTurns?: number;
  outputFormat: "text" | "json" | "stream-json";
  verbose: boolean;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

interface StreamJsonInit {
  type: "system";
  subtype: "init";
  model: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function stdinData(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHeadless(o: HeadlessOptions): Promise<number> {
  let piped = await stdinData();
  if (piped.length > 10 * 1024 * 1024) {
    process.stderr.write("Error: piped stdin exceeds 10MB limit\n");
    return 2;
  }
  piped = piped.trim();

  const settings = await loadSettings(o.cwd);
  applyDisallowed(settings, o);

  const keyInfo = await resolveApiKeyOrFile();
  const endpoint = resolveEndpoint({ key: keyInfo.key, keySource: keyInfo.source, settings });

  const model = resolveModel(settings, o.modelFlag);
  const sessionId = crypto.randomUUID();
  const oxHome = path.join(process.env.HOME ?? "", ".ox");
  const scratchDir = ensureScratchDir(path.join(oxHome, "tmp"), sessionId);

  const [memory, skills, subagentDefs] = await Promise.all([
    loadMemory({ cwd: o.cwd }),
    loadSkills(o.cwd),
    loadSubagents(o.cwd),
  ]);

  const registry = buildRegistry({ initialCwd: o.cwd, scratchDir });
  const mcp = new McpManager({ cwd: o.cwd });
  await mcp.startAll();
  for (const impl of mcp.buildToolImpls()) registry.addRaw(impl.def.name, impl);

  const mode: PermissionMode = o.bypassPermissions
    ? "bypassPermissions"
    : (o.permissionMode ?? "default");

  const permissions = new PermissionManager({
    settings,
    cwd: o.cwd,
    addDirRoots: settings.permissions?.additionalDirectories ?? [],
  });
  permissions.mode = mode;
  for (const rule of o.allowedTools ?? []) permissions.addSessionRule(rule);

  const hooks = new HookRunner(settings.hooks, o.cwd);

  const subagentDepth = { n: 0 };
  const subagentRunner = async (req: { prompt: string; subagentType?: string; model?: string }) => {
    if (subagentDepth.n >= 3) return "(subagent depth limit reached)";
    const defName = req.subagentType && subagentDefs.has(req.subagentType) ? req.subagentType : "general-purpose";
    const def = subagentDefs.get(defName)!;
    subagentDepth.n += 1;
    try {
      return await runSubagent({
        prompt: req.prompt,
        def,
        parentRegistry: registry,
        permissions,
        apiKey: endpoint.apiKey ?? "ox-gateway",
        baseUrl: endpoint.baseUrl,
        model: req.model ? resolveModel({}, req.model) : model,
        abort: new AbortController().signal,
        sessionId,
        cwd: o.cwd,
        addDirRoots: [],
        scratchDir,
        depth: subagentDepth.n,
      });
    } finally {
      subagentDepth.n -= 1;
    }
  };

  const events = (e: AgentEvent): void => {
    if (o.outputFormat !== "stream-json") return;
    if (e.type === "text_delta") {
      emit({ type: "assistant", message: { content: [{ type: "text", text: e.text }] } });
    } else if (e.type === "tool_end") {
      emit({ type: "tool_result", name: e.name, truncated_output: e.output, is_error: e.isError });
    }
  };

  const systemPrompt =
    buildSystemPrompt({
      cwd: o.cwd,
      model,
      memory,
      skills: skills.filter((s) => !s.disableModelInvocation),
      mcpServers: mcp.status().filter((s) => s.status === "connected").map((s) => ({ name: s.name, toolCount: s.tools.length })),
      todoEnabled: true,
      planMode: mode === "plan",
    }) + (o.appendSystemPrompt ? `\n\n# Additional instructions\n${o.appendSystemPrompt}` : "");

  let userContent = o.prompt;
  if (piped) userContent += `\n\n<piped-input>\n${piped}\n</piped-input>`;
  const expanded = await expandSkillInvocations(userContent, skills, o.cwd);
  userContent = expanded;

  try {
    await mkdir(scratchDir, { recursive: true });
    if (o.outputFormat === "stream-json") {
      const init: StreamJsonInit = {
        type: "system",
        subtype: "init",
        model,
        tools: registry.names(),
        mcp_servers: mcp.status().map((s) => ({ name: s.name, status: s.status })),
      };
      emit(init);
    }

    const result = await runAgentTurns({
      messages: [{ role: "user", content: userContent }],
      systemPrompt,
      registry,
      permissions,
      hooks,
      apiKey: endpoint.apiKey ?? "ox-gateway",
      baseUrl: endpoint.baseUrl,
      model,
      maxTurns: o.maxTurns,
      abort: new AbortController().signal,
      events,
      interactive: false,
      scratchDir,
      sessionId,
      cwd: o.cwd,
      addDirRoots: [],
      subagentRunner,
    });

    const finalText = finalAssistantText(result.messages);

    if (o.outputFormat === "json") {
      emit({
        result: finalText,
        session_id: sessionId,
        usage: result.usage,
        turns: result.turns,
      });
    } else if (o.outputFormat === "stream-json") {
      emit({
        type: "result",
        subtype: "success",
        result: finalText,
        session_id: sessionId,
        usage: result.usage,
        turns: result.turns,
      });
    } else {
      if (finalText) process.stdout.write(finalText + "\n");
    }
    await mcp.stopAll();
    void hooks;
    return 0;
  } catch (err) {
    const message = explainApiError(err, { usingGateway: endpoint.usingGateway, baseUrl: endpoint.baseUrl });
    if (o.outputFormat === "text") process.stdout.write(`Error: ${message}\n`);
    else emit({ type: "result", subtype: "error", error: message });
    await mcp.stopAll();
    return 1;
  }
}

function applyDisallowed(settings: Awaited<ReturnType<typeof loadSettings>>, o: HeadlessOptions): void {
  const deny = settings.permissions?.deny ?? [];
  for (const d of deny) o.disallowedTools?.push(d);
}

export function finalAssistantText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (p.type === "text" ? p.text : "")).join("");
      return "";
    }
  }
  return "";
}

async function expandSkillInvocations(
  input: string,
  skills: SkillDef[],
  cwd: string,
): Promise<string> {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return input;
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return input;
  const name = match[1]!;
  const args = (match[2] ?? "").trim();
  const skill = skills.find((s) => s.name === name);
  if (!skill || !skill.userInvocable) return input;
  void cwd;
  return renderSkill(skill, args);
}
