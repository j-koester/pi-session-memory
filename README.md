# pi-session-memory

A [pi](https://pi.dev) extension that gives the agent persistent memory across sessions. Automatically injects context from previous sessions and lets the LLM search through past work.

## What it does

On each session start, a compact summary of recent sessions is injected into context so the LLM knows what happened before. Three tools let it dig deeper on demand:

- **`list_sessions`** – browse past sessions with metadata
- **`search_sessions`** – full-text search across session content
- **`get_session_summary`** – LLM-generated summary of any session (cached)

All tools support cross-project access via an optional `path` parameter.

Sessions are auto-summarized on shutdown (if short enough). For larger histories, run `/memory-update` to batch-generate summaries. Stale memory triggers a warning.

## Install

```bash
pi install git:github.com/j-koester/pi-session-memory
```

Or clone manually:

```bash
git clone https://github.com/j-koester/pi-session-memory.git ~/.pi/agent/extensions/pi-session-memory
```

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
