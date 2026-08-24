import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SkillDef {
  name: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  body: string;
  source: "user" | "project";
}

type AttrValue = string | string[] | boolean;

export function parseFrontmatter(raw: string): { attrs: Record<string, AttrValue>; body: string } {
  const attrs: Record<string, AttrValue> = {};
  if (!raw.startsWith("---")) return { attrs, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { attrs, body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\n/, "");
  let currentKey: string | null = null;
  for (const line of header.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey) {
      const prev = attrs[currentKey];
      const arr = Array.isArray(prev) ? prev : [];
      arr.push(unquote(listItem[1]!.trim()));
      attrs[currentKey] = arr;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      currentKey = kv[1]!;
      const v = kv[2]!.trim();
      if (v === "") {
        attrs[currentKey] = "";
      } else if (v === "true") {
        attrs[currentKey] = true;
      } else if (v === "false") {
        attrs[currentKey] = false;
      } else if (v.startsWith("[")) {
        const inner = v.replace(/^\[/, "").replace(/\]$/, "").trim();
        attrs[currentKey] = inner
          ? inner.split(",").map((s) => unquote(s.trim()))
          : [];
      } else {
        attrs[currentKey] = unquote(v);
      }
    }
  }
  return { attrs, body };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of args) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function renderSkill(skill: SkillDef, args: string): string {
  let body = skill.body;
  body = body.replaceAll("${OX_PROJECT_DIR}", process.cwd());
  const positional = splitArgs(args);
  body = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => positional[Number(i)] ?? `$ARGUMENTS[${i}]`);
  body = body.replace(/\$(\d+)/g, (_, i) => positional[Number(i) - 1] ?? `$${i}`);
  body = body.replaceAll("$ARGUMENTS", args);
  if (args && !skill.body.includes("$ARGUMENTS") && !/\$\d+/.test(skill.body)) {
    body += `\n\nARGUMENTS: ${args}`;
  }
  return body;
}

function toSkill(name: string, raw: string, source: "user" | "project"): SkillDef | null {
  const { attrs, body } = parseFrontmatter(raw);
  const toolsAttr = attrs["allowed-tools"];
  return {
    name,
    description: typeof attrs["description"] === "string" ? attrs["description"] : undefined,
    argumentHint: typeof attrs["argument-hint"] === "string" ? attrs["argument-hint"] : undefined,
    allowedTools: Array.isArray(toolsAttr)
      ? toolsAttr.map(String)
      : typeof toolsAttr === "string"
        ? toolsAttr.split(/[ ,]+/).filter(Boolean)
        : undefined,
    disableModelInvocation: attrs["disable-model-invocation"] === true,
    userInvocable: attrs["user-invocable"] !== false,
    body,
    source,
  };
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function skillDirs(base: string): Promise<Array<{ name: string; file: string }>> {
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const out: Array<{ name: string; file: string }> = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const candidate = path.join(base, e.name, "SKILL.md");
        try {
          await fs.access(candidate);
          out.push({ name: e.name, file: candidate });
        } catch {
          /* no SKILL.md */
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadSkills(cwd: string, home?: string): Promise<SkillDef[]> {
  const h = home ?? os.homedir();
  const skills = new Map<string, SkillDef>();

  const addUser = async (name: string, file: string) => {
    try {
      const raw = await fs.readFile(file, "utf8");
      const def = toSkill(name, raw, "user");
      if (def && !skills.has(name)) skills.set(name, def);
    } catch {
      /* unreadable */
    }
  };
  const addProject = async (name: string, file: string) => {
    try {
      const raw = await fs.readFile(file, "utf8");
      const def = toSkill(name, raw, "project");
      if (def) skills.set(name, def);
    } catch {
      /* unreadable */
    }
  };

  for (const { name, file } of await skillDirs(path.join(h, ".ox", "skills"))) {
    await addUser(name, file);
  }
  for (const f of await listMdFiles(path.join(h, ".ox", "commands"))) {
    await addUser(path.basename(f, ".md"), f);
  }

  for (const { name, file } of await skillDirs(path.join(cwd, ".ox", "skills"))) {
    await addProject(name, file);
  }
  for (const f of await listMdFiles(path.join(cwd, ".ox", "commands"))) {
    await addProject(path.basename(f, ".md"), f);
  }
  for (const { name, file } of await skillDirs(path.join(cwd, ".claude", "skills"))) {
    await addProject(name, file);
  }
  for (const f of await listMdFiles(path.join(cwd, ".claude", "commands"))) {
    await addProject(path.basename(f, ".md"), f);
  }

  return [...skills.values()];
}
