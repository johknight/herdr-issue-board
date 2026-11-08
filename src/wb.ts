// Read-only adapter for the wb sandbox manager: pool worktrees, sessions and the repo's
// `.wb.json`. Every entry point degrades silently — wb missing, non-git repo or malformed
// data yield empty results, so the board renders exactly as it would without wb.
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { listWorktrees, type Worktree } from "./prototype";
import { run } from "./proc";

// ── task ids (derived, never configured) ─────────────────────────────────────

/** Single-ticket task id: the `issue-<n>` convention of a one-ticket wb run. */
export function taskIdForIssue(issueNumber: number): string {
	return `issue-${issueNumber}`;
}

/**
 * Selection label for skill task ids: contiguous runs collapse to `lo-hi`, runs join with `-`
 * (`183-192`, `183-185-190`) — the same selection always recomputes the same label.
 */
export function selectionLabel(numbers: number[]): string {
	const sorted = [...numbers].sort((a, b) => a - b);
	if (!sorted.length) return "none";
	const runs: string[] = [];
	let lo = sorted[0];
	let hi = lo;
	const closeRun = () => {
		runs[runs.length] = lo === hi ? String(lo) : `${lo}-${hi}`;
	};
	for (const n of sorted.slice(1)) {
		if (n === hi + 1) hi = n;
		else {
			closeRun();
			lo = hi = n;
		}
	}
	closeRun();
	return runs.join("-");
}

/** Skill task id for a selection + skill (`issues-183-192-prototype`, `issues-183-185-190-refine`). */
export function taskIdForSkill(numbers: number[], skillSlug: string): string {
	return `issues-${selectionLabel(numbers)}-${skillSlug}`;
}

// ── pool resolution (branch names, not `wb ps` text) ──────────────────────────

/**
 * Task id behind a pool branch: `wb/<task>` (serial) or `agent/tree-<task>` (tree mode, the
 * `tree-` prefix stripped). Any other branch houses no wb task.
 */
export function taskFromBranch(branch: string): string | undefined {
	if (/^wb\//.test(branch)) return branch.slice("wb/".length) || undefined;
	if (/^agent\/tree-/.test(branch)) return branch.slice("agent/tree-".length) || undefined;
	return undefined;
}

/**
 * Issue numbers a task id names: the leading numeric segments of `issue-…`/`issues-…` ids.
 * An id without any (`hello-world`, `serial`) matches no card — it is listed in `/wb` only.
 */
export function issueNumbersForTask(task: string): number[] {
	const kind = /^(issue|issues)-(.*)$/.exec(task);
	if (!kind) return [];
	const numbers: number[] = [];
	for (const segment of kind[2].split("-")) {
		if (!/^\d+$/.test(segment)) break;
		numbers[numbers.length] = Number(segment);
	}
	return numbers;
}

// ── sessions ────────────────────────────────────────────────────────────────

/** Parses `wb sessions --json`; anything that is not a JSON array of objects yields []. */
export function parseSessions(text: string): Record<string, unknown>[] {
	try {
		const json: unknown = JSON.parse(text);
		if (!Array.isArray(json)) return [];
		return json.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
	} catch {
		return [];
	}
}

/** Session records from `wb sessions --json`, read tolerantly; [] on any failure. */
export async function wbSessions(): Promise<Record<string, unknown>[]> {
	try {
		return parseSessions(await run(["wb", "sessions", "--json"]));
	} catch {
		return [];
	}
}

/**
 * Sessions pointing at a task's pool worktree: the `tree` field is `tree-<task>` in tree mode
 * or `serial` in serial mode, matched on `repo` when the record carries one.
 */
export function sessionsForTask(
	sessions: Record<string, unknown>[],
	task: { task: string; mode: "tree" | "serial" },
	repoName: string,
): number {
	const tree = task.mode === "tree" ? `tree-${task.task}` : "serial";
	return sessions.filter(s => s.tree === tree && (s.repo === undefined || s.repo === repoName)).length;
}

// ── repo + pool state ───────────────────────────────────────────────────────

/** True when a `wb` executable sits on PATH (plain probe — nothing is executed). */
export function wbAvailable(): boolean {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		try {
			accessSync(join(dir, "wb"), constants.X_OK);
			return true;
		} catch {}
	}
	return false;
}

/** Keys of the repo's `.wb.json` the board reads; missing or malformed → both unset. */
export type WbRepoConfig = { mode?: string; engine?: string };

/** Reads the repo's `.wb.json` (mode/engine keys) tolerantly; absent or malformed → {}. */
export async function wbRepoConfig(repoCwd: string): Promise<WbRepoConfig> {
	try {
		const json: unknown = await Bun.file(join(repoCwd, ".wb.json")).json();
		if (!json || typeof json !== "object" || Array.isArray(json)) return {};
		const o = json as Record<string, unknown>;
		return {
			mode: typeof o.mode === "string" ? o.mode : undefined,
			engine: typeof o.engine === "string" ? o.engine : undefined,
		};
	} catch {
		return {};
	}
}

/** One wb pool task, as the board sees it (all read host-side). */
export type PoolTask = {
	/** wb task id, derived from the pool branch name. */
	task: string;
	/** Pool branch: `wb/<task>` (serial) or `agent/tree-<task>` (tree mode). */
	branch: string;
	/** Pool worktree path on the host. */
	path: string;
	/** `tree` for `agent/tree-*` branches, `serial` for `wb/*`. */
	mode: "tree" | "serial";
	/** Issue numbers the task id names; empty ⇒ listed in `/wb` but never badged onto a card. */
	issues: number[];
	/** The pool worktree has tracked changes (`git status --porcelain`, untracked files ignored). */
	dirty: boolean;
};

/** True when the worktree has tracked changes (host-side `git status --porcelain`). */
async function hasTrackedChanges(path: string): Promise<boolean> {
	let out: string;
	try {
		out = await run(["git", "status", "--porcelain"], path);
	} catch {
		return false;
	}
	return out.split("\n").some(line => line.trim() !== "" && line.indexOf("??") !== 0);
}

/**
 * Pool tasks of the repo at `repoCwd`, resolved from `git worktree list --porcelain` branch
 * names; [] when the repo has no wb pool, is not a git repo, or git missing. Never throws.
 */
export async function loadPool(repoCwd: string): Promise<PoolTask[]> {
	let trees: Worktree[];
	try {
		trees = await listWorktrees(repoCwd);
	} catch {
		return [];
	}
	const pool = trees.flatMap(wt => {
		const task = taskFromBranch(wt.branch);
		if (task === undefined) return [];
		const treeMode = /^agent\/tree-/.test(wt.branch);
		return [{ wt, task, mode: treeMode ? ("tree" as const) : ("serial" as const) }];
	});
	return Promise.all(
		pool.map(async ({ wt, task, mode }) => ({
			task,
			branch: wt.branch,
			path: wt.path,
			mode,
			issues: issueNumbersForTask(task),
			dirty: await hasTrackedChanges(wt.path),
		})),
	);
}
