import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ToolImpl } from "../types.js";

export interface GrepOptions {
  pattern: string;
  root: string;
  glob?: string;
  outputMode: "files_with_matches" | "content" | "count";
  caseInsensitive?: boolean;
  multiline?: boolean;
  headLimit?: number;
  offset?: number;
}

let rgAvailableCache: boolean | null = null;

export async function rgAvailable(): Promise<boolean> {
  if (rgAvailableCache !== null) return rgAvailableCache;
  try {
    const proc = spawnSync("rg", ["--version"], { stdio: "ignore" });
    rgAvailableCache = !proc.error && proc.status === 0;
  } catch {
    rgAvailableCache = false;
  }
  return rgAvailableCache;
}

export function setRgAvailable(v: boolean | null): void {
  rgAvailableCache = v;
}

export async function grepJs(
  root: string,
  opts: GrepOptions,
): Promise<string[]> {
  let regex: RegExp;
  try {
    regex = new RegExp(
      opts.pattern,
      `${opts.caseInsensitive ? "i" : ""}${opts.multiline ? "s" : ""}g`.replace("gg", "g"),
    );
  } catch (err) {
    return [`invalid pattern: ${err instanceof Error ? err.message : String(err)}`];
  }
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat) return [`path not found: ${root}`];

  if (stat.isFile()) {
    return grepFile(root, regex, opts);
  }
  const files = await fg("**/*", {
    cwd: root,
    dot: true,
    absolute: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  const out: string[] = [];
  for (const f of files) {
    if (opts.glob) {
      const base = path.basename(f);
      const rel = path.relative(root, f);
      const re = globToRegExp(opts.glob);
      if (!re.test(base) && !re.test(rel)) continue;
    }
    const lines = await grepFile(f, regex, opts);
    out.push(...lines);
    if (out.length > 5000) break;
  }
  return out;
}

async function grepFile(file: string, regex: RegExp, opts: GrepOptions): Promise<string[]> {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || st.size > 2 * 1024 * 1024) return [];
  let content: string;
  try {
    content = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  if (opts.outputMode === "content") {
    const lines = opts.multiline ? [content] : content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i] ?? "")) {
        out.push(`${file}:${i + 1}:${(lines[i] ?? "").slice(0, 400)}`);
        if (out.length > 2000) break;
      }
    }
  } else if (opts.outputMode === "count") {
    let count = 0;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      count++;
      if (m[0] === "") regex.lastIndex++;
    }
    if (count > 0) out.push(`${file}:${count}`);
  } else {
    regex.lastIndex = 0;
    if (regex.test(content)) out.push(file);
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let rx = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        rx += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += ".";
    } else if ("\\.+^${}()|[]".includes(c)) {
      rx += `\\${c}`;
    } else {
      rx += c;
    }
  }
  return new RegExp(`^${rx}$`);
}

function buildRgArgs(opts: GrepOptions): string[] {
  const args: string[] = ["--no-messages"];
  if (opts.outputMode === "files_with_matches") args.push("-l");
  else if (opts.outputMode === "count") args.push("-c");
  else args.push("-n");
  if (opts.caseInsensitive) args.push("-i");
  if (opts.multiline) args.push("-U", "--multiline-dotall");
  if (opts.glob) args.push("--glob", opts.glob);
  args.push("--");
  args.push(opts.pattern);
  return args;
}

export function createGrepTool(defaultRootProvider: () => string): ToolImpl {
  return {
    def: {
      name: "Grep",
      description:
        "Search file contents with a regular expression. output_mode: 'files_with_matches' (default), 'content' (prints file:line:text), or 'count'. Supports glob file filters (e.g. '*.ts'), case-insensitive and multiline modes, head_limit/offset paging. Respects .gitignore.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: { type: "string", description: "File or directory to search (default working directory)" },
          glob: { type: "string", description: "Glob filter like *.ts or **/*.{js,jsx}" },
          output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
          "-i": { type: "boolean", description: "Case insensitive" },
          multiline: { type: "boolean", description: "Allow pattern to span lines" },
          head_limit: { type: "number", description: "Max results" },
          offset: { type: "number", description: "Skip first N results" },
        },
        required: ["pattern"],
      },
    },
    validate(input) {
      if (typeof input.pattern !== "string" || input.pattern === "")
        return "pattern is required";
      try {
        new RegExp(input.pattern);
      } catch (err) {
        return `invalid pattern: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    },
    async run(input) {
      const pattern = input.pattern as string;
      const root = typeof input.path === "string" ? input.path : defaultRootProvider();
      const opts: GrepOptions = {
        pattern,
        root,
        glob: typeof input.glob === "string" ? input.glob : undefined,
        outputMode:
          input.output_mode === "content"
            ? "content"
            : input.output_mode === "count"
              ? "count"
              : "files_with_matches",
        caseInsensitive: input["-i"] === true,
        multiline: input.multiline === true,
        headLimit: typeof input.head_limit === "number" ? input.head_limit : undefined,
        offset: typeof input.offset === "number" ? input.offset : undefined,
      };

      let results: string[];
      if (await rgAvailable()) {
        results = await grepRg(root, opts);
      } else {
        results = await grepJs(root, opts);
      }

      if (results.length === 1) {
        const first = results[0]!;
        if (first.startsWith("invalid pattern:")) {
          return { output: first, isError: true };
        }
        if (first.startsWith("path not found:") || first.startsWith("rg error:")) {
          return { output: first, isError: true };
        }
      }
      const offset = opts.offset ?? 0;
      const limit = opts.headLimit ?? 100;
      const paged = results.slice(offset, offset + limit);
      if (paged.length === 0) {
        return { output: offset > 0 ? "No entries at this offset" : "No matches found" };
      }
      const totalNote =
        results.length > paged.length
          ? `\n(showing ${paged.length} of ${results.length})`
          : "";
      if (opts.outputMode === "count") {
        const grandTotal = results.reduce((acc, r) => acc + (Number(r.split(":").pop()) || 0), 0);
        return { output: `${paged.join("\n")}\ntotal: ${grandTotal}${totalNote}` };
      }
      return { output: paged.join("\n") + totalNote };
    },
  };
}

async function grepRg(root: string, opts: GrepOptions): Promise<string[]> {
  const absRoot = path.resolve(root);
  const st = await fsp.stat(absRoot);
  const cwd = st.isDirectory() ? absRoot : path.dirname(absRoot);
  const target = st.isDirectory() ? "." : path.basename(absRoot);
  const args = [...buildRgArgs(opts), target];

  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => resolve(["rg spawn failed"]));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        resolve([`rg error: ${stderr.trim().slice(0, 300) || `exited with ${code}`}`]);
        return;
      }
      const lines = stdout.split("\n").filter((l) => l.trim() !== "");
      resolve(lines);
    });
  });
}
