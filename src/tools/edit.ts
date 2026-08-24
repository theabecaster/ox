import fs from "node:fs/promises";
import path from "node:path";
import { withinRoots } from "./write.js";
import type { ToolImpl } from "../types.js";

export function computeEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { ok: true; content: string; count: number } | { ok: false; error: string } {
  if (oldString === "") return { ok: false, error: "old_string must not be empty" };
  let count = 0;
  let idx = content.indexOf(oldString);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(oldString, idx + oldString.length);
  }
  if (count === 0) return { ok: false, error: "old_string not found in file" };
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matches ${count} times; include more surrounding context to make it unique, or set replace_all=true`,
    };
  }
  const next = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, () => newString);
  return { ok: true, content: next, count };
}

function diffPreview(before: string, after: string, maxPairs = 20): string {
  const b = before.split("\n");
  const a = after.split("\n");
  let start = 0;
  while (start < Math.min(b.length, a.length) && b[start] === a[start]) start++;
  let endB = b.length - 1;
  let endA = a.length - 1;
  while (endB >= start && endA >= start && b[endB] === a[endA]) {
    endB--;
    endA--;
  }
  const removed = b.slice(start, endB + 1);
  const added = a.slice(start, endA + 1);
  const lines: string[] = [];
  for (const r of removed) {
    if (lines.length >= maxPairs * 2) break;
    lines.push(`- ${r}`);
  }
  for (const add of added) {
    if (lines.length >= maxPairs * 2) break;
    lines.push(`+ ${add}`);
  }
  if (removed.length + added.length > maxPairs * 2) lines.push("... (diff truncated)");
  return lines.join("\n");
}

export function createEditTool(rootsProvider: () => string[]): ToolImpl {
  return {
    def: {
      name: "Edit",
      description:
        "Replace an exact string in an existing file. old_string must match the current file content exactly and appear exactly once unless replace_all is true. Read the file before editing it.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to edit" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    validate(input) {
      const fp = input.file_path;
      if (typeof fp !== "string" || fp === "") return "file_path is required";
      if (typeof input.old_string !== "string") return "old_string is required";
      if (typeof input.new_string !== "string") return "new_string is required";
      if (!withinRoots(fp, rootsProvider())) return `${fp} is outside the working directories`;
      return null;
    },
    async run(input) {
      const filePath = input.file_path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = input.replace_all === true;

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        return { output: `File not found: ${filePath}. Use Write to create it.`, isError: true };
      }
      const result = computeEdit(content, oldString, newString, replaceAll);
      if (!result.ok) return { output: result.error, isError: true };
      await fs.writeFile(filePath, result.content);
      const preview = diffPreview(content, result.content);
      return {
        output: `${path.resolve(filePath)} edited (${result.count} replacement${result.count === 1 ? "" : "s"})\n${preview}`,
      };
    },
  };
}
