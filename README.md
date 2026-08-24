# Ox

**The open coding agent.** A terminal-native AI pair-programmer in the spirit of Claude Code,
powered by the `ox-alpha` model through OpenRouter.

```
npm i -g oxcode-cli
cd your-project
ox
```

No account. No subscription. No key hunting.

## What it does

Ox lives in your terminal, reads your codebase, edits files, runs commands, searches,
tracks its own progress, asks you questions when stuck, and verifies its work —
the full agentic loop:

- **Interactive REPL** — streaming answers, message queueing, Esc to interrupt,
  per-project session history, Shift+Tab permission modes (`manual` → `accept edits` → `plan` → `bypass`).
- **Tools** — Bash (with background tasks + KillShell), Read (line-numbered, images),
  Write, Edit (exact-string replace), Glob, Grep (ripgrep fast-path), WebFetch, TodoWrite,
  AskUserQuestion, plus any MCP tool.
- **Subagents** — isolated context windows for exploration: built-in `Explore` and
  `general-purpose`, or define your own in `.ox/agents/*.md`.
- **Memory** — `AGENTS.md` / `OX.md` loaded from your home dir and every ancestor of your
  project, with `@import` support (CLAUDE.md picked up as a compatibility fallback).
- **Skills** — custom slash commands from `.ox/commands/*.md` or `.claude/commands/*.md`
  with `$ARGUMENTS` substitution and `allowed-tools`.
- **Hooks** — shell-command policy on SessionStart/End, UserPromptSubmit, PreToolUse
  (allow/deny/ask), PostToolUse and Stop events, configured in settings files.
- **MCP** — connect stdio servers via `.mcp.json` or `ox mcp add`; their tools show up as
  `mcp__server__tool`.
- **Headless** — `ox -p "…"` for scripts and CI, with `--output-format text|json|stream-json`,
  stdin piping, `--max-turns`, allow/deny tool lists.

## Model access

Ox talks OpenRouter's chat-completions API. Endpoint resolution:

1. `OX_BASE_URL` env or `gateway` in settings (advanced),
2. your own key (`OX_API_KEY` > `OPENROUTER_API_KEY` > `~/.ox/key`) against OpenRouter directly,
3. otherwise the bundled free gateway.

Model selection: `OX_MODEL` env > `model` setting > default `stealth/ox-alpha`.

## Settings

Precedence: flags > `.ox/settings.local.json` > `.ox/settings.json` > `~/.ox/settings.json`.

```jsonc
// .ox/settings.json
{
  "model": "stealth/ox-alpha",
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(git status)", "Bash(npm run test *)"],
    "deny": ["Read(./.env)"],
    "additionalDirectories": []
  },
  "env": {},
  "autoCompactTokens": 160000
}
```

Permission rules use `Tool(specifier)` grammar: `Bash(git diff *)` (prefix), `Edit(/src/**)`
(glob), `WebFetch(domain:example.com)`.

## Sessions

Transcripts are append-only JSONL under `~/.ox/projects/<project>/`. Continue where you left off:

```sh
ox -c              # most recent session in this project
ox -r <session-id> # resume by id (any project)
```

In-session: `/resume` lists recent sessions, `/export` writes markdown, `/compact`
summarizes long conversations (also runs automatically near the context limit).

## Slash commands

`/help` `/init` `/compact` `/clear` `/model` `/resume` `/permissions` `/memory` `/config`
`/status` `/cost` `/add-dir` `/agents` `/hooks` `/mcp` `/doctor` `/export` `/exit`

## Development

```sh
git clone https://github.com/theabecaster/ox && cd ox
npm install
npm run check   # typecheck + lint + test + build
```

## License

[AGPL-3.0](./LICENSE) — forks must stay open. See [SECURITY.md](./SECURITY.md) for key-handling notes.
