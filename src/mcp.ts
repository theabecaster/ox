import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolImpl, ToolResult } from "./types.js";

export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerState {
  name: string;
  config: ServerConfig;
  source: "project" | "local";
  status: "connected" | "error" | "pending";
  error?: string;
  tools: McpToolInfo[];
}

interface PendingRequest {
  resolve: (v: JsonRpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export function expandEnvStrings(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === "string") {
    return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, def?: string) => {
      const val = env[name];
      if (val !== undefined && val !== "") return val;
      if (def !== undefined) return def;
      if (name in env) return "";
      return whole;
    });
  }
  if (Array.isArray(v)) return v.map((x) => expandEnvStrings(x, env));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = expandEnvStrings(val, env);
    return out;
  }
  return v;
}

function localMcpFile(home?: string): string {
  return path.join(home ?? os.homedir(), ".ox", "mcp.json");
}
function projectMcpFile(cwd: string): string {
  return path.join(cwd, ".mcp.json");
}

async function readServers(file: string): Promise<Record<string, ServerConfig>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { mcpServers?: Record<string, ServerConfig> };
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

async function writeServers(file: string, servers: Record<string, ServerConfig>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}

export async function mcpAddServer(opts: {
  scope: "local" | "project";
  name: string;
  config: ServerConfig;
  cwd: string;
  home?: string;
}): Promise<void> {
  const file = opts.scope === "project" ? projectMcpFile(opts.cwd) : localMcpFile(opts.home);
  const servers = await readServers(file);
  servers[opts.name] = opts.config;
  await writeServers(file, servers);
}

export async function mcpRemoveServer(opts: {
  scope: "local" | "project";
  name: string;
  cwd: string;
  home?: string;
}): Promise<boolean> {
  const file = opts.scope === "project" ? projectMcpFile(opts.cwd) : localMcpFile(opts.home);
  const servers = await readServers(file);
  if (!(opts.name in servers)) return false;
  delete servers[opts.name];
  await writeServers(file, servers);
  return true;
}

export async function mcpListServers(opts: {
  cwd: string;
  home?: string;
}): Promise<Array<{ name: string; config: ServerConfig; scope: "project" | "local" }>> {
  const [project, local] = await Promise.all([
    readServers(projectMcpFile(opts.cwd)),
    readServers(localMcpFile(opts.home)),
  ]);
  return [
    ...Object.entries(project).map(([name, config]) => ({ name, config, scope: "project" as const })),
    ...Object.entries(local).map(([name, config]) => ({ name, config, scope: "local" as const })),
  ];
}

interface Connection {
  name: string;
  proc: ChildProcess;
  pending: Map<number, PendingRequest>;
  nextId: number;
  buffer: string;
  tools: McpToolInfo[];
  serverInfo?: string;
}

const PROTOCOL_VERSION = "2024-11-05";

export class McpManager {
  private connections = new Map<string, Connection>();
  private states: McpServerState[] = [];

  constructor(
    private opts: {
      cwd: string;
      home?: string;
      timeoutMs?: number;
      approval?: (serverName: string, source: "project" | "local") => Promise<boolean>;
    },
  ) {}

  async startAll(): Promise<McpServerState[]> {
    this.states = [];
    const entries = await mcpListServers({ cwd: this.opts.cwd, home: this.opts.home });
    for (const entry of entries) {
      if (entry.scope === "project" && this.opts.approval && !(await this.opts.approval(entry.name, "project"))) {
        continue;
      }
      const state: McpServerState = {
        name: entry.name,
        config: entry.config,
        source: entry.scope,
        status: "pending",
        tools: [],
      };
      this.states.push(state);
      try {
        await this.connect(state);
      } catch (err) {
        state.status = "error";
        state.error = err instanceof Error ? err.message : String(err);
      }
    }
    return this.status();
  }

  status(): McpServerState[] {
    return this.states;
  }

  tools(): ToolImpl[] {
    const out: ToolImpl[] = [];
    for (const st of this.states) {
      if (st.status !== "connected") continue;
      for (const t of st.tools) {
        out.push(this.toolFor(st.name, t));
      }
    }
    return out;
  }

