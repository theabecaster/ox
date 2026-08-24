# Ox — implementation plan

Ox is an open-source terminal coding agent in the shape of Claude Code, wired to the
**ox-alpha** model through **OpenRouter**, with zero signup: install and go.

## Product

- Name **Ox**, binary `ox`, npm package `oxcode-cli`, repos `theabecaster/ox` (CLI) and
  private `theabecaster/ox-web` (site).
- Positioning: *unlimited agentic coding — no account, no subscription, no key hunting.*
  The model key ships inside the CLI (obfuscated, env-overridable) so it "just works".
- License MIT. Node ≥ 20.

## Architecture (TypeScript, ESM)

```
src/
  index.ts        arg parsing + subcommand dispatch (repl | -p | doctor | update | mcp …)
  config.ts       paths (~/.ox), settings hierarchy merge, model/key resolution
  embedded.ts     obfuscated OpenRouter key → runtime assembly (env OX_API_KEY overrides)
  api.ts          OpenRouter chat-completions client: SSE streaming, tool_calls, retries
  sse.ts          incremental SSE parser
  agent.ts        agent loop: messages ⇄ tools ⇄ permissions ⇄ hooks, turn caps
  types.ts        Msg/Tool types
  systemprompt.ts system prompt builder (+append flags)
  permissions.ts  rule grammar Tool(spec / prefix *), modes, decision pipeline
  hooks.ts        command hooks, stdin JSON, exit-2 block, matchers
  sessions.ts     JSONL transcript store, resume/continue/rename/export
  memory.ts       AGENTS.md/OX.md discovery, @import expansion
  skills.ts       .ox|.claude commands/*.md + ~/.ox/commands ($ARGUMENTS, allowed-tools)
  subagents.ts    .ox/.claude agents/*.md defs; Explore/general-purpose builtins
  mcp.ts          stdio MCP client (JSON-RPC), .mcp.json, ox mcp add/list/remove
  compaction.ts   auto/manual summarize
  tokens.ts       usage-based accounting + estimator
  tools/*         bash, read, write, edit, glob, grep, webfetch, todo, agent,
                  ask, background(KillShell/BashOutput)
  repl/           Ink UI: App, MarkdownView, PermissionDialog, TodoPanel, StatusBar…
  headless.ts     -p runner; text/json/stream-json emitters
tests/            vitest unit + e2e (mock OpenRouter server over real HTTP)
```

## v1 scope = Claude Code core parity

REPL w/ streaming+queueing+interrupt, permission prompts & Shift+Tab modes, all §2 tools
incl. background bash, sessions/resume, AGENTS.md memory, slash commands + custom md skills,
hooks (6 events), stdio MCP, subagents, plan mode, headless -p w/ stream-json, compaction,
doctor/update. Roadmap: vim mode, HTTP/SSE MCP+OAuth, NotebookEdit, IDE extensions, worktrees.

## Quality gates (prod-ready bar)

1. `tsc --noEmit` clean; eslint flat clean.
2. vitest: unit coverage on every logic module + e2e against a mock OpenRouter HTTP server
   (scripted tool-call transcripts) for both REPL-core and `-p`.
3. Live pass: real OpenRouter call (`ox -p`) from this machine using local key via env.
4. Manual smoke matrix: interactive flows exercised via scripted runs; README examples run.
5. Multiple fix→re-test passes until green; CI must replicate gates exactly.

## Release engineering

- ci.yml: pnpm install, typecheck, lint, test, build on push/PR (Node 20+22 matrix).
- release.yml: tag `v*` → test → build → `npm publish` (NPM_TOKEN secret) → GH Release notes.
- dependabot weekly; branch protection after first push.
