import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * Turn a bare `/fork` into "fork this session into a new Ghostty tab".
 *
 * omp's built-in `/fork pane|window|tab` only knows tmux, Zellij, Herdr, CMUX,
 * and Orca. On macOS, Ghostty exposes `new tab` through AppleScript, so this
 * extension opens the child `omp --fork <session>` there and leaves the parent
 * session untouched.
 *
 * Outside Ghostty (or inside a multiplexer) the handler declines and the
 * built-in `/fork` behavior is used unchanged.
 */

const OSASCRIPT_TIMEOUT_MS = 15_000;

const SCOPE_ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"PI_CONFIG_FILES",
	"PI_CODING_AGENT_SESSION_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;

/** POSIX single-quote quoting; safe for any byte except NUL. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Escape a value for an AppleScript double-quoted string literal. */
export function appleScriptString(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r");
}

export interface GhosttyTabRequest {
	/** argv of the process to run in the new tab. */
	command: readonly string[];
	cwd: string;
	/** Environment variables pinned for the child; undefined entries are skipped. */
	env: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the AppleScript that opens a Ghostty tab and runs `request.command`.
 * The command is executed through `/bin/sh -c` so argv quoting is exact
 * regardless of how Ghostty tokenizes the `command` surface property.
 */
export function buildAppleScript(request: GhosttyTabRequest): string {
	const commandLine = request.command.map(shellQuote).join(" ");
	const shellCommand = `/bin/sh -c ${shellQuote(commandLine)}`;
	const variables = Object.entries(request.env)
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.map(([key, value]) => `"${appleScriptString(`${key}=${value}`)}"`);

	const lines = [
		'tell application "Ghostty"',
		"  activate",
		"  set cfg to new surface configuration",
		`  set initial working directory of cfg to "${appleScriptString(request.cwd)}"`,
		`  set command of cfg to "${appleScriptString(shellCommand)}"`,
	];
	if (variables.length > 0) {
		lines.push(`  set environment variables of cfg to {${variables.join(", ")}}`);
	}
	lines.push(
		"  set t to new tab in front window with configuration cfg",
		"  select tab t",
		"  return id of t",
		"end tell",
	);
	return lines.join("\n");
}

/** Markers omp uses for the multiplexers its built-in `/fork` placement understands. */
function insideMultiplexer(env: NodeJS.ProcessEnv): boolean {
	return Boolean(
		env.TMUX ||
			env.ZELLIJ ||
			env.STY ||
			env.WMUX === "1" ||
			env.WMUX_SURFACE_ID ||
			env.HERDR_ENV === "1" ||
			env.HERDR_PANE_ID ||
			env.HERDR_TAB_ID ||
			env.HERDR_WORKSPACE_ID ||
			env.CMUX_WORKSPACE_ID ||
			env.CMUX_SURFACE_ID ||
			env.CMUX_REMOTE_TRANSPORT ||
			(env.ORCA_PANE_KEY && env.ORCA_WORKTREE_ID),
	);
}

/** Whether this process runs directly in a Ghostty surface on macOS. */
export function isGhosttyHost(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin" && env.TERM_PROGRAM?.toLowerCase() === "ghostty" && !insideMultiplexer(env);
}

function scopeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
	const scope: Record<string, string | undefined> = {};
	for (const key of SCOPE_ENV_KEYS) scope[key] = env[key];
	return scope;
}

/** Open a fork of the current session in a new Ghostty tab. Returns the tab id when Ghostty reports one. */
export async function openGhosttyForkTab(
	pi: Pick<ExtensionAPI, "exec" | "logger">,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">,
): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("this session is not persisted, so it cannot be forked into another tab");
	}

	const source = resolve(sessionFile);
	await access(source);

	const profile = process.env.OMP_PROFILE || process.env.PI_PROFILE || undefined;
	const argv = [process.execPath];
	if (profile) argv.push("--profile", profile);
	argv.push("--fork", source);

	const script = buildAppleScript({ command: argv, cwd: ctx.cwd, env: scopeEnv(process.env) });
	const result = await pi.exec("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `osascript exited with code ${result.code}`;
		throw new Error(detail);
	}
	return result.stdout.trim() || undefined;
}

export default function ghosttyForkTab(pi: ExtensionAPI): void {
	pi.setLabel("Ghostty /fork tab");

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || ctx.mode !== "tui") return;
		if (event.text.trim() !== "/fork") return;
		if (!isGhosttyHost()) return;

		const modes = ctx.sessionModes?.getState();
		if (modes?.vibe === "active") {
			ctx.ui.notify("Leave vibe mode before forking.", "warning");
			return { handled: true };
		}

		if (!ctx.isIdle()) {
			const confirmed = await ctx.ui.confirm(
				"Fork while a response is running?",
				"The new tab may miss the partial response. The current session keeps running here.",
			);
			if (!confirmed) return { handled: true };
		}

		try {
			const tabId = await openGhosttyForkTab(pi, ctx);
			ctx.ui.notify(`Forked into a new Ghostty tab${tabId ? ` (${tabId})` : ""}.`, "info");
		} catch (error) {
			pi.logger.error("ghostty-fork-tab: failed to open fork tab", { error });
			ctx.ui.notify(`Could not open a fork tab: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		return { handled: true };
	});
}
