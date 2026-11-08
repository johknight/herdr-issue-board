// Pure-function tests for the wb read adapter: task-id derivation, branch↔task resolution
// and the degradation paths (run with `bun test`; no TTY, no wb, no git required).
import { describe, expect, test } from "bun:test";
import {
	issueNumbersForTask,
	parseSessions,
	selectionLabel,
	sessionsForTask,
	taskFromBranch,
	taskIdForIssue,
	taskIdForSkill,
} from "./wb";

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
