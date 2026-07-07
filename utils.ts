/**
 * Session Memory – Utilities
 *
 * Pure functions for session parsing, caching, searching, and memory compilation.
 */

import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionInfo {
	file: string;
	fileName: string;
	id: string;
	date: string;
	name: string | null;
	firstUserMessage: string | null;
	messageCount: number;
}

export interface CachedSession extends SessionInfo {
	summary: string | null;
	summaryModel: string | null;
	fileSize: number;
}

export interface MemoryCache {
	cwd: string;
	updatedAt: string;
	sessions: Record<string, CachedSession>;
	projectMemory: string | null;
	projectMemoryDate: string | null;
}

export interface SearchMatch {
	role: string;
	snippet: string;
	timestamp: string;
}

export interface SearchResult {
	sessionFile: string;
	sessionDate: string;
	sessionName: string | null;
	matchCount: number;
	matches: SearchMatch[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIG_BASE =
	process.env.PI_CODING_AGENT_DIR ||
	join(process.env.HOME || "", ".pi", "agent");

const MEMORY_DIR = join(CONFIG_BASE, "session-memory");

// ─── Text Extraction ─────────────────────────────────────────────────────────

/** Extract plain text from a message content field (string or content block array). */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c: any) => c?.type === "text" && typeof c.text === "string",
		)
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

// ─── Session Directory Resolution ────────────────────────────────────────────

/**
 * Resolve the session storage directory for a given cwd.
 * Tries the current session file first, falls back to constructing the path.
 */
