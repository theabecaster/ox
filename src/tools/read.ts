import fs from "node:fs/promises";
import path from "node:path";
import type { ToolImpl } from "../types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_WINDOW = 2000;
const CHAR_GUARD = 400_000;

function mimeFor(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    default:
      return "image/webp";
  }
}

export function formatLine(no: number, text: string): string {
  return `${String(no).padStart(6)}\t${text}`;
}

export function createReadTool(): ToolImpl {
  return {
    def: {
      name: "Read",
      description:
        "Read a file from disk. Returns numbered lines. Default window is the first 2000 lines; use offset (1-indexed line) and limit to page through large files — truncated reads are marked [PARTIAL view]. Images (png/jpg/gif/webp) are returned visually.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute or relative path to the file" },
          offset: { type: "number", description: "1-indexed line number to start from" },
          limit: { type: "number", description: "Number of lines to read" },
        },
        required: ["file_path"],
      },
    },
    async run(input) {
      const filePath = typeof input.file_path === "string" ? input.file_path : null;
      if (!filePath) return { output: "file_path is required", isError: true };
      const offset = typeof input.offset === "number" && input.offset >= 1 ? Math.floor(input.offset) : 1;
      const limit =
        typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_WINDOW;

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return { output: `File not found: ${filePath}`, isError: true };
      }
      if (stat.isDirectory()) {
        return { output: `${filePath} is a directory (use Bash ls or Glob instead)`, isError: true };
      }
      if (stat.size > 100 * 1024 * 1024) {
        return { output: `File exceeds 100MB and cannot be read`, isError: true };
      }

      const ext = path.extname(filePath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        if (stat.size > MAX_IMAGE_BYTES) {
          return { output: `Image too large (${stat.size} bytes)`, isError: true };
        }
        const buf = await fs.readFile(filePath);
        const dataUrl = `data:${mimeFor(ext)};base64,${buf.toString("base64")}`;
        return { output: `[Image attached: ${filePath}]`, images: [{ url: dataUrl }] };
      }

      const raw = await fs.readFile(filePath, "utf8");
      const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      const lines = normalized.split("\n");
      if (raw === "") {
        return { output: "(empty file)" };
      }
      if (offset > lines.length) {
        return { output: `File has ${lines.length} lines` };
      }
      const end = Math.min(offset - 1 + limit, lines.length);

      const out: string[] = [];
      let chars = 0;
      let lastPrinted = offset - 1;
      for (let i = offset - 1; i < end; i++) {
        const formatted = formatLine(i + 1, lines[i] ?? "");
        if (chars + formatted.length > CHAR_GUARD) break;
        out.push(formatted);
        chars += formatted.length + 1;
        lastPrinted = i + 1;
      }

      if (lastPrinted < lines.length) {
        out.push(
          `[PARTIAL view: lines ${offset}-${lastPrinted} of ${lines.length}. Use offset=${lastPrinted + 1}${lastPrinted + 1 + limit <= lines.length ? ` limit=${limit}` : ""} to continue.]`,
        );
      }
      return { output: out.join("\n") };
    },
  };
}
