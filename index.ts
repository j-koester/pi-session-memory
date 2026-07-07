/**
 * Session Memory Extension
 *
 * Gives pi access to knowledge from previous sessions in the current working directory.
 *
 * Features:
 * - Auto-injects a compact project memory on the first prompt of each session
 * - Auto-summarizes outgoing sessions on shutdown
 * - Stale cache detection with user warnings
 * - `list_sessions` tool – browse past sessions with metadata
 * - `search_sessions` tool – full-text search across all past sessions
 * - `get_session_summary` tool – detailed LLM-generated summary (cached)
 * - `/memory-update` command – batch-generate summaries (Esc to cancel)
 * - `/memory-status` command – show cache statistics
 * - `/memory-clear` command – reset the cache
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";

import {
	buildConversation,
	buildProjectMemory,
	listSessionFiles,
	loadCache,
	resolveSessionDir,
	saveCache,
	scanSession,
	searchSessions,
	type CachedSession,
	type MemoryCache,
} from "./utils";

// ─── Summary generation prompt ───────────────────────────────────────────────

const SUMMARY_PROMPT = `Summarize this pi coding agent session concisely (max 200 words). Structure as:

- **Goal**: What the user wanted to achieve
- **Key actions**: Main files modified, commands run, decisions made
- **Outcome**: What was accomplished
- **Open items**: Unfinished work or next steps (if any)

<session>
{CONVERSATION}
</session>`;

// ─── Types & Constants ───────────────────────────────────────────────────────

/** Minimal model reference used throughout the extension. */
interface ModelRef {
	provider: string;
	id: string;
}

/** Context subset needed for LLM summary generation. */
interface SummaryContext {
	model: (ModelRef & Record<string, unknown>) | null | undefined;
	modelRegistry: {
		getApiKeyAndHeaders(model: ModelRef & Record<string, unknown>): Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
			error?: string;
		}>;
	};
}

/** Entry returned by the list_sessions tool. */
interface SessionListEntry {
	fileName: string;
	date: string;
	name: string | null;
	firstMessage: string | null;
	messageCount: number;
	hasSummary: boolean;
}

/** How many days before project memory is considered stale. */
const STALE_DAYS = 7;

/** Minimum messages for a session to be auto-summarized on shutdown. */
const AUTO_SUMMARY_MIN_MESSAGES = 4;

/** Maximum session file size (bytes) for auto-summary on shutdown. */
const AUTO_SUMMARY_MAX_SIZE = 512_000;

