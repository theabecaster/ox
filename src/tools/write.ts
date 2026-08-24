import fs from "node:fs/promises";
import path from "node:path";
import type { ToolImpl } from "../types.js";

export function withinRoots(p: string, roots: string[]): boolean {
  const abs = path.resolve(p);
  return roots.some((r) => abs === path.resolve(r) || abs.startsWith(path.resolve(r) + path.sep));
}

export function createWriteTool(rootsProvider: () => string[]): ToolImpl {
  return {
    def: {
      name: "Write",
      description:
        "Write a file to disk, creating parent directories as needed. Overwrites the entire file content (never appends or merges). Prefer Edit for targeted changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to write" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["file_path", "content"],
      },
    },
    validate(input) {
      const fp = input.file_path;
      if (typeof fp !== "string" || fp === "") return "file_path is required";
      if (typeof input.content !== "string") return "content is required";
      if (!withinRoots(fp, rootsProvider())) {
        return `${fp} is outside the working directories`;
      }
      return null;
    },
    async run(input) {
      const filePath = input.file_path as string;
      const content = input.content as string;
      let existed = false;
      try {
        existed = (await fs.stat(filePath)).isFile();
      } catch {
        existed = false;
      }
      await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
      await fs.writeFile(filePath, content);
      const lines = content === "" ? 0 : content.split("\n").length;
      return {
        output: `Wrote ${filePath} (${Buffer.byteLength(content)} bytes, ${lines} lines)${existed ? " — overwrote existing file" : ""}`,
      };
    },
  };
}
