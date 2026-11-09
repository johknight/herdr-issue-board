// Adapter for the wb sandbox manager: pool worktrees, sessions, the repo's `.wb.json` (batch 1)
// and the launch-engine wiring of batch 2 — `wb start`/`wb publish`/`wb diff`/`wb finish` calls and
// the launcher decisions. Reads degrade silently; action wrap `run()` and surface wb's own guards.
import { accessSync, constants, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listWorktrees, type Worktree } from "./prototype";
import { CommandError, run } from "./proc";

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

// ── launch engine (batch 2b: BR-10..BR-14) ──────────────────────────────────

/**
 * Launcher decision (BR-10): `herdr` (the default) never routes through wb; `wb` routes only when
 * the wb surfaces are enabled and a `wb` sits on PATH — otherwise the actions fall back to herdr
 * with a one-line notice, never a hard failure mid-selection.
 */
export function resolveLauncher(
	launcher: "herdr" | "wb" | string,
	enabled: boolean,
	onPath: boolean,
): { wb: boolean; notice: string | null } {
	if (launcher !== "wb") return { wb: false, notice: null };
	if (!enabled) return { wb: false, notice: "wb disabled in config — using the herdr launcher" };
	if (!onPath) return { wb: false, notice: "wb not on PATH — using the herdr launcher" };
	return { wb: true, notice: null };
}

/** Local pool branch of a task: `agent/tree-<task>` (tree mode) or `wb/<task>` (serial). */
export function localBranchFor(task: string, mode: "tree" | "serial"): string {
	return mode === "tree" ? `agent/tree-${task}` : `wb/${task}`;
}

/**
 * Remote branch `wb publish` pushes a task to: `wb/tree-<task>` (tree mode) or `wb/<task>`
 * (serial) — probed against `wb publish <task> --yes`, which renames `agent/tree-*` on push.
 */
export function remoteBranchFor(task: string, mode: "tree" | "serial"): string {
	return mode === "tree" ? `wb/tree-${task}` : `wb/${task}`;
}

/** The wb task a card maps to: an exact `issue-<n>` pool task wins over a range/name task (BR-2). */
export function taskForIssue(tasks: PoolTask[], issueNumber: number): PoolTask | undefined {
	const exact = tasks.find(t => t.task === taskIdForIssue(issueNumber));
	if (exact) return exact;
	return tasks.find(t => t.issues.includes(issueNumber));
}

/** A `y`/`Y`/`yes` answer consents; the empty default and everything else declines (`[y/N]`). */
export function consentAnswer(text: string): boolean {
	return /^y(es)?$/i.test(text.trim());
}

/** `wb finish --json` result (BR-9): `sha` is the merge/squash commit, null on kill. */
export type FinishResult = {
	task: string;
	action: string;
	branch: string;
	parent: string;
	sha: string | null;
	worktree: string;
};

/** The local lifeclose actions the board may run behind an explicit confirm (BR-14). */
export type WbFinishAction = "merge" | "squash" | "kill";

/**
 * The result object out of `wb finish --json` stdout: human text first, the JSON object as the
 * last line. Anything unparseable yields undefined (the board still reports success).
 */
export function parseFinishJson(stdout: string): FinishResult | undefined {
	for (const line of stdout.split("\n").reverse()) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			const json: unknown = JSON.parse(text);
			if (!json || typeof json !== "object" || Array.isArray(json)) continue;
			const o = json as Record<string, unknown>;
			if (typeof o.task !== "string" || typeof o.action !== "string" || typeof o.branch !== "string" || typeof o.parent !== "string" || typeof o.worktree !== "string")
				continue;
			return { task: o.task, action: o.action, branch: o.branch, parent: o.parent, sha: typeof o.sha === "string" ? o.sha : null, worktree: o.worktree };
		} catch {}
	}
	return undefined;
}

// Argv builders — pure, so tests pin the exact contracts (flag order, consent flags, and that
// no push/delete flag ever reaches `wb finish`).

/** `wb start <task>` argv (BR-11): task id, repo, agent, setup skipped, prompt from a temp file. */
export function wbStartArgv(task: string, repoRoot: string, agent: string, promptFile: string): string[] {
	return ["wb", "start", task, "--repo", repoRoot, agent, "--setup=skip", "--prompt-file", promptFile];
}

/** `wb publish <task>` argv (BR-12): `--yes` is the board's explicit push consent. */
export function wbPublishArgv(task: string, repoRoot: string): string[] {
	return ["wb", "publish", task, "--repo", repoRoot, "--yes"];
}

