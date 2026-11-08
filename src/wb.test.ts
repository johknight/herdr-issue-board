// Pure-function tests for the wb read adapter and launch-engine wiring: task-id derivation,
// branch↔task resolution, launcher decisions, consent handling and the mutating argv contracts
// (run with `bun test`; no TTY, no wb, no git required).
import { describe, expect, test } from "bun:test";
import {
	consentAnswer,
	issueNumbersForTask,
	localBranchFor,
	parseFinishJson,
	parseSessions,
	remoteBranchFor,
	resolveLauncher,
	selectionLabel,
	sessionsForTask,
	taskForIssue,
	taskFromBranch,
	taskIdForIssue,
	taskIdForSkill,
	wbDiffArgv,
	wbFinishArgv,
	wbPublishArgv,
	wbStartArgv,
	type PoolTask,
} from "./wb";

const pool = (over: Partial<PoolTask>): PoolTask => ({
	task: "",
	branch: "",
	path: "/tmp/x",
	mode: "tree",
	issues: [],
	dirty: false,
	...over,
});

describe("task-id derivation", () => {
	test("a single ticket becomes issue-<n>", () => {
		expect(taskIdForIssue(183)).toBe("issue-183");
	});

	test("a skill over a contiguous selection collapses to issues-<lo-hi>-<skill>", () => {
		const range = Array.from({ length: 10 }, (_, i) => 183 + i);
		expect(taskIdForSkill(range, "prototype")).toBe("issues-183-192-prototype");
	});

	test("a skill over a comma selection joins with dashes", () => {
		expect(taskIdForSkill([190, 185, 183], "refine")).toBe("issues-183-185-190-refine");
	});

	test("the same selection always recomputes the same id", () => {
		expect(taskIdForSkill([183, 185, 190], "refine")).toBe(taskIdForSkill([185, 190, 183], "refine"));
	});

	test("selection labels", () => {
		expect(selectionLabel([5])).toBe("5");
		expect(selectionLabel([3, 4, 5])).toBe("3-5");
		expect(selectionLabel([3, 5, 7])).toBe("3-5-7");
		expect(selectionLabel([1, 2, 5, 6, 9])).toBe("1-2-5-6-9");
		expect(selectionLabel([7, 3])).toBe("3-7");
		expect(selectionLabel([])).toBe("none");
	});
});

describe("branch → task matching", () => {
	test("serial pool branch", () => {
		expect(taskFromBranch("wb/issue-183")).toBe("issue-183");
	});

	test("tree pool branch resolves with the tree- prefix stripped", () => {
		expect(taskFromBranch("agent/tree-issue-183")).toBe("issue-183");
	});

	test("the serial worktree's branch is a task too", () => {
		expect(taskFromBranch("wb/serial")).toBe("serial");
	});

	test("non-pool branches house no wb task", () => {
		expect(taskFromBranch("main")).toBeUndefined();
		expect(taskFromBranch("issue/183-fix")).toBeUndefined();
		expect(taskFromBranch("slash/183-192-prototype")).toBeUndefined();
		expect(taskFromBranch("wb/")).toBeUndefined();
	});
});

describe("task → issue numbers", () => {
	test("single-ticket task ids name their issue", () => {
		expect(issueNumbersForTask("issue-183")).toEqual([183]);
	});

	test("skill task ids name the selected issues", () => {
		expect(issueNumbersForTask("issues-183-185-190-refine")).toEqual([183, 185, 190]);
	});

	test("a collapsed range reads as its edge issues", () => {
		expect(issueNumbersForTask("issues-183-192-prototype")).toEqual([183, 192]);
	});

	test("task ids without an issue number never match a card", () => {
		expect(issueNumbersForTask("hello-world")).toEqual([]);
		expect(issueNumbersForTask("serial")).toEqual([]);
		expect(issueNumbersForTask("issues-skill-only")).toEqual([]);
		expect(issueNumbersForTask("issues-")).toEqual([]);
	});
});

describe("session counts", () => {
	const sessions = [
		{ tree: "tree-issue-183", repo: "demo" },
		{ tree: "tree-issue-183", repo: "demo" },
		{ tree: "tree-issue-184", repo: "demo" },
		{ tree: "serial", repo: "demo" },
		{ tree: "serial", repo: "other" },
	];

	test("tree mode counts tree-<task> sessions of the focused repo", () => {
		expect(sessionsForTask(sessions, { task: "issue-183", mode: "tree" }, "demo")).toBe(2);
		expect(sessionsForTask(sessions, { task: "issue-184", mode: "tree" }, "demo")).toBe(1);
	});

	test("serial mode counts the serial sessions of the focused repo", () => {
		expect(sessionsForTask(sessions, { task: "issue-9", mode: "serial" }, "demo")).toBe(1);
	});

	test("sessions of another repo do not count", () => {
		expect(sessionsForTask(sessions, { task: "issue-183", mode: "tree" }, "other")).toBe(0);
	});
});

describe("degradation on malformed data", () => {
	test("malformed sessions JSON yields an empty list", () => {
		expect(parseSessions("not json at all")).toEqual([]);
		expect(parseSessions('{"tree":"serial"}')).toEqual([]);
		expect(parseSessions("[1, 2]")).toEqual([]);
		expect(parseSessions('[{"tree":"serial"}, null]')).toEqual([{ tree: "serial" }]);
	});

	test("valid session records pass through", () => {
		const text = JSON.stringify([{ id: "s1", agent: "pi", tree: "tree-issue-183", repo: "demo", mtime: 1.5 }]);
		expect(parseSessions(text)).toEqual([{ id: "s1", agent: "pi", tree: "tree-issue-183", repo: "demo", mtime: 1.5 }]);
	});
});