export function resolveSessionDir(
	sessionFile: string | undefined,
	cwd: string,
): string | null {
	if (sessionFile) {
		const dir = dirname(sessionFile);
		if (existsSync(dir)) return dir;
	}
	// Fallback: construct from cwd using pi's naming convention
	const encoded = cwd.replace(/^\//, "").replace(/\//g, "-");
	const dir = join(CONFIG_BASE, "sessions", `--${encoded}--`);
	return existsSync(dir) ? dir : null;
}

/** List all .jsonl session files in a directory, newest first. */
export function listSessionFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.reverse()
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

// ─── Session Parsing ─────────────────────────────────────────────────────────

/** Scan a session file and extract metadata (name, first message, message count). */
export function scanSession(file: string): SessionInfo | null {
	try {
		const raw = readFileSync(file, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		if (!lines.length) return null;

		const header = JSON.parse(lines[0]);
		if (header.type !== "session") return null;

		let name: string | null = null;
		let firstMsg: string | null = null;
		let msgCount = 0;

		for (let i = 1; i < lines.length; i++) {
			try {
				const e = JSON.parse(lines[i]);
				if (e.type === "session_info" && e.name) name = e.name;
				if (e.type === "message" && e.message) {
					msgCount++;
					if (!firstMsg && e.message.role === "user") {
						firstMsg = extractText(e.message.content).slice(0, 300);
					}
				}
			} catch {
				/* skip malformed lines */
			}
		}

		return {
			file,
			fileName: basename(file),
			id: header.id,
			date: header.timestamp,
			name,
			firstUserMessage: firstMsg,
			messageCount: msgCount,
		};
	} catch {
		return null;
	}
}

/**
 * Build a readable conversation transcript from a session file.
 * Used as input for LLM-based summary generation.
 */
export function buildConversation(
	file: string,
	maxChars = 120_000,
): string {
	const raw = readFileSync(file, "utf-8");
	const lines = raw.split("\n").filter(Boolean);
	const parts: string[] = [];

	for (const line of lines) {
		try {
			const e = JSON.parse(line);
			if (e.type === "message" && e.message) {
				const { role, content } = e.message;
				const text = extractText(content);
				if (role === "user" && text) {
					parts.push(`User: ${text}`);
				} else if (role === "assistant" && text) {
					parts.push(`Assistant: ${text}`);
				}
				// Tool calls: extract names for context
				if (role === "assistant" && Array.isArray(content)) {
					const calls = content
						.filter((c: any) => c?.type === "toolCall")
						.map((c: any) => c.name)
						.filter(Boolean);
					if (calls.length) {
						parts.push(`[Tools used: ${calls.join(", ")}]`);
					}
				}
			} else if (e.type === "compaction" && e.summary) {
				parts.push(`[Earlier context summary]: ${e.summary}`);
			}
		} catch {
			/* skip */
		}
	}

	const full = parts.join("\n\n");
	if (full.length > maxChars) {
		return full.slice(0, maxChars) + "\n\n[... truncated ...]";
	}
	return full;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search through session files for a text query.
 * Returns matching messages with surrounding context snippets.
 */
export function searchSessions(
	files: string[],
	query: string,
	limit: number,
	excludeFile?: string,
): SearchResult[] {
	const results: SearchResult[] = [];
	const q = query.toLowerCase();

	for (const file of files) {
		if (excludeFile && file === excludeFile) continue;
		if (results.length >= limit) break;

		try {
			const raw = readFileSync(file, "utf-8");
			const lines = raw.split("\n").filter(Boolean);

			let sessionDate = "";
			let sessionName: string | null = null;
			const matches: SearchMatch[] = [];

			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e.type === "session") sessionDate = e.timestamp;
					if (e.type === "session_info" && e.name) sessionName = e.name;

					let text: string | null = null;
					let role = "";

					if (e.type === "message" && e.message) {
						text = extractText(e.message.content);
						role = e.message.role;
					} else if (e.type === "compaction" && e.summary) {
						text = e.summary;
						role = "compaction-summary";
					}

					if (text) {
						const textLower = text.toLowerCase();
						const idx = textLower.indexOf(q);
						if (idx !== -1) {
							const start = Math.max(0, idx - 150);
							const end = Math.min(
								text.length,
								idx + query.length + 150,
							);
							const snippet =
								(start > 0 ? "…" : "") +
								text.slice(start, end) +
								(end < text.length ? "…" : "");

							matches.push({
								role,
								snippet,
								timestamp: e.timestamp || "",
							});
						}
					}
				} catch {
					/* skip */
				}
			}

			if (matches.length > 0) {
				results.push({
					sessionFile: basename(file),
					sessionDate,
					sessionName,
					matchCount: matches.length,
					matches: matches.slice(0, 5), // cap per session
				});
			}
		} catch {
			/* skip unreadable files */
		}
	}

	return results;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

function cachePath(cwd: string): string {
	const hash = createHash("md5").update(cwd).digest("hex").slice(0, 16);
	return join(MEMORY_DIR, `${hash}.json`);
}

/** Load the memory cache for a cwd. Returns empty cache if none exists. */
export function loadCache(cwd: string): MemoryCache {
	const p = cachePath(cwd);
	if (existsSync(p)) {
		try {
			return JSON.parse(readFileSync(p, "utf-8"));
		} catch {
			/* corrupted – start fresh */
		}
	}
	return {
		cwd,
		updatedAt: "",
		sessions: {},
		projectMemory: null,
		projectMemoryDate: null,
	};
}

/** Persist the memory cache to disk. Also updates `cache.updatedAt` in place. */
export function saveCache(cache: MemoryCache): void {
	mkdirSync(MEMORY_DIR, { recursive: true });
	cache.updatedAt = new Date().toISOString();
	writeFileSync(cachePath(cache.cwd), JSON.stringify(cache, null, 2));
}

// ─── Project Memory Compilation ──────────────────────────────────────────────

/**
 * Build the project memory text from cached session summaries.
 * This is purely programmatic – no LLM call needed.
 */
export function buildProjectMemory(
	cache: MemoryCache,
	maxSessions = 15,
): string | null {
	const sessions = Object.values(cache.sessions)
		.filter((s) => s.summary)
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, maxSessions);

	if (sessions.length === 0) return null;

	const lines: string[] = [
		`## Project Session Memory (${sessions.length} sessions)`,
		"",
	];

	for (const s of sessions) {
		const d = new Date(s.date).toLocaleDateString("de-DE", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		const label = s.name || s.firstUserMessage?.slice(0, 60) || "unnamed";

		// Take first ~150 chars of summary for the overview
		const brief = (s.summary || "")
			.replace(/^#+\s*.+$/gm, "") // strip headings
			.replace(/\*\*/g, "") // strip bold
			.replace(/\n{2,}/g, " | ") // collapse paragraphs
			.replace(/\n/g, " ")
			.trim()
			.slice(0, 200);

		lines.push(`**${d} – ${label}** (${s.messageCount} msgs)`);
		lines.push(brief);
		lines.push("");
	}

	lines.push(
		"---",
		"Use `search_sessions` to find specific information across all past sessions.",
		"Use `get_session_summary` with a session file name for the full summary.",
	);

	return lines.join("\n");
}
