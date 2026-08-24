import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "./skills.js";

export interface SubagentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: string;
}

function builtin(name: string, description: string, systemPrompt: string): SubagentDef {
  return { name, description, systemPrompt, source: "builtin" };
}

export const BUILTIN_SUBAGENTS: Map<string, SubagentDef> = new Map(
  [
    [
      "Explore",
      builtin(
        "Explore",
        "Fast read-only codebase explorer. Use for finding files, searching code, and answering questions about the codebase. Supports thoroughness: quick | medium | very thorough.",
        [
          "You are a senior code-explorer agent. You investigate codebases and report findings.",
          "You have READ-ONLY intent: never modify files. Search broadly (glob/grep/read), follow imports,",
          "and answer with concrete file paths and line references in the form path:line.",
          "Respect the requested thoroughness. End with a dense findings summary.",
        ].join(" "),
      ),
    ],
    [
      "general-purpose",
      builtin(
        "general-purpose",
        "General-purpose agent for researching complex questions and executing multi-step tasks with all tools.",
        [
          "You are a general-purpose coding agent working on a delegated task.",
          "Use the available tools to research and act, then produce a single dense final report.",
          "You cannot ask the user questions; make reasonable decisions and document them.",
        ].join(" "),
      ),
    ],
  ] as Array<[string, SubagentDef]>,
);

async function loadDir(dir: string, source: string): Promise<SubagentDef[]> {
  let files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
  const out: SubagentDef[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, "utf8");
      const { attrs, body } = parseFrontmatter(raw);
      const name = attrs["name"];
      const description = attrs["description"];
      if (typeof name !== "string" || typeof description !== "string") continue;
      const toolsAttr = attrs["tools"];
      out.push({
        name,
        description,
        tools: Array.isArray(toolsAttr)
          ? toolsAttr.map(String)
          : typeof toolsAttr === "string"
            ? toolsAttr.split(/[ ,]+/).filter(Boolean)
            : undefined,
        model: typeof attrs["model"] === "string" ? attrs["model"] : undefined,
        systemPrompt: body,
        source,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export async function loadSubagents(cwd: string, home?: string): Promise<Map<string, SubagentDef>> {
  const h = home ?? os.homedir();
  const map = new Map(BUILTIN_SUBAGENTS);
  const layers: Array<{ dir: string; source: string; override: boolean }> = [
    { dir: path.join(h, ".ox", "agents"), source: "user", override: false },
    { dir: path.join(cwd, ".claude", "agents"), source: "project-compat", override: true },
    { dir: path.join(cwd, ".ox", "agents"), source: "project", override: true },
  ];
  for (const layer of layers) {
    for (const def of await loadDir(layer.dir, layer.source)) {
      if (layer.override || !map.has(def.name)) map.set(def.name, def);
      else map.set(def.name, def);
    }
  }
  return map;
}
