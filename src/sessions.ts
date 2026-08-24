import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSlug } from "./config.js";
import type { ChatMessage } from "./sse.js";
import type { SessionMeta } from "./types.js";

export type TranscriptEntry =
  | { type: "message"; message: ChatMessage }
  | { type: "summary"; text: string }
  | { type: "meta"; meta: SessionMeta };

export interface LoadedSession {
  meta: SessionMeta;
  path: string;
  entries: TranscriptEntry[];
}

function projectsDir(cwd: string, home?: string): string {
  return path.join(home ?? os.homedir(), ".ox", "projects", projectSlug(cwd));
}

function sessionFile(id: string, cwd: string, home?: string): string {
  return path.join(projectsDir(cwd, home), `${id}.jsonl`);
}

async function readEntries(p: string): Promise<TranscriptEntry[]> {
  let raw = "";
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t) as TranscriptEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

export function foldMeta(entries: TranscriptEntry[]): SessionMeta | null {
  let meta: SessionMeta | null = null;
  for (const e of entries) {
    if (e.type === "meta") meta = e.meta;
  }
  return meta;
}

export function messagesFromEntries(entries: TranscriptEntry[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const e of entries) {
    if (e.type === "message") msgs.push(e.message);
    else if (e.type === "summary")
      msgs.push({ role: "user", content: `Conversation summary from earlier compaction:\n\n${e.text}` });
  }
  return msgs;
}

export interface SessionSummary {
  meta: SessionMeta;
  path: string;
  messageCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionStore {
  private constructor(
    private _meta: SessionMeta,
    private readonly file: string,
  ) {}

  get meta(): SessionMeta {
    return this._meta;
  }

  static async create(opts: {
    cwd: string;
    home?: string;
    title?: string;
    model?: string;
  }): Promise<SessionStore> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      title: opts.title ?? "new session",
      cwd: path.resolve(opts.cwd),
      createdAt: now,
      updatedAt: now,
      model: opts.model,
    };
    const file = sessionFile(id, opts.cwd, opts.home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const store = new SessionStore(meta, file);
    await fs.writeFile(file, JSON.stringify({ type: "meta", meta } satisfies TranscriptEntry) + "\n");
    return store;
  }

  static instance(existing: LoadedSession): SessionStore {
    return new SessionStore(existing.meta, existing.path);
  }

  async append(entry: TranscriptEntry): Promise<void> {
    this._meta.updatedAt = new Date().toISOString();
    if (entry.type === "meta") this._meta = entry.meta;
    await fs.appendFile(this.file, JSON.stringify(entry) + "\n");
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    await this.append({ type: "message", message });
  }

  async rename(title: string): Promise<void> {
    await this.append({ type: "meta", meta: { ...this.meta, title } });
  }

  async exportText(): Promise<string> {
    const entries = await readEntries(this.file);
    const lines: string[] = ["# Ox session export", "", `Session: ${this.meta.id}`, `Title: ${this.meta.title}`, `Project: ${this.meta.cwd}`, ""];
    for (const e of entries) {
      if (e.type !== "message") continue;
      const m = e.message;
      if (m.role === "user") {
        lines.push("## user", "", typeof m.content === "string" ? m.content : "[complex content]", "");
      } else if (m.role === "assistant") {
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (p.type === "text" ? p.text : "")).join("")
              : "";
        if (text) lines.push("## assistant", "", text, "");
        for (const tc of m.tool_calls ?? []) {
          lines.push(`→ Tool(${tc.name} ${tc.arguments})`, "");
        }
      } else if (m.role === "tool") {
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        lines.push(`← ${tcName(m.name)}: ${c.slice(0, 400)}`, "");
      }
    }
    return lines.join("\n");
  }

  static async latest(cwd: string, home?: string): Promise<LoadedSession | null> {
    const list = await SessionStore.list(cwd, home, 1);
    const first = list[0];
    return first ? SessionStore.load(first.path, cwd, home) : null;
  }

  static async load(pathOrId: string, cwd?: string, home?: string): Promise<LoadedSession | null> {
    let target = pathOrId;
    try {
      const stat = await fs.stat(pathOrId);
      if (stat.isFile()) target = path.resolve(pathOrId);
    } catch {
      if (!UUID_RE.test(pathOrId)) return null;
      const base = home ?? os.homedir();
      const roots = path.join(base, ".ox", "projects");
      let found: string | null = null;
      let dirs: string[] = [];
      try {
        dirs = await fs.readdir(roots);
      } catch {
        return null;
      }
      for (const d of dirs) {
        const candidate = path.join(roots, d, `${pathOrId}.jsonl`);
        try {
          await fs.access(candidate);
          found = candidate;
          break;
        } catch {
          /* keep looking */
        }
      }
      if (!found) return null;
      target = found;
    }
    void cwd;
    const entries = await readEntries(target);
    const meta = foldMeta(entries);
    if (!meta) return null;
    return { meta, path: target, entries };
  }

  static async list(
    cwd: string,
    home?: string,
    limit = 20,
  ): Promise<SessionSummary[]> {
    const dir = projectsDir(cwd, home);
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const f of files) {
      const p = path.join(dir, f);
      const entries = await readEntries(p);
      const meta = foldMeta(entries);
      if (!meta) continue;
      const messageCount = entries.filter((e) => e.type === "message").length;
      out.push({ meta, path: p, messageCount });
    }
    out.sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt));
    return out.slice(0, limit);
  }
}

function tcName(name: string | undefined): string {
  return name ?? "tool";
}