/** `wb diff <task>` argv (BR-14): read-only task diff for the Review overlay. */
export function wbDiffArgv(task: string, repoRoot: string): string[] {
	return ["wb", "diff", task, "--repo", repoRoot];
}

/**
 * `wb finish <task> <action>` argv (BR-14): the consented local lifeclose. `--yes` never reaches
 * wb's remote ask (TTY-gated off by wb's construction); the board passes nothing push-shaped.
 */
export function wbFinishArgv(task: string, repoRoot: string, action: WbFinishAction): string[] {
	return ["wb", "finish", task, action, "--yes", "--json", "--repo", repoRoot];
}

/**
 * Starts a sandboxed wb task with the prompt as the agent's first message. The prompt text goes
 * to a temp file and only that path enters argv (BR-11); wb opens the workspace pane itself.
 */
export async function wbStart(task: string, repoRoot: string, agent: string, promptText: string): Promise<string> {
	const promptFile = join(tmpdir(), `issue-board-prompt-${randomUUID()}.txt`);
	await Bun.write(promptFile, promptText);
	try {
		return await run(wbStartArgv(task, repoRoot, agent, promptFile), repoRoot);
	} finally {
		try {
			unlinkSync(promptFile);
		} catch {}
	}
}

/** Pushes the task branch to origin — the ONLY push path on the wb launcher, behind an explicit yes (BR-12). */
export async function wbPublish(task: string, repoRoot: string): Promise<string> {
	return run(wbPublishArgv(task, repoRoot), repoRoot);
}

/**
 * The task's diff against its parent, for the read-only Review overlay (BR-14). `wb diff` derives
 * the repo from the process directory (its `--repo` is silently ignored by the dispatch), so the
 * spawn runs in `repoRoot`.
 */
export async function wbDiff(task: string, repoRoot: string): Promise<string> {
	return run(wbDiffArgv(task, repoRoot), repoRoot);
}

// ── wb up: open a task's tree in the workbench herdr session ────────────────

/** `wb up` target of a pool task: the tree task id; serial pools open the shared `serial` worktree. */
export function wbUpTarget(t: { task: string; mode: "tree" | "serial" }): string {
	return t.mode === "serial" ? "serial" : t.task;
}

/** `wb up <target>` argv: materializes the target's pool tree in the workbench herdr session. */
export function wbUpArgv(target: string): string[] {
	return ["wb", "up", target];
}

/**
 * Opens a task's tree in the workbench herdr session (`wb up`, non-interactive, from the repo
 * cwd). stdout lists what opened; the first stderr line rides along as wb's own notice, and a
 * nonzero exit throws it via run()'s CommandError contract.
 */
export async function wbUp(target: string, repoRoot: string): Promise<{ out: string; err: string | null }> {
	const proc = Bun.spawn(wbUpArgv(target), { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new CommandError((errText.trim() || out.trim() || `wb up exited with ${code}`).split("\n")[0]);
	const err = errText.trim();
	return { out, err: err ? err.split("\n")[0] : null };
}

/**
 * The board notice for a `wb up` run: wb's own first stderr line when it wrote one, its
 * degradation line when nothing resumed (`wb up` no-ops silently while the workbench session
 * is down), else the opened line — naming the split pane when the board just booted the
 * session, the statusline hint otherwise.
 */
export function wbUpNotice(r: { out: string; err: string | null }, target: string, repoName: string, booted: boolean): string {
	if (r.err) return r.err;
	if (!/^Resuming /m.test(r.out)) {
		const note = r.out
			.split("\n")
			.map(l => l.trim())
			.find(l => /No herdr session|No sessions for|No session-bearing trees/.test(l));
		return note
			? `${note} — retry once the workbench session is up`
			: "wb up opened nothing — the workbench session may still be booting; retry in a moment";
	}
	const tail = booted ? "booting in the wb-session split pane" : "switch sessions in the herdr statusline to see the agent tabs";
	return `opened ${repoName}/${target} in session 'workbench' — ${tail}`;
}

/**
 * Finishes a wb task locally (merge/squash into the parent branch, worktree teardown) and parses
 * the BR-9 result; nonzero exits carry wb's own first stderr line via `run()`'s CommandError.
 */
export async function wbFinish(task: string, repoRoot: string, action: WbFinishAction): Promise<FinishResult | undefined> {
	return parseFinishJson(await run(wbFinishArgv(task, repoRoot, action), repoRoot));
}
