import { CommandError, run } from "./proc";

const BIN = process.env.HERDR_BIN_PATH ?? "herdr";

/** A JSON value as `JSON.parse` produces it — the boundary type before herdr's fields are narrowed. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Parses herdr stdout; malformed JSON becomes a `CommandError` naming the command. */
function parseOutput(out: string, args: string[]): JsonValue {
	try {
		return JSON.parse(out) as JsonValue;
	} catch (err) {
		throw new CommandError(`herdr ${args.join(" ")}: unparseable JSON (${err instanceof Error ? err.message : String(err)})`);
	}
}

/** herdr's `{error:{message}}` payload, or undefined when the JSON is not that shape. */
function errorMessageOf(raw: string): string | undefined {
	try {
		const message = at(JSON.parse(raw), "error", "message");
		return typeof message === "string" ? message : undefined;
	} catch {
		return undefined; // not herdr's error envelope — the original CommandError stands
	}
}

/** Reads `path` from parsed JSON; throws when a segment is missing. */
function at(value: unknown, ...path: string[]): JsonValue {
	let cur = value;
	for (const key of path) {
		if (!cur || typeof cur !== "object" || !(key in cur)) throw new CommandError(`herdr: response missing ${path.join(".")}`);
		cur = (cur as Record<string, JsonValue>)[key];
	}
	return cur as JsonValue;
}

function str(value: unknown, path: string): string {
	if (typeof value !== "string") throw new CommandError(`herdr: ${path} is not a string`);
	return value;
}

const optStr = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Runs a herdr CLI command and returns its `.result`; surfaces herdr's `{error:{message}}` on failure. */
async function herdr(args: string[]): Promise<unknown> {
	let out: string;
	try {
		out = await run([BIN, ...args]);
	} catch (err) {
		if (err instanceof CommandError && err.message.startsWith("{")) {
			const message = errorMessageOf(err.message);
			if (message) throw new CommandError(message);
		}
		throw err;
	}
	return at(parseOutput(out, args), "result");
}

export type AgentInfo = {
	/** Name when started by name, else the pane id; both are valid agent targets. */
	target: string;
	name: string | undefined;
	kind: string;
	status: string;
	paneId: string;
	cwd: string;
	title: string;
};

export async function listAgents(): Promise<AgentInfo[]> {
	const agents = at(await herdr(["agent", "list"]), "agents");
	if (!Array.isArray(agents)) throw new CommandError("herdr: agents is not a list");
	return (agents as Record<string, unknown>[]).map(a => {
		const paneId = str(a.pane_id, "pane_id");
		const name = optStr(a.name);
		return {
			target: name ?? paneId,
			name,
			kind: optStr(a.agent) ?? "agent",
			status: optStr(a.agent_status) ?? "unknown",
			paneId,
			cwd: optStr(a.cwd) ?? "",
			title: optStr(a.terminal_title_stripped) ?? "",
		};
	});
}

/** Splits `pane` to the right with a fresh shell in `cwd`; returns the new pane id. */
export async function splitPane(pane: string, cwd: string): Promise<string> {
	const result = await herdr(["pane", "split", pane, "--direction", "right", "--cwd", cwd, "--no-focus"]);
	return str(at(result, "pane", "pane_id"), "pane.pane_id");
}

/** Creates (or checks out) `branch` as a linked worktree workspace; returns its root pane id. */
export async function createWorktree(cwd: string, branch: string, label: string): Promise<string> {
	const result = await herdr(["worktree", "create", "--cwd", cwd, "--branch", branch, "--label", label, "--no-focus"]);
	return str(at(result, "root_pane", "pane_id"), "root_pane.pane_id");
}

/** Starts an agent in an idle shell pane; resolves once it accepts input. */
export async function startAgent(name: string, kind: string, pane: string): Promise<void> {
	await herdr(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "90000"]);
}

export async function promptAgent(target: string, text: string): Promise<void> {
	// herdr's CLI has no "--" end-of-options marker, so a leading "-" is parsed as a flag.
	if (text.startsWith("-"))
		throw new CommandError(`prompt text must not start with '-' — herdr's CLI parses it as a flag; rephrase the prompt`);
	await herdr(["agent", "prompt", target, text]);
}

export async function focusAgent(target: string): Promise<void> {
	await herdr(["agent", "focus", target]);
}

/** Lets right-clicks reach the board instead of herdr's own pane menu. */
export async function routeRightClickToPane(pane: string): Promise<void> {
	await herdr(["pane", "input", pane, "--right-click", "pane"]);
}

export async function openBoardPane(env: Record<string, string>): Promise<void> {
	const pluginId = process.env.HERDR_PLUGIN_ID ?? "jauki.issue-board";
	const args = ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "board", "--focus"];
	for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
	await herdr(args);
}
