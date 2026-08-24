# Ox — Claude Code feature map (research summary)

What follows is the inventoried behavior of Anthropic's Claude Code CLI (docs fetched 2026-08-23)
that Ox mirrors. Sources: code.claude.com/docs (cli-reference, commands, interactive-mode,
settings, memory, headless, model-config, tools-reference, sub-agents, hooks, mcp).

## 1. CLI surface

- `claude` → interactive REPL; `claude "q"` initial prompt; `claude -p "q"` headless; stdin pipe.
- `claude -c` continue most recent session in cwd; `claude -r <id|name> [q]` resume w/ picker;
  `--fork-session`, `--session-id`, `-n/--name`.
- `claude doctor` diagnostics; `claude update`; `claude mcp …` server management; typo
  suggestions ("Did you mean…?").
- Flags: `--model`, `--permission-mode {default,acceptEdits,plan,bypassPermissions}`,
  `--dangerously-skip-permissions`, `--allowedTools` / `--disallowedTools` (rule patterns),
  `--add-dir`, `--system-prompt`/`--append-system-prompt[,-file]`, `--max-turns`,
  `--output-format {text,json,stream-json}`, `--verbose`, `--settings <file|json>`,
  `--agents '<json>'`, `--mcp-config`, `--bare`.

## 2. Tools (function-calling) & exact behaviors

| Tool | Key params / behavior |
|---|---|
| Bash | `command`, `description?`, `timeout? ms` (default 120s, cap 600s→bg), `run_in_background`. cd persists; env doesn't. Output >30k chars → file path + preview. Exit 1 = success for grep/find/diff/test/git diff family |
| Read | `file_path`, `offset` (1-indexed), `limit`. 2000-line default page, token-capped PARTIAL view; images returned visually; must-read-before-edit gate |
| Write | `file_path`, `content`; overwrite requires prior Read; new files exempt |
| Edit | exact-string replace; `replace_all`; error on multiple matches; read-first gate |
| Glob | `pattern`, `path?`; `**`, braces; mtime sort; ignores gitignored by default; cap 100 |
| Grep | ripgrep regex; `path?`, `glob?`, `type?`, `output_mode {files_with_matches,content,count}`, `-i`, `multiline`, head_limit/offset; respects .gitignore |
| WebFetch | `url`, `prompt`; HTML→MD, model extracts answer; https upgrade; no cross-host redirect follow |
| TodoWrite | todo list state (content/status/priority); rendered as checklist UI |
| Agent (Task) | subagent in isolated context w/ own window; returns single final report; types incl. built-in Explore (read-only), general-purpose; custom `.claude/agents/*.md` frontmatter name/description/tools/model |
| AskUserQuestion | 1–4 questions × options, multiSelect; renders picker UI |
| EnterPlanMode/ExitPlanMode | plan mode transitions; Exit presents plan for approval |
| KillShell/BashOutput | manage run_in_background tasks |

Permission rule grammar: `Tool(specifier)`, trailing ` *` prefix match; `Bash(git log *)`,
`Read(./.env)`, `Edit(/src/**)`; lists in settings `permissions.{allow,deny,ask}` merge across
scopes; modes cycled via Shift+Tab: default → acceptEdits → plan → bypassPermissions(flag).

## 3. Sessions/memory/settings

- Transcripts: JSONL per session under `~/.claude/projects/<slug>/`; `/resume`, `--continue`,
  `/rename`, `/export`; per-directory prompt history.
- Memory: CLAUDE.md hierarchy (user `~/.claude/CLAUDE.md` → project `./CLAUDE.md`|.claude/CLAUDE.md
  → CLAUDE.local.md; ancestors root-down; lazy subdir load; `@path` imports ≤4 hops).
  Ox equivalent: AGENTS.md standard + OX.md alias.
- Settings precedence: CLI flags > project local (.claude/settings.local.json) > project shared >
  user (~/.claude/settings.json). Keys: permissions{allow,deny,ask,defaultMode}, env, model,
  hooks, autocompact window. "Don't ask again" writes allow rules to local file.
- Compaction: `/compact [instructions]` + auto near context limit → LLM summary replaces history.

## 4. Interactive UX

- Streaming answers; spinner; message queueing mid-turn; Esc interrupt; Ctrl+C clear/exit;
  history (up/down, per-project); Ctrl+R search; multiline (`\`+Enter, Shift+Enter, Ctrl+J);
  paste detection; vim mode (roadmap); @file mentions inject contents; `!` shell passthrough
  (output enters context); image attach; slash-command autocomplete menu; status line
  (model/mode/context); transcript view (Ctrl+O); /cost usage; /doctor; theme setting.
- Built-in slash commands (108 total): core set we mirror — /help /clear /compact /model /resume
  /init /memory /permissions /config /status /doctor /cost /export /exit /add-dir /agents /hooks
  /mcp /review /bug /theme /vim(roadmap) + custom md commands/skills ($ARGUMENTS, allowed-tools).

## 5. Headless

- `-p`: exit 0/non-zero; stdin pipe ≤10MB; output formats text/json/stream-json (NDJSON events);
  `--include-partial-messages`; `--max-turns`; permission mode Manual default; skills callable
  via prompt string; SIGTERM=143.

## 6. Hooks

Events: SessionStart/End, UserPromptSubmit, PreToolUse, PostToolUse, Stop, Notification…
Config in settings `hooks.<Event>[{matcher, hooks:[{type:"command",command,timeout}]}]`;
stdin JSON `{session_id, tool_name, tool_input…}`; exit 2 = block (+stderr reason);
JSON out `{decision:"block"|"approve", reason}`; PreToolUse decision allow/deny/ask.

## 7. MCP

`claude mcp add/list/get/remove [-s user|project|local]`; stdio/http/sse transports;
`.mcp.json` at repo root (project scope, approval-gated); tools named `mcp__<server>__<tool>`;
env expansion `${VAR}`; OAuth deferred (roadmap in Ox).

## 8. Explicit non-goals (enterprise/cloud)

Claude.ai sessions/artifacts, remote control, agent teams, managed policy/MDM, Bedrock/Vertex/
Foundry plumbing, voice, Chrome integration, phone push, cloud routines, ultrareview.
