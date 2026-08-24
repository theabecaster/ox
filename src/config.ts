import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_GATEWAY_URL,
  type HookMatcher,
  type PermissionMode,
  type Settings,
} from "./types.js";

export function oxDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".ox");
}

export function projectSlug(cwd: string): string {
  const abs = path.resolve(cwd);
  return (
    abs
      .split(/[\\/]/)
      .filter(Boolean)
      .join("-")
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root"
  );
}

export interface ResolvedKey {
  key: string | null;
  source: "env:OX_API_KEY" | "env:OPENROUTER_API_KEY" | "file" | "none";
}

export function resolveApiKey(env?: Record<string, string | undefined>): ResolvedKey {
  const e = env ?? process.env;
  const ox = e.OX_API_KEY?.trim();
  if (ox) return { key: ox, source: "env:OX_API_KEY" };
  const or = e.OPENROUTER_API_KEY?.trim();
  if (or) return { key: or, source: "env:OPENROUTER_API_KEY" };
  return { key: null, source: "none" };
}

export async function readKeyFile(home?: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(oxDir(home), "key"), "utf8");
    const key = raw.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function resolveApiKeyOrFile(env?: Record<string, string | undefined>, home?: string): Promise<ResolvedKey> {
  const direct = resolveApiKey(env);
  if (direct.key) return direct;
  const fromFile = await readKeyFile(home);
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: null, source: "none" };
}

export function resolveBaseUrl(settings?: Partial<Settings>, env?: Record<string, string | undefined>): string {
  const e = env ?? process.env;
  return e.OX_BASE_URL ?? settings?.gateway ?? DEFAULT_GATEWAY_URL;
}

export function settingsPaths(
  cwd: string,
  home?: string,
): { user: string; project: string; local: string } {
  return {
    user: path.join(oxDir(home), "settings.json"),
    project: path.join(cwd, ".ox", "settings.json"),
    local: path.join(cwd, ".ox", "settings.local.json"),
  };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function mergeSettings(layers: Array<Partial<Settings> | undefined>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const perms: NonNullable<Settings["permissions"]> = {};
  const hooks: Record<string, HookMatcher[]> = {};
  const env: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.model !== undefined) out.model = layer.model;
    if (layer.theme !== undefined) out.theme = layer.theme;
    if (layer.todoEnabled !== undefined) out.todoEnabled = layer.todoEnabled;
    if (layer.autoCompactTokens !== undefined) out.autoCompactTokens = layer.autoCompactTokens;
    if (layer.contextWindowTokens !== undefined) out.contextWindowTokens = layer.contextWindowTokens;
    const p = layer.permissions;
    if (p) {
      if (p.allow) perms.allow = dedupe([...(perms.allow ?? []), ...p.allow]);
      if (p.deny) perms.deny = dedupe([...(perms.deny ?? []), ...p.deny]);
      if (p.ask) perms.ask = dedupe([...(perms.ask ?? []), ...p.ask]);
      if (p.additionalDirectories)
        perms.additionalDirectories = dedupe([
          ...(perms.additionalDirectories ?? []),
          ...p.additionalDirectories,
        ]);
      if (p.defaultMode !== undefined) perms.defaultMode = p.defaultMode;
    }
    if (layer.hooks) {
      for (const [event, matchers] of Object.entries(layer.hooks)) {
        hooks[event] = [...(hooks[event] ?? []), ...matchers];
      }
    }
    if (layer.env) Object.assign(env, layer.env);
  }
  if (
    perms.allow ||
    perms.deny ||
    perms.ask ||
    perms.defaultMode !== undefined ||
    perms.additionalDirectories
  ) {
    out.permissions = perms;
  }
  if (Object.keys(hooks).length > 0) out.hooks = hooks as Settings["hooks"];
  if (Object.keys(env).length > 0) out.env = env;
  return out;
}

async function readJsonFile(p: string): Promise<Partial<Settings> | undefined> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as Partial<Settings>;
  } catch {
    return undefined;
  }
}

export async function loadSettings(
  cwd: string,
  extra?: Partial<Settings>,
  home?: string,
): Promise<Partial<Settings>> {
  const paths = settingsPaths(cwd, home);
  const [user, project, local] = await Promise.all([
    readJsonFile(paths.user),
    readJsonFile(paths.project),
    readJsonFile(paths.local),
  ]);
  return mergeSettings([user, project, local, extra]);
}

export function applyEnv(settings: Partial<Settings>): void {
  if (!settings.env) return;
  for (const [k, v] of Object.entries(settings.env)) process.env[k] = v;
}

export function resolveModel(
  settings: Partial<Settings>,
  flagModel?: string,
  env?: Record<string, string | undefined>,
): string {
  const e = env ?? process.env;
  return flagModel ?? e.OX_MODEL ?? settings.model ?? DEFAULT_MODEL;
}

export async function persistAllowRule(rule: string, cwd: string, home?: string): Promise<void> {
  const p = settingsPaths(cwd, home).local;
  let current: Partial<Settings> = {};
  try {
    current = JSON.parse(await fs.readFile(p, "utf8")) as Partial<Settings>;
  } catch {
    current = {};
  }
  const allow = new Set(current.permissions?.allow ?? []);
  allow.add(rule);
  const next: Partial<Settings> = {
    ...current,
    permissions: { ...current.permissions, allow: [...allow] },
  };
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(next, null, 2) + "\n");
}

export function defaultPermissionMode(settings: Partial<Settings>): PermissionMode {
  return settings.permissions?.defaultMode ?? "default";
}
