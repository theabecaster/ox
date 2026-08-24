#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { render } from "ink";
import React from "react";
import chalk from "chalk";
import {
  applyEnv,
  loadSettings,
  oxDir,
  persistAllowRule,
  projectSlug,
  resolveApiKeyOrFile,
  resolveModel,
} from "./config.js";
import { resolveEndpoint } from "./endpoint.js";
import { HookRunner } from "./hooks.js";
import { loadMemory } from "./memory.js";
import { McpManager, mcpAddServer, mcpListServers, mcpRemoveServer } from "./mcp.js";
import { PermissionManager } from "./permissions.js";
import { Repl } from "./repl/App.js";
import { runHeadless } from "./headless.js";
import { SessionStore } from "./sessions.js";
import { loadSkills } from "./skills.js";
import { buildSystemPrompt } from "./systemprompt.js";
import { buildRegistry, ensureScratchDir } from "./tools/index.js";
import { loadSubagents } from "./subagents.js";
import type { ChatMessage, PermissionMode } from "./types.js";

const VERSION = "0.1.0";

interface CliFlags {
  prompt?: string;
  printMode: boolean;
  continueLast: boolean;
  resumeId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  bypassPermissions: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  maxTurns?: number;
  outputFormat: "text" | "json" | "stream-json";
  verbose: boolean;
  appendSystemPrompt?: string;
  bare: boolean;
}

function parseArgs(argv: string[]): { flags: CliFlags; subcommand?: string[] } {
  const flags: CliFlags = {
    printMode: false,
    continueLast: false,
    bypassPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    addDirs: [],
    outputFormat: "text",
    verbose: false,
    bare: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => argv[++i] ?? "";
    switch (a) {
      case "-p":
      case "--print":
        flags.printMode = true;
        break;
      case "-c":
      case "--continue":
        flags.continueLast = true;
        break;
      case "-r":
      case "--resume":
        flags.resumeId = next();
        break;
      case "--model":
        flags.model = next();
        break;
      case "--permission-mode":
        flags.permissionMode = next() as PermissionMode;
        break;
      case "--dangerously-skip-permissions":
        flags.bypassPermissions = true;
        break;
      case "--allowedTools":
      case "--allowed-tools":
        flags.allowedTools.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--disallowedTools":
      case "--disallowed-tools":
        flags.disallowedTools.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--add-dir":
        flags.addDirs.push(...next().split(" ").map((s) => s.trim()).filter(Boolean));
        break;
      case "--max-turns":
        flags.maxTurns = Number(next());
        break;
      case "--output-format":
        flags.outputFormat = next() as CliFlags["outputFormat"];
        break;
      case "--verbose":
        flags.verbose = true;
        break;
      case "--append-system-prompt":
        flags.appendSystemPrompt = next();
        break;
      case "--bare":
        flags.bare = true;
        break;
      case "--version":
      case "-v":
        console.log(VERSION);
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
        rest.push(a);
    }
  }
  return { flags, subcommand: rest.length > 0 ? rest : undefined };
}