describe("launcher resolution (BR-10)", () => {
	test("the herdr default never routes through wb", () => {
		expect(resolveLauncher("herdr", true, true)).toEqual({ wb: false, notice: null });
	});

	test("wb launcher with wb present and enabled routes through wb", () => {
		expect(resolveLauncher("wb", true, true)).toEqual({ wb: true, notice: null });
	});

	test("wb launcher without wb falls back to herdr with a one-line notice", () => {
		const r = resolveLauncher("wb", true, false);
		expect(r.wb).toBe(false);
		expect(r.notice).toBeTruthy();
		// Never a hard failure mid-selection — the notice is the whole message.
		expect(typeof r.notice).toBe("string");
	});

	test("wb launcher with the wb surfaces disabled falls back with a notice too", () => {
		const r = resolveLauncher("wb", false, true);
		expect(r.wb).toBe(false);
		expect(r.notice).toBeTruthy();
	});
});

describe("pool branch naming (BR-11/BR-12)", () => {
	test("tree-mode tasks live on agent/tree-<task>", () => {
		expect(localBranchFor("issue-183", "tree")).toBe("agent/tree-issue-183");
	});

	test("tree-mode tasks publish to wb/tree-<task> (probed against `wb publish --yes`)", () => {
		expect(remoteBranchFor("issue-183", "tree")).toBe("wb/tree-issue-183");
	});

	test("serial tasks live on and publish to wb/<task>", () => {
		expect(localBranchFor("issue-183", "serial")).toBe("wb/issue-183");
		expect(remoteBranchFor("issue-183", "serial")).toBe("wb/issue-183");
	});
});

describe("card → wb task mapping (BR-14)", () => {
	const tasks = [
		pool({ task: "issues-183-192-prototype", branch: "agent/tree-issues-183-192-prototype", issues: [183, 192] }),
		pool({ task: "issue-183", branch: "agent/tree-issue-183", mode: "tree", issues: [183] }),
	];

	test("an exact issue-<n> task wins over a selection task naming the same issue", () => {
		expect(taskForIssue(tasks, 183)?.task).toBe("issue-183");
	});

	test("a card covered only by a selection task maps to it", () => {
		expect(taskForIssue(tasks, 192)?.task).toBe("issues-183-192-prototype");
	});

	test("cards without any wb task map to nothing", () => {
		expect(taskForIssue(tasks, 184)).toBeUndefined();
		expect(taskForIssue([], 183)).toBeUndefined();
	});
});

describe("consent answers ([y/N])", () => {
	test("y consents, in any casing or with padding", () => {
		for (const text of ["y", "Y", "yes", " y ", "YES"]) expect(consentAnswer(text)).toBe(true);
	});

	test("the bare-enter default and anything else declines", () => {
		for (const text of ["", " ", "n", "no", "push", "yes please", "0"]) expect(consentAnswer(text)).toBe(false);
	});
});

describe("wb finish --json parsing (BR-9)", () => {
	test("the result object is the last stdout line behind the human text", () => {
		const out = [
			"=== Summary for agent/tree-issue-10 (parent: main) ===",
			"Squashing agent/tree-issue-10 into main...",
			'{"task": "tree-issue-10", "action": "squash", "branch": "agent/tree-issue-10", "parent": "main", "sha": "b4ca0f6", "worktree": "/wt/tree-issue-10"}',
		].join("\n");
		expect(parseFinishJson(out)).toEqual({
			task: "tree-issue-10",
			action: "squash",
			branch: "agent/tree-issue-10",
			parent: "main",
			sha: "b4ca0f6",
			worktree: "/wt/tree-issue-10",
		});
	});

	test("kill finishes carry a null sha", () => {
		const out = 'Done.\n{"task": "tree-issue-9", "action": "kill", "branch": "agent/tree-issue-9", "parent": "main", "sha": null, "worktree": "/wt/tree-issue-9"}';
		expect(parseFinishJson(out)?.sha).toBeNull();
	});

	test("unparseable output yields undefined, never a crash", () => {
		expect(parseFinishJson("")).toBeUndefined();
		expect(parseFinishJson("no json at all")).toBeUndefined();
		expect(parseFinishJson("{ broken")).toBeUndefined();
		expect(parseFinishJson('{"task": 1}')).toBeUndefined();
	});
});

describe("mutating argv contracts (BR-11/BR-12/BR-14)", () => {
	test("wb start: task, repo, agent, setup skipped, prompt from a file — never prompt text in argv", () => {
		const argv = wbStartArgv("issue-183", "/repo", "pi", "/tmp/prompt-1.txt");
		expect(argv).toEqual(["wb", "start", "issue-183", "--repo", "/repo", "pi", "--setup=skip", "--prompt-file", "/tmp/prompt-1.txt"]);
		expect(argv.join(" ")).not.toContain("Implement GitHub issue");
	});

	test("wb publish: --yes is the only consent flag", () => {
		expect(wbPublishArgv("issue-183", "/repo")).toEqual(["wb", "publish", "issue-183", "--repo", "/repo", "--yes"]);
	});

	test("wb diff: read-only, no mutating flag", () => {
		const argv = wbDiffArgv("issue-183", "/repo");
		expect(argv).toEqual(["wb", "diff", "issue-183", "--repo", "/repo"]);
		expect(argv).not.toContain("--yes");
	});

	test("wb finish: action + --yes + --json, and never anything push- or delete-shaped", () => {
		for (const action of ["merge", "squash", "kill"] as const) {
			const argv = wbFinishArgv("issues-183-192-prototype", "/repo", action);
			expect(argv).toEqual(["wb", "finish", "issues-183-192-prototype", action, "--yes", "--json", "--repo", "/repo"]);
			expect(argv.some(a => /push|delete|remote|prune/.test(a))).toBe(false);
		}
	});
});
