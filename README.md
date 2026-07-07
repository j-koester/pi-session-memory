# pi-session-memory

A [pi](https://pi.dev) extension that gives the agent persistent memory across sessions. It auto-injects a compact project memory at the start of each session and provides tools for searching, listing, and summarizing past sessions – including cross-project access.

## Features

- **Auto-injected project memory** – On the first prompt of each session, a compact summary of recent sessions is injected into context (hidden from TUI, visible to the LLM)
- **`list_sessions`** – Browse past sessions with date, name, first message preview, and message count
- **`search_sessions`** – Full-text search across all session content with context snippets
- **`get_session_summary`** – LLM-generated detailed session summary (cached after first generation)
- **Cross-project access** – All tools accept an optional `path` parameter to search sessions from other project directories
- **`/memory-update`** – Batch-generate summaries and build comprehensive project memory
- **`/memory-status`** – Show cache statistics
- **`/memory-clear`** – Reset the memory cache

## Install

```bash
pi install git:github.com/jenskoestr/pi-session-memory
```

Or for manual installation, clone into your global extensions directory:

```bash
git clone https://github.com/jenskoestr/pi-session-memory.git ~/.pi/agent/extensions/pi-session-memory
```

## Usage

### Automatic Memory

After installation, every new session automatically receives a project memory injection on the first prompt. This gives the LLM awareness of what happened in previous sessions without any manual action.

- If `/memory-update` has been run before → a comprehensive project memory with session summaries is injected
- Otherwise → a lightweight list of recent sessions with metadata is injected

### Building Project Memory

Run `/memory-update` to generate LLM summaries for all past sessions and compile them into a project memory:

```
/memory-update        # Process all sessions without summaries
/memory-update 10     # Process only the 10 most recent
```

This uses the currently active model. A confirmation dialog shows the number of LLM calls before proceeding.

### Tools

The LLM can use these tools autonomously when it needs context from past sessions:

```
# List sessions
list_sessions({ limit: 20 })

# Search across sessions
search_sessions({ query: "auth refactoring" })

# Get detailed summary
get_session_summary({ sessionFile: "2026-07-07T..." })

# Cross-project access
search_sessions({ query: "TYPO3 workspace", path: "/home/user/projects/my-lib" })
list_sessions({ path: "/home/user/projects/other-project" })
```

### Commands

| Command | Description |
|---------|-------------|
| `/memory-update [limit]` | Generate summaries and build project memory |
| `/memory-status` | Show cache statistics |
| `/memory-clear` | Clear the memory cache for current directory |

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Auto-Context (before_agent_start)                   │
│  → Injects compact project memory on first prompt    │
├─────────────────────────────────────────────────────┤
│  Tools (list / search / summary)                     │
│  → LLM searches and reads past sessions on demand    │
├─────────────────────────────────────────────────────┤
│  Cache Layer (~/.pi/agent/session-memory/)            │
│  → Persisted session metadata and LLM summaries      │
└─────────────────────────────────────────────────────┘
```

### Session Discovery

Sessions are discovered from pi's session storage (`~/.pi/agent/sessions/`), organized by working directory. The extension reads JSONL session files directly.

### Caching

Summaries and metadata are cached per project directory in `~/.pi/agent/session-memory/<hash>.json`. The cache detects file changes via file size and regenerates metadata when needed. LLM-generated summaries are cached permanently until `/memory-clear` is run.

### Context Budget

The auto-injected project memory is designed to be lightweight:
- With `/memory-update`: ~500–1000 tokens (15 session summaries, truncated)
- Without: ~200–400 tokens (session list with metadata only)

## License

MIT