async function main(): Promise<number> {
  let initialMessages: ChatMessage[] = [];
  const argv = process.argv.slice(2);
  if (argv[0] === "update") {
    await cmdUpdate();
    return 0;
  }
  if (argv[0] === "doctor") {
    return cmdDoctor();
  }
  if (argv[0] === "auth") {
    const info = await resolveApiKeyOrFile();
    console.log(JSON.stringify({ loggedIn: Boolean(info.key), source: info.source }));
    return info.key ? 0 : 1;
  }
  if (argv[0] === "mcp") {
    return cmdMcp(argv.slice(1));
  }

  const { flags, subcommand: restWords } = parseArgs(argv);
  const cwd = process.cwd();
  const settings = await loadSettings(cwd);
  applyEnv(settings);

  const keyInfo = await resolveApiKeyOrFile();
  const endpoint = resolveEndpoint({ key: keyInfo.key, keySource: keyInfo.source, settings });
  const model = resolveModel(settings, flags.model);

  const promptText = restWords && restWords.length > 0 ? restWords.join(" ") : undefined;

  if (flags.printMode) {
    if (!promptText && !process.stdin.isTTY) {
      /* headless reads stdin itself */
    }
    if (!promptText && process.stdin.isTTY) {
      console.error("Usage: ox -p \"prompt\"");
      return 2;
    }
    return runHeadless({
      prompt: promptText ?? "",
      cwd,
      modelFlag: flags.model,
      permissionMode: flags.permissionMode,
      bypassPermissions: flags.bypassPermissions,
      maxTurns: flags.maxTurns,
      outputFormat: flags.outputFormat,
      verbose: flags.verbose,
      appendSystemPrompt: flags.appendSystemPrompt,
      allowedTools: flags.allowedTools,
      disallowedTools: flags.disallowedTools,
    });
  }

  await fs.mkdir(oxDir(), { recursive: true });
  await fs.mkdir(path.join(oxDir(), "projects", projectSlug(cwd)), { recursive: true });
  await fs.mkdir(path.join(oxDir(), "tmp"), { recursive: true });

  let session;
  if (flags.continueLast || flags.resumeId) {
    const loaded = flags.resumeId
      ? await SessionStore.load(flags.resumeId, cwd)
      : await SessionStore.latest(cwd);
    if (loaded) {
      session = SessionStore.instance(loaded);
      const msgs = loaded.entries
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: ChatMessage }).message);
      initialMessages = msgs;
      banner(chalk.dim(`resumed "${loaded.meta.title}" (${msgs.length} messages)`));
    } else {
      session = await SessionStore.create({ cwd, title: "new session", model });
      banner(chalk.yellow(flags.resumeId ? `session ${flags.resumeId} not found; starting fresh` : "no previous session; starting fresh"));
    }
  } else {
    session = await SessionStore.create({ cwd, title: "new session", model });
  }

  const [memory, skills, subagentDefs] = await Promise.all([
    flags.bare ? Promise.resolve("") : loadMemory({ cwd }),
    flags.bare ? Promise.resolve([]) : loadSkills(cwd),
    flags.bare ? Promise.resolve(new Map()) : loadSubagents(cwd),
  ]);

  const sessionId = session.meta.id;
  const scratchDir = ensureScratchDir(path.join(oxDir(), "tmp"), sessionId);

  const registry = buildRegistry({ initialCwd: cwd, scratchDir });
  const mcp = new McpManager({ cwd });
  if (!flags.bare) {
    await mcp.startAll();
    for (const impl of mcp.buildToolImpls()) registry.addRaw(impl.def.name, impl);
  }
  registry.updateRoots([cwd, ...flags.addDirs]);

  const permissions = new PermissionManager({
    settings,
    cwd,
    addDirRoots: [...(settings.permissions?.additionalDirectories ?? []), ...flags.addDirs],
    onPersistRule: (rule) => persistAllowRule(rule, cwd),
  });
  if (flags.permissionMode) permissions.mode = flags.permissionMode;
  if (flags.bypassPermissions) permissions.mode = "bypassPermissions";
  for (const rule of flags.allowedTools) permissions.addSessionRule(rule);

  const hooks = new HookRunner(settings.hooks, cwd);
  await hooks.run("SessionStart", { source: flags.continueLast ? "resume" : "startup" });

  const systemPrompt =
    buildSystemPrompt({
      cwd,
      model,
      memory,
      skills: skills.filter((s) => !s.disableModelInvocation),
      mcpServers: mcp.status().filter((s) => s.status === "connected").map((s) => ({ name: s.name, toolCount: s.tools.length })),
      todoEnabled: true,
      planMode: permissions.mode === "plan",
    }) + (flags.appendSystemPrompt ? `\n\n# Additional instructions\n${flags.appendSystemPrompt}` : "");

  banner(`${chalk.bold(chalk.yellowBright("ox"))} ${chalk.dim(`v${VERSION}`)} · ${chalk.dim(model)} · ${chalk.dim(shortCwd(cwd))}`);
  console.log(chalk.dim("no account, no key, no limits — just type what you want. /help for commands.\n"));

  const { waitUntilExit } = render(
    React.createElement(Repl, {
      cwd,
      model,
      apiKey: endpoint.apiKey ?? "ox-gateway",
      baseUrl: endpoint.baseUrl,
      usingGateway: endpoint.usingGateway,
      endpointSource: endpoint.source,
      settings: settings as Record<string, unknown>,
      session,
      registry,
      permissions,
      hooks,
      mcp,
      skills,
      memory,
      systemPrompt,
      initialMessages,
      initialPrompt: promptText,
    }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
  await hooks.run("SessionEnd", { reason: "prompt_input_exit" });
  await mcp.stopAll();
  void subagentDefs;
  return 0;
}

function banner(text: string): void {
  console.log(text);
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

async function cmdUpdate(): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync("npm", ["install", "-g", "oxcode-cli@latest"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(chalk.red("Update failed. Try: npm install -g oxcode-cli@latest"));
  }
}

async function cmdDoctor(): Promise<number> {
  const cwd = process.cwd();
  const keyInfo = await resolveApiKeyOrFile();
  const settings = await loadSettings(cwd);
  const rg = await checkRg();
  const lines = [
    `Ox doctor`,
    "",
    `Version:     ${VERSION}`,
    `Node:        ${process.version}`,
    `Platform:    ${process.platform} ${process.arch}`,
    `API key:     ${keyInfo.source}${keyInfo.key ? "" : " (MISSING)"}`,
    `Model:       ${resolveModel(settings)}`,
    `Ox dir:      ${oxDir()} ${await exists(oxDir()) ? "(ok)" : "(missing)"}`,
    `ripgrep:     ${rg ? "available (fast Grep)" : "not found (JS fallback)"}`,
    `Settings:    ${Object.keys(settings).length > 0 ? "loaded" : "none found"}`,
  ];
  console.log(lines.join("\n"));
  return keyInfo.key ? 0 : 1;
}

async function checkRg(): Promise<boolean> {
  try {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync("rg", ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function cmdMcp(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const sub = args[0];
  const home = process.env.HOME;
  if (sub === "list") {
    const servers = await mcpListServers({ cwd, home });
    if (servers.length === 0) {
      console.log("No MCP servers configured.");
      return 0;
    }
    for (const s of servers) {
      console.log(`${s.name}  [${s.scope}]  ${s.config.command} ${(s.config.args ?? []).join(" ")}`);
    }
    return 0;
  }
  if (sub === "add") {
    let scope: "local" | "project" = "local";
    const restArgs: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-s" || args[i] === "--scope") {
        scope = args[i + 1] === "project" ? "project" : "local";
        i++;
      } else {
        restArgs.push(args[i]!);
      }
    }
    const dashdash = restArgs.indexOf("--");
    if (restArgs.length < 2 || dashdash === -1) {
      console.log('Usage: ox mcp add [-s local|project] <name> -- <command> [args...]');
      return 2;
    }
    const name = restArgs[0]!;
    const command = restArgs[dashdash + 1]!;
    const commandArgs = restArgs.slice(dashdash + 2);
    await mcpAddServer({ scope, name, config: { command, args: commandArgs }, cwd, home });
    console.log(`Added ${name} (${scope}).`);
    return 0;
  }
  if (sub === "remove") {
    const name = args[1];
    if (!name) {
      console.log("Usage: ox mcp remove <name>");
      return 2;
    }
    const removedLocal = await mcpRemoveServer({ scope: "local", name, cwd, home });
    const removedProject = removedLocal ? false : await mcpRemoveServer({ scope: "project", name, cwd, home });
    if (removedLocal || removedProject) {
      console.log(`Removed ${name}.`);
      return 0;
    }
    console.log(`Not found: ${name}`);
    return 1;
  }
  console.log("Usage: ox mcp [list | add | remove]");
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 50);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
