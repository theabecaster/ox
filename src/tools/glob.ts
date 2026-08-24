import fs from "node:fs/promises";
import fg from "fast-glob";
import type { ToolImpl } from "../types.js";

export async function globSorted(pattern: string, root: string, cap = 100): Promise<{ files: string[]; total: number }> {
  const files = await fg(pattern, {
    cwd: root,
    dot: false,
    absolute: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  const withMtime = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await fs.stat(f);
        return { f, m: st.mtimeMs };
      } catch {
        return { f, m: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.m - a.m);
  return { files: withMtime.slice(0, cap).map((x) => x.f), total: withMtime.length };
}

export function createGlobTool(): ToolImpl {
  return {
    def: {
      name: "Glob",
      description:
        "Find files by glob pattern (supports ** recursion and braces like *.{ts,tsx}). Returns up to 100 paths sorted by modification time. Use Grep to search file contents. Pattern is relative to path (defaults to the working directory).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern e.g. src/**/*.test.ts or *.{json,yaml}" },
          path: { type: "string", description: "Directory to search in (default: working directory)" },
        },
        required: ["pattern"],
      },
    },
    async run(input) {
      const pattern = typeof input.pattern === "string" ? input.pattern : null;
      if (!pattern || pattern === "") return { output: "pattern is required", isError: true };
      const root = typeof input.path === "string" ? input.path : process.cwd();
      try {
        await fs.access(root);
      } catch {
        return { output: `path does not exist: ${root}`, isError: true };
      }
      const { files, total } = await globSorted(pattern, root);
      if (files.length === 0) return { output: "No files found" };
      const suffix =
        total > files.length ? `\n(showing ${files.length} of ${total} — narrow the pattern)` : "";
      return { output: files.join("\n") + suffix };
    },
  };
}
