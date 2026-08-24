import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_MEMORY_FILE = 4 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 4;

function memoryCandidates(dir: string): string[] {
  return [
    path.join(dir, "AGENTS.md"),
    path.join(dir, ".ox", "AGENTS.md"),
    path.join(dir, "OX.md"),
    path.join(dir, "CLAUDE.md"),
  ];
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.size <= MAX_MEMORY_FILE) return p;
    } catch {
      /* continue */
    }
  }
  return null;
}

export async function expandImports(
  content: string,
  baseDir: string,
  depth = 0,
  seen = new Set<string>(),
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const m = line.match(/(?:^|\s)@([^\s`]+)/);
      if (m?.[1]) {
        let target = m[1];
        if (target.startsWith("~")) {
          target = path.join(os.homedir(), target.slice(1));
        } else if (!path.isAbsolute(target)) {
          target = path.join(baseDir, target);
        }
        const key = path.resolve(target);
        if (!seen.has(key)) {
          seen.add(key);
          try {
            const imported = await fs.readFile(key, "utf8");
            out.push(await expandImports(imported, path.dirname(key), depth + 1, seen));
            continue;
          } catch {
            out.push(line);
            continue;
          }
        }
      }
      out.push(stripHtmlComment(line));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function stripHtmlComment(line: string): string {
  return line.replace(/<!--.*?-->/g, "").trimEnd();
}

function ancestorChain(cwd: string): string[] {
  const abs = path.resolve(cwd);
  const chain: string[] = [];
  let cur = abs;
  while (true) {
    chain.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return chain;
}

export async function loadMemory(opts: {
  cwd: string;
  home?: string;
  extraRoots?: string[];
}): Promise<string> {
  const parts: string[] = [];
  const seen = new Set<string>();

  const userGlobal = await firstExisting([
    path.join(opts.home ?? os.homedir(), ".ox", "AGENTS.md"),
    path.join(opts.home ?? os.homedir(), ".ox", "OX.md"),
  ]);
  if (userGlobal) parts.push(await processFile(userGlobal, seen));

  for (const dir of ancestorChain(opts.cwd)) {
    const found = await firstExisting(memoryCandidates(dir).slice(0, dir === path.resolve(opts.cwd) ? 4 : 3));
    if (found && !seen.has(path.resolve(found))) {
      parts.push(await processFile(found, seen));
    }
  }

  for (const root of opts.extraRoots ?? []) {
    const found = await firstExisting(memoryCandidates(path.resolve(root)));
    if (found && !seen.has(path.resolve(found))) {
      parts.push(await processFile(found, seen));
    }
  }

  return parts.filter(Boolean).join("\n\n");
}

async function processFile(p: string, seen: Set<string>): Promise<string> {
  seen.add(path.resolve(p));
  try {
    const raw = await fs.readFile(p, "utf8");
    return await expandImports(raw, path.dirname(p), 0, seen);
  } catch {
    return "";
  }
}
