# pi-session-memory

[![npm](https://img.shields.io/npm/v/@netzlabor/pi-session-memory)](https://www.npmjs.com/package/@netzlabor/pi-session-memory)
[![GitHub release](https://img.shields.io/github/v/release/j-koester/pi-session-memory?include_prereleases)](https://github.com/j-koester/pi-session-memory/releases)
[![pi compatible](https://img.shields.io/badge/pi-v1.0%2B%20compatible-brightgreen)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [pi](https://pi.dev) extension that gives the agent persistent memory across sessions. Automatically injects context from previous sessions and lets the LLM search through past work.

## What it does

On each session start, a compact summary of recent sessions is injected into context so the LLM knows what happened before. Three tools let it dig deeper on demand:

- **`list_sessions`** – browse past sessions with metadata
- **`search_sessions`** – full-text search across session content
- **`get_session_summary`** – LLM-generated summary of any session (cached)

All tools support cross-project access via an optional `path` parameter.

Sessions are auto-summarized on shutdown (if short enough). For larger histories, run `/memory-update` to batch-generate summaries. Stale memory triggers a warning.

## Install

From npm (recommended):

```bash
pi install npm:@netzlabor/pi-session-memory
```

Or directly from GitHub:

```bash
pi install git:github.com/j-koester/pi-session-memory@v0.1.1
```

Or clone manually:

```bash
git clone https://github.com/j-koester/pi-session-memory.git ~/.pi/agent/extensions/pi-session-memory
```

**Compatibility:** Tested with pi v1.0.0. No breaking API usage; uses `registerTool`, `registerCommand`, and the `session_start` / `session_shutdown` / `before_agent_start` events, all stable in the 1.0 extension API.

## Commands

| Command | What it does |
|---------|-------------|
| `/memory-update [n]` | Generate summaries for unsummarized sessions (Esc to cancel) |
| `/memory-status` | Cache stats |
| `/memory-clear` | Wipe cached summaries |

## How it works

Session JSONL files are read from `~/.pi/agent/sessions/`. Summaries and metadata are cached per project in `~/.pi/agent/session-memory/`. The auto-injected context stays under ~1000 tokens.

## License

MIT
