import { describe, expect, test } from "bun:test";
import { CommandError } from "./proc";
import { commentOnIssues, pickPrototypeWorktree, type Worktree } from "./prototype";

const wt = (branch: string, path = `/tmp/wt/${branch}`): Worktree => ({ path, branch });
const proto = (...branches: string[]) => branches.map(b => wt(b));

describe("pickPrototypeWorktree", () => {
	test("returns the worktree whose branch is exactly the range", () => {
		const trees = [...proto("main"), ...proto("proto/183-185", "proto/183-185-ui", "scratch/183-185")];
		expect(pickPrototypeWorktree(trees, "proto/", "183-185")?.branch).toBe("proto/183-185");
	});

	test("matches a range-then-suffix branch like proto/<range>-<skill>", () => {
		const trees = proto("proto/183-185-ui", "proto/183-ui");
		expect(pickPrototypeWorktree(trees, "proto/", "183-185")?.branch).toBe("proto/183-185-ui");
	});

	test("returns undefined instead of guessing when no branch matches the range", () => {
		const trees = proto("proto/201-202-ui", "proto/42");
		expect(pickPrototypeWorktree(trees, "proto/", "183-185")).toBeUndefined();
	});

	test("returns undefined when there is no prefix worktree at all", () => {
		expect(pickPrototypeWorktree(proto("main", "issue/7-fix"), "proto/", "7")).toBeUndefined();
	});
});

const ghRunner =
	(behaviour: Record<string, Error | undefined>) =>
	async (argv: string[]): Promise<string> => {
		const issue = argv[3];
		const failure = behaviour[issue];
		if (failure) throw failure;
		return issue;
	};

describe("commentOnIssues", () => {
	test("comments on every issue and resolves when all succeed", async () => {
		const calls: string[] = [];
		await commentOnIssues("/repo", [183, 184, 185], "body", async argv => {
			calls.push(argv[3]);
			return "done";
		});
		expect(calls).toEqual(["183", "184", "185"]);
	});

	test("sends one comment at a time — GitHub rate-limits concurrent mutations", async () => {
		let inFlight = 0;
		let peak = 0;
		await commentOnIssues("/repo", [1, 2, 3], "body", async () => {
			peak = Math.max(peak, ++inFlight);
			await new Promise(resolve => setTimeout(resolve, 5));
			inFlight--;
			return "done";
		});
		expect(peak).toBe(1);
	});

	test("partial failure reports succeeded and failed issue numbers honestly", async () => {
		const runner = ghRunner({ "184": new CommandError("gh: GraphQL: was submitted too quickly") });
		await expect(commentOnIssues("/repo", [183, 184, 185], "body", runner)).rejects.toThrow(
			"commented on #183, #185; failed on #184: gh: GraphQL: was submitted too quickly",
		);
	});

	test("total failure reports only the failures, swallowing nothing", async () => {
		const runner = ghRunner({
			"183": new CommandError("gh: not found"),
			"184": new CommandError("gh: network"),
		});
		await expect(commentOnIssues("/repo", [183, 184], "body", runner)).rejects.toThrow(
			"failed on #183: gh: not found; failed on #184: gh: network",
		);
	});
});