/** Timeout (ms) for auto-summary during shutdown to avoid blocking exit. */
const AUTO_SUMMARY_TIMEOUT = 15_000;

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── State ──
	let cache: MemoryCache | null = null;
	let sessionDir: string | null = null;
	let cwd = "";
	let memoryInjected = false;
	let currentSessionFile: string | undefined;

	// ── Helpers ──

	/** Minimal session manager shape for state initialization. */
	interface SessionManagerRef {
		getSessionFile?: () => string | undefined;
	}

	function ensureState(ctx: { sessionManager: SessionManagerRef; cwd: string }) {
		if (!sessionDir) {
			sessionDir = resolveSessionDir(
				ctx.sessionManager.getSessionFile?.() ?? undefined,
				ctx.cwd,
			);
		}
		if (!cache) cache = loadCache(ctx.cwd);
	}

	/** Format model provider/id as a label string. */
	function modelLabel(model: unknown): string | null {
		if (!model || typeof model !== "object") return null;
		const m = model as ModelRef;
		return m.provider && m.id ? `${m.provider}/${m.id}` : null;
	}

	function getSessionFiles(): string[] {
		return sessionDir ? listSessionFiles(sessionDir) : [];
	}

	function excludeCurrent(files: string[]): string[] {
		return files.filter(
			(f) => !currentSessionFile || f !== currentSessionFile,
		);
	}

	/**
	 * Resolve session directory, file list, and cache for a target path.
	 * When path differs from cwd, loads the external project's cache.
	 */
	function resolveContext(
		path?: string,
		ctx?: { sessionManager: SessionManagerRef; cwd: string },
	) {
		if (path && path !== cwd) {
			const dir = resolveSessionDir(undefined, path);
			return {
				dir,
				targetCache: loadCache(path),
				isExternal: true,
				files: dir ? listSessionFiles(dir) : [],
			};
		}
		if (ctx) ensureState(ctx);
		if (!cache) cache = loadCache(cwd);
		return {
			dir: sessionDir,
			targetCache: cache,
			isExternal: false,
			files: excludeCurrent(getSessionFiles()),
		};
	}

	/**
	 * Ensure a session is in a cache with current metadata.
	 * Returns the cached entry or null if the file can't be parsed.
	 */
	function ensureCached(
		file: string,
		targetCache?: MemoryCache,
	): CachedSession | null {
		const c = targetCache || cache;
		if (!c) return null;
		const fn = basename(file);

		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			return null; // file deleted or inaccessible
		}

		// Return cached if file hasn't changed
		if (c.sessions[fn] && c.sessions[fn].fileSize === size) {
			return c.sessions[fn];
		}

		// (Re)scan
		const info = scanSession(file);
		if (!info) return null;

		c.sessions[fn] = {
			...info,
			summary: c.sessions[fn]?.summary ?? null,
			summaryModel: c.sessions[fn]?.summaryModel ?? null,
			fileSize: size,
		};
		return c.sessions[fn];
	}

	async function generateSummary(
		file: string,
		ctx: SummaryContext,
		signal?: AbortSignal,
	): Promise<string | null> {
		const model = ctx.model;
		if (!model) return null;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return null;

		const conversation = buildConversation(file);
		if (!conversation.trim()) return null;

		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: SUMMARY_PROMPT.replace(
									"{CONVERSATION}",
									conversation,
								),
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				maxTokens: 1024,
				signal,
			},
		);

		// Don't cache aborted or empty responses
		if (response.stopReason === "aborted") return null;

		const text = response.content
			.filter(
				(c): c is { type: "text"; text: string } => c.type === "text",
			)
			.map((c) => c.text)
			.join("\n")
			.trim();

		return text || null;
	}

	// ── session_start: load cache ──

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		memoryInjected = false;
		currentSessionFile =
			ctx.sessionManager.getSessionFile() ?? undefined;
		sessionDir = resolveSessionDir(currentSessionFile, cwd);
		cache = loadCache(cwd);
	});

	// ── session_shutdown: auto-summarize outgoing session ──

	pi.on("session_shutdown", async (event, ctx) => {
		// Don't summarize on reload (session continues)
		if (event.reason === "reload") return;
		if (!currentSessionFile || !cache) return;

		const fn = basename(currentSessionFile);

		// Skip if already summarized
		if (cache.sessions[fn]?.summary) return;

		// Skip large sessions – use /memory-update instead
		let size: number;
		try {
			size = statSync(currentSessionFile).size;
		} catch {
			return;
		}
		if (size > AUTO_SUMMARY_MAX_SIZE) return;

		// Check if session has enough content to summarize
		const meta = scanSession(currentSessionFile);
		if (!meta || meta.messageCount < AUTO_SUMMARY_MIN_MESSAGES) return;

		// Use AbortController with timeout to avoid blocking shutdown
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			AUTO_SUMMARY_TIMEOUT,
		);

		try {
			const summary = await generateSummary(
				currentSessionFile,
				ctx as SummaryContext,
				controller.signal,
			);
			if (!summary) return;

			ensureCached(currentSessionFile);
			const entry = cache.sessions[fn];
			if (entry) {
				entry.summary = summary;
					entry.summaryModel = modelLabel(ctx.model);
				saveCache(cache);
			}
		} catch {
			// Don't block shutdown on errors
		} finally {
			clearTimeout(timeout);
		}
	});

	// ── before_agent_start: inject project memory on first prompt ──

	pi.on("before_agent_start", async (_event, ctx) => {
		if (memoryInjected) return;
		memoryInjected = true;
		ensureState(ctx);

		if (!sessionDir) return;

		const files = excludeCurrent(getSessionFiles());
		if (files.length === 0) return;

		// Use cached project memory if available
		if (cache?.projectMemory) {
			// ── Stale detection ──
			const memoryAge = cache.projectMemoryDate
				? (Date.now() -
						new Date(cache.projectMemoryDate).getTime()) /
					86_400_000
				: Infinity;
			const needsSummary = files.filter((f) => {
				const entry = cache!.sessions[basename(f)];
				return !entry || !entry.summary;
			}).length;
			const isStale = memoryAge > STALE_DAYS || needsSummary >= 3;

			let content = cache.projectMemory;
			if (isStale) {
				const reasons: string[] = [];
				if (memoryAge > STALE_DAYS)
					reasons.push(
						`last updated ${Math.floor(memoryAge)} days ago`,
					);
				if (needsSummary >= 3)
					reasons.push(
						`${needsSummary} sessions without summaries`,
					);
				content += `\n\n⚠️ Project memory may be outdated (${reasons.join(", ")}). Run \`/memory-update\` to refresh.`;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(
					isStale
						? `📚 Session memory loaded (${Object.keys(cache.sessions).length} sessions) ⚠️ Stale – run /memory-update`
						: `📚 Session memory loaded (${Object.keys(cache.sessions).length} sessions)`,
					isStale ? "warning" : "info",
				);
			}
			return {
				message: {
					customType: "session-memory",
					content,
					display: false,
				},
			};
		}

		// No project memory yet – build a lightweight session list from metadata
		const entries: Array<{
			date: string;
			label: string;
			msgs: number;
		}> = [];
		for (const f of files.slice(0, 15)) {
			const cached = ensureCached(f);
			if (cached && cached.messageCount > 0) {
				entries.push({
					date: cached.date.slice(0, 10),
					label:
						cached.name ||
						cached.firstUserMessage?.slice(0, 80) ||
						"(empty)",
					msgs: cached.messageCount,
				});
			}
		}
		if (cache) saveCache(cache);

		if (entries.length === 0) return;

		const lines = [
			`## Session History (${files.length} sessions in ${cwd})`,
			"",
			...entries.map(
				(e) => `- **${e.date}**: ${e.label} (${e.msgs} msgs)`,
			),
			"",
			"Use `search_sessions` to find information from past sessions.",
			"Use `get_session_summary` for a detailed session summary.",
			"Run `/memory-update` to generate comprehensive project memory.",
		];

		if (ctx.hasUI) {
			ctx.ui.notify(
				`📚 ${files.length} previous sessions available`,
				"info",
			);
		}

		return {
			message: {
				customType: "session-memory",
				content: lines.join("\n"),
				display: false,
			},
		};
	});

	// ── Tool: list_sessions ──

	pi.registerTool({
		name: "list_sessions",
		label: "List Sessions",
		description:
			"List previous pi sessions from the current working directory with date, name, and first message preview. Supports cross-project access via the path parameter.",
		promptSnippet:
			"List past pi sessions for the current project directory",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({
					description: "Max sessions to return (default: 20)",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Directory path to list sessions from. Defaults to current cwd. Use for cross-project access, e.g. /home/jens/projects/my-lib",
				}),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const rc = resolveContext(params.path, ctx);
			if (!rc.dir || rc.files.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No sessions found for ${params.path || cwd}.`,
						},
					],
				};
			}

			const limit = params.limit ?? 20;
			const results: SessionListEntry[] = [];

			for (const f of rc.files.slice(0, limit)) {
				const entry = ensureCached(f, rc.targetCache);
				if (entry && entry.messageCount > 0) {
					results.push({
						fileName: entry.fileName,
						date: entry.date,
						name: entry.name,
						firstMessage:
							entry.firstUserMessage?.slice(0, 120) ?? null,
						messageCount: entry.messageCount,
						hasSummary: !!entry.summary,
					});
				}
			}

			saveCache(rc.targetCache);

			return {
				content: [
					{
						type: "text",
						text: `Found ${rc.files.length} sessions${params.path ? ` in ${params.path}` : ""}. Showing ${results.length}:\n\n${JSON.stringify(results, null, 2)}`,
					},
				],
				details: { total: rc.files.length, shown: results.length },
			};
		},
	});

	// ── Tool: search_sessions ──

	pi.registerTool({
		name: "search_sessions",
		label: "Search Sessions",
		description:
			"Full-text search across all past pi sessions. Returns matching message snippets with context. Supports cross-project access via the path parameter.",
		promptSnippet:
			"Search past pi sessions by keyword to find previous work, decisions, or context",
		promptGuidelines: [
			"Use search_sessions when you need context from previous pi sessions, e.g. past decisions, code approaches, or discussed topics.",
			"Use search_sessions with the path parameter to search sessions from other project directories, e.g. for referenced libraries or related projects.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query (case-insensitive substring match)",
			}),
			limit: Type.Optional(
				Type.Number({
					description:
						"Max sessions with matches to return (default: 10)",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Directory path to search in. Defaults to current cwd. Use for cross-project access, e.g. /home/jens/projects/my-lib",
				}),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const rc = resolveContext(params.path, ctx);
			if (!rc.dir || rc.files.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No sessions found for ${params.path || cwd}.`,
						},
					],
				};
			}

			const results = searchSessions(
				rc.files,
				params.query,
				params.limit ?? 10,
				rc.isExternal ? undefined : currentSessionFile,
			);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matches for "${params.query}" in ${rc.files.length} sessions${params.path ? ` (${params.path})` : ""}.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Found matches in ${results.length} of ${rc.files.length} sessions${params.path ? ` (${params.path})` : ""}:\n\n${JSON.stringify(results, null, 2)}`,
					},
				],
				details: {
					sessionsSearched: rc.files.length,
					sessionsMatched: results.length,
				},
			};
		},
	});

	// ── Tool: get_session_summary ──

	pi.registerTool({
		name: "get_session_summary",
		label: "Get Session Summary",
		description:
			"Get a detailed summary of a specific past pi session. Generates the summary using the current model if not already cached. Supports cross-project access via the path parameter.",
		promptSnippet:
			"Get or generate a detailed summary of a past pi session by file name",
		parameters: Type.Object({
			sessionFile: Type.String({
				description:
					"Session file name (from list_sessions or search_sessions results)",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Directory path the session belongs to. Defaults to current cwd. Use for cross-project access.",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const rc = resolveContext(params.path, ctx);
			if (!rc.dir) {
				return {
					content: [
						{
							type: "text",
							text: `No session directory found for ${params.path || cwd}.`,
						},
					],
					isError: true,
				};
			}

			const file = join(rc.dir, params.sessionFile);
			if (!existsSync(file)) {
				return {
					content: [
						{
							type: "text",
							text: `Session file not found: ${params.sessionFile}`,
						},
					],
					isError: true,
				};
			}

			// Return cached summary if available and file unchanged
			const cached = ensureCached(file, rc.targetCache);
			if (cached?.summary) {
				return {
					content: [{ type: "text", text: cached.summary }],
					details: { cached: true, model: cached.summaryModel },
				};
			}

			// Generate summary
			onUpdate?.({
				content: [{ type: "text", text: "Generating summary…" }],
			});

			const summary = await generateSummary(
				file,
				ctx as SummaryContext,
				signal,
			);
			if (!summary) {
				return {
					content: [
						{
							type: "text",
							text: "Could not generate summary. Check that a model is active and authenticated.",
						},
					],
					isError: true,
				};
			}

			// Cache it
			if (cached) {
				cached.summary = summary;
				cached.summaryModel = modelLabel(ctx.model);
				saveCache(rc.targetCache);
			}

			return {
				content: [{ type: "text", text: summary }],
				details: {
					cached: false,
					model: modelLabel(ctx.model),
				},
			};
		},
	});

	// ── Command: /memory-update ──

	pi.registerCommand("memory-update", {
		description:
			"Generate summaries for past sessions and build project memory. Usage: /memory-update [limit]",
		handler: async (args, ctx) => {
			ensureState(ctx);

			if (!sessionDir) {
				if (ctx.hasUI)
					ctx.ui.notify("No session directory found.", "error");
				return;
			}
			if (!ctx.model) {
				if (ctx.hasUI)
					ctx.ui.notify(
						"No model active. Select a model first.",
						"error",
					);
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
				ctx.model,
			);
			if (!auth.ok || !auth.apiKey) {
				if (ctx.hasUI)
					ctx.ui.notify(
						`Auth failed: ${auth.ok ? "no API key" : auth.error}`,
						"error",
					);
				return;
			}

			const files = excludeCurrent(getSessionFiles());
			const argRaw = args.trim();
			const argLimit = argRaw ? parseInt(argRaw, 10) : undefined;

			if (argLimit !== undefined && isNaN(argLimit)) {
				if (ctx.hasUI)
					ctx.ui.notify(
						`Invalid limit: "${argRaw}". Usage: /memory-update [number]`,
						"error",
					);
				return;
			}

			// Find sessions needing summaries
			const toProcess: string[] = [];
			for (const f of files) {
				const entry = ensureCached(f);
				if (entry && !entry.summary && entry.messageCount > 0) {
					toProcess.push(f);
				}
			}

			if (argLimit && argLimit > 0) {
				toProcess.splice(argLimit); // keep only first N (newest)
			}

			if (toProcess.length === 0) {
				if (ctx.hasUI)
					ctx.ui.notify(
						"All sessions already have summaries. Rebuilding project memory…",
						"info",
					);
			} else {
				// Confirm
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Generate Summaries",
						`${toProcess.length} sessions need summaries. This makes ${toProcess.length} LLM calls using ${ctx.model.id}. Continue?`,
					);
					if (!ok) return;
				}

				// Batch processor – shared between TUI and non-TUI paths
				const processBatch = async (
					signal?: AbortSignal,
				): Promise<number> => {
					let completed = 0;
					for (const f of toProcess) {
						if (signal?.aborted) break;
						const fn = basename(f);
						try {
							const summary = await generateSummary(
								f,
								ctx as SummaryContext,
								signal,
							);
							if (summary && cache) {
								const entry = cache.sessions[fn];
								if (entry) {
									entry.summary = summary;
									entry.summaryModel = modelLabel(ctx.model);
								}
								completed++;
								saveCache(cache);
							}
						} catch {
							/* skip failed sessions */
						}
					}
					return completed;
				};

				let generated: number;

				if (ctx.mode === "tui") {
					// TUI: run inside loader with Esc-to-cancel support
					const result = await ctx.ui.custom<number | null>(
						(tui, theme, _kb, done) => {
							const loader = new BorderedLoader(
								tui,
								theme,
								`📚 Generating ${toProcess.length} summaries… (Esc to cancel)`,
							);
							loader.onAbort = () => done(null);
							processBatch(loader.signal)
								.then(done)
								.catch(() => done(null));
							return loader;
						},
					);
					generated = result ?? 0;
				} else {
					// Non-TUI: run without abort capability
					generated = await processBatch();
				}

				if (ctx.hasUI) {
					ctx.ui.notify(
						`Generated ${generated}/${toProcess.length} summaries.`,
						"info",
					);
				}
			}

			// Build project memory
			if (cache) {
				cache.projectMemory = buildProjectMemory(cache);
				cache.projectMemoryDate = new Date().toISOString();
				saveCache(cache);
			}

			if (ctx.hasUI) {
				ctx.ui.setStatus("session-memory", "");
				ctx.ui.notify("✅ Project memory updated.", "info");
			}
		},
	});

	// ── Command: /memory-status ──

	pi.registerCommand("memory-status", {
		description: "Show session memory cache statistics",
		handler: async (_args, ctx) => {
			ensureState(ctx);
			const files = excludeCurrent(getSessionFiles());
			const withSummary = cache
				? Object.values(cache.sessions).filter((s) => s.summary)
						.length
				: 0;

			const lines = [
				`📚 Session Memory Status`,
				`   Directory: ${cwd}`,
				`   Sessions found: ${files.length}`,
				`   Cached entries: ${cache ? Object.keys(cache.sessions).length : 0}`,
				`   With summaries: ${withSummary}`,
				`   Project memory: ${cache?.projectMemory ? "✅ built" : "❌ not built"}`,
				cache?.projectMemoryDate
					? `   Last updated: ${cache.projectMemoryDate.slice(0, 10)}`
					: "",
			].filter(Boolean);

			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});

	// ── Command: /memory-clear ──

	pi.registerCommand("memory-clear", {
		description:
			"Clear the session memory cache for the current directory",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const ok = await ctx.ui.confirm(
				"Clear Memory",
				"Delete all cached summaries and project memory for this directory?",
			);
			if (!ok) return;

			cache = {
				cwd: ctx.cwd,
				updatedAt: "",
				sessions: {},
				projectMemory: null,
				projectMemoryDate: null,
			};
			saveCache(cache);
			ctx.ui.notify("Session memory cache cleared.", "info");
		},
	});
}