  toolFor(serverName: string, info: McpToolInfo): ToolImpl {
    const fullName = `mcp__${serverName}__${info.name}`;
    return {
      def: {
        name: fullName,
        description: `[mcp:${serverName}] ${info.description ?? info.name}`,
        parameters:
          info.inputSchema && typeof info.inputSchema === "object"
            ? (info.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      },
      run: async (input, ctx) => {
        throwIfAborted(ctx.abort);
        const res = await this.callTool(serverName, info.name, input);
        return { output: res.text, isError: res.isError } satisfies ToolResult;
      },
    };
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const conn = this.connections.get(server);
    if (!conn) return { text: `MCP server ${server} is not connected`, isError: true };
    try {
      const res = await this.request(conn, "tools/call", { name: tool, arguments: args });
      if (res.error) return { text: `MCP error: ${res.error.message}`, isError: true };
      const result = res.result ?? {};
      const isError = result["isError"] === true;
      const content = Array.isArray(result["content"]) ? (result["content"] as Array<Record<string, unknown>>) : [];
      const text = content
        .map((c) => {
          if (c.type === "text") return String(c.text ?? "");
          if (c.type === "image") return "[image]";
          if (c.type === "resource") return `[resource] ${String((c.resource as Record<string, unknown>)?.uri ?? "")}`;
          return `[${String(c.type)}]`;
        })
        .join("\n");
      return { text: text || "(empty response)", isError };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  buildToolImpls(): ToolImpl[] {
    const impls: ToolImpl[] = [];
    for (const st of this.states) {
      if (st.status !== "connected") continue;
      for (const info of st.tools) {
        const server = st.name;
        impls.push({
          def: {
            name: `mcp__${server}__${info.name}`,
            description: `[mcp:${server}] ${info.description ?? info.name}`,
            parameters:
              info.inputSchema && typeof info.inputSchema === "object"
                ? (info.inputSchema as Record<string, unknown>)
                : { type: "object", properties: {} },
          },
          run: async (input) => {
            const res = await this.callTool(server, info.name, input);
            return { output: res.text, isError: res.isError } satisfies ToolResult;
          },
        });
      }
    }
    return impls;
  }

  async stopAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        conn.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.connections.delete(name);
    }
  }

  private async connect(state: McpServerState): Promise<void> {
    const expandedEnv = expandEnvStrings(state.config.env ?? {}, process.env) as Record<string, string>;
    const env = {
      ...process.env,
      ...expandedEnv,
      OX_PROJECT_DIR: this.opts.cwd,
    } as Record<string, string>;
    const cfg = expandEnvStrings(state.config, process.env) as ServerConfig;
    const proc = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd ?? this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const conn: Connection = {
      name: state.name,
      proc,
      pending: new Map(),
      nextId: 1,
      buffer: "",
      tools: [],
    };
    this.connections.set(state.name, conn);

    let stderrTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
      if (process.env.OX_MCP_DEBUG === "1") process.stderr.write(d);
    });

    proc.stdout?.on("data", (d: Buffer) => {
      conn.buffer += d.toString();
      let idx: number;
      while ((idx = conn.buffer.indexOf("\n")) !== -1) {
        const line = conn.buffer.slice(0, idx).trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse & { method?: string };
          if (msg.id !== undefined && msg.id !== null && conn.pending.has(Number(msg.id))) {
            const p = conn.pending.get(Number(msg.id))!;
            clearTimeout(p.timer);
            conn.pending.delete(Number(msg.id));
            p.resolve(msg);
          }
        } catch {
          /* non-JSON line */
        }
      }
    });

    const exited = new Promise<never>((_, reject) => {
      proc.on("exit", (code) =>
        reject(new Error(`MCP server ${state.name} exited (code ${code}) ${stderrTail.slice(-300)}`)),
      );
      proc.on("error", (err) => reject(new Error(`MCP server ${state.name}: ${err.message}`)));
    });
    exited.catch(() => {
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${state.name} exited`));
      }
      conn.pending.clear();
      const st = this.states.find((s) => s.name === state.name);
      if (st && st.status === "connected") {
        st.status = "error";
        st.error = "server exited";
      }
    });

    const initRes = await Promise.race([
      this.request(conn, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ox", version: "0.1.0" },
      }),
      exited,
      timeoutReject(this.opts.timeoutMs ?? 30_000, `initialize timed out for ${state.name}`),
    ]);
    if (initRes.error) throw new Error(`initialize failed: ${initRes.error.message}`);
    notify(conn, "notifications/initialized");

    const listRes = await Promise.race([
      this.request(conn, "tools/list", {}),
      exited,
      timeoutReject(this.opts.timeoutMs ?? 30_000, `tools/list timed out for ${state.name}`),
    ]);
    if (listRes.error) throw new Error(`tools/list failed: ${listRes.error.message}`);
    const toolsRaw = Array.isArray(listRes.result?.["tools"]) ? (listRes.result?.["tools"] as Array<Record<string, unknown>>) : [];
    state.tools = toolsRaw.map((t) => ({
      name: String(t.name),
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    }));
    state.status = "connected";
    void initRes;
  }

  private request(conn: Connection, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = conn.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.proc.stdin?.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new Error(`write to ${conn.name} failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }
}

function notify(conn: Connection, method: string): void {
  const msg: JsonRpcRequest = { jsonrpc: "2.0", method };
  try {
    conn.proc.stdin?.write(JSON.stringify(msg) + "\n");
  } catch {
    /* ignore */
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("aborted");
}

function timeoutReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
