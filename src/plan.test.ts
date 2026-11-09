// Pure-function tests for the /plan + /orchestrate data layer (batch PO-1): the consented gh argv
// contracts, the to-tickets drafts adapter, the orchestrator context builder and the config gates
// (run with `bun test`; no TTY, no gh, no git required — fixtures live in a temp dir).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { createIssueArgv, editBodyArgv } from "./github";
import { collectDrafts, consentSummary, parseDraftFile } from "./drafts";
import { orchestrateContext } from "./orchestrate";

const temp = mkdtempSync(join(tmpdir(), "plan-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("consented gh argv contracts (PR-2)", () => {
	test("gh issue create: title, body as a file path, labels — never body text in argv", () => {
		const argv = createIssueArgv("Fix login flow", "/tmp/draft-01.md", ["needs-triage", "cluster-feature-x"]);
		expect(argv).toEqual([
			"gh",
			"issue",
			"create",
			"--title",
			"Fix login flow",
			"--body-file",
			"/tmp/draft-01.md",
			"--label",
			"needs-triage",
			"--label",
			"cluster-feature-x",
		]);
		expect(argv.filter(a => a.startsWith("--")).sort()).toEqual(["--body-file", "--label", "--label", "--title"]);
	});

	test("gh issue create without labels carries no --label flag", () => {
		expect(createIssueArgv("T", "/tmp/b.md", [])).toEqual(["gh", "issue", "create", "--title", "T", "--body-file", "/tmp/b.md"]);
	});

	test("gh issue edit: number + body file, nothing else", () => {
		expect(editBodyArgv(41, "/tmp/rephrase-3.md")).toEqual(["gh", "issue", "edit", "41", "--body-file", "/tmp/rephrase-3.md"]);
	});
});

describe("drafts parsing (PR-3)", () => {
	test("a to-tickets fixture yields kind, nn, slug, cluster, title and whole-file body", () => {
		const text = "# 01 — Fix login flow\n\n**Delivers:** working login\n\n**Blocked by:** nothing\n";
		const draft = parseDraftFile(".scratch/feature-x/issues/01-fix-login.md", text);
		expect(draft).toEqual({
			kind: "ticket",
			nn: 1,
			slug: "fix-login",
			cluster: "feature-x",
			title: "Fix login flow",
			path: ".scratch/feature-x/issues/01-fix-login.md",
			body: text,
		});
	});

	test("a rephrase file targets its issue number", () => {
		const text = "# New body\n\nrewritten\n";
		const draft = parseDraftFile(".scratch/feature-x/issues/rephrase-3-rewrite-body.md", text);
		expect(draft).toEqual({
			kind: "rephrase",
			issue: 3,
			slug: "rewrite-body",
			cluster: "feature-x",
			path: ".scratch/feature-x/issues/rephrase-3-rewrite-body.md",
			body: text,
		});
	});

	test("the heading prefix strips with em dash or hyphen, and a missing heading falls back to the slug", () => {
		const a = parseDraftFile(".scratch/c/issues/02-a.md", "# 02 - Add tests\nbody");
		expect(a?.kind).toBe("ticket");
		if (a?.kind === "ticket") expect(a.title).toBe("Add tests");
		const b = parseDraftFile(".scratch/c/issues/03-b.md", "no heading at all");
		if (b?.kind === "ticket") expect(b.title).toBe("b");
	});

	test("unparseable filenames yield undefined, never a throw", () => {
		expect(parseDraftFile(".scratch/c/issues/notes.md", "# Notes\n")).toBeUndefined();
		expect(parseDraftFile(".scratch/c/issues/rephrase-x.md", "# Broken\n")).toBeUndefined();
		expect(parseDraftFile(".scratch/c/issues/1-single-digit.md", "# One\n")).toBeUndefined();
	});
});

describe("drafts collection (PR-3)", () => {
	const repo = join(temp, "repo-drafts");
	mkdirSync(join(repo, ".scratch", "feature-x", "issues"), { recursive: true });
	writeFileSync(join(repo, ".scratch", "feature-x", "issues", "02-add-tests.md"), "# 02 — Add tests\n\n**Delivers:** coverage\n");
	writeFileSync(join(repo, ".scratch", "feature-x", "issues", "01-fix-login.md"), "# 01 — Fix login flow\n\n**Delivers:** login\n");
	writeFileSync(join(repo, ".scratch", "feature-x", "issues", "rephrase-3-rewrite-body.md"), "# New body\n\nrewritten\n");
	writeFileSync(join(repo, ".scratch", "feature-x", "issues", "notes.md"), "just notes, no draft shape\n");
	// the orchestrate context dir is not a drafts cluster
	mkdirSync(join(repo, ".scratch", "orchestrate"), { recursive: true });
	writeFileSync(join(repo, ".scratch", "orchestrate", "3-5-20261108-120000.md"), "# Sprint context\n");

	test("two tickets + one rephrase collect in nn/issue order, malformed and orchestrate files skipped", async () => {
		const drafts = await collectDrafts(repo);
		expect(drafts.map(d => (d.kind === "ticket" ? `#${d.nn} ${d.title}` : `rephrase #${d.issue}`))).toEqual([
			"#1 Fix login flow",
			"#2 Add tests",
			"rephrase #3",
		]);
		expect(drafts[0]).toMatchObject({ cluster: "feature-x", path: ".scratch/feature-x/issues/01-fix-login.md" });
	});

	test("a repo without .scratch/ yields an empty list", async () => {
		expect(await collectDrafts(join(temp, "repo-empty"))).toEqual([]);
	});

	test("consentSummary counts the accepted drafts only", () => {
		const drafts = [
			{ kind: "ticket", nn: 1, slug: "a", cluster: "c", title: "A", path: "p1", body: "" },
			{ kind: "ticket", nn: 2, slug: "b", cluster: "c", title: "B", path: "p2", body: "" },
			{ kind: "rephrase", issue: 3, slug: "d", cluster: "c", path: "p3", body: "" },
		] as const;
		expect(consentSummary([...drafts], new Set(["p1", "p2", "p3"]))).toBe("create 2 issues and update 1 ticket");
		expect(consentSummary([...drafts], new Set(["p1", "p3"]))).toBe("create 1 issue and update 1 ticket");
		expect(consentSummary([...drafts], new Set())).toBe("create 0 issues and update 0 tickets");
	});
});

describe("orchestrate context builder (PR-4)", () => {
	test("header plus one section per ticket, pinned", () => {
		const out = orchestrateContext("owner/repo", [
			{ number: 183, title: "Fix login", labels: ["needs-triage", "cluster-x"], body: "Body of 183.\n" },
			{ number: 184, title: "Add tests", labels: [], body: "" },
		]);
		expect(out).toBe(
			[
				"# Sprint context — owner/repo",
				"",
				"2 tickets (183-184)",
				"",
				"# 183 — Fix login",
				"",
				"labels: needs-triage, cluster-x",
				"",
				"Body of 183.",
				"",
				"# 184 — Add tests",
				"",
				"labels: ",
				"",
				"(no body)",
				"",
			].join("\n"),
		);
	});

	test("a single ticket reads as one ticket and a gapless selection collapses to a range", () => {
		const one = orchestrateContext("r", [{ number: 7, title: "T", labels: [], body: "b" }]);
		expect(one).toContain("1 ticket (7)");
		expect(orchestrateContext("r", [
			{ number: 5, title: "T", labels: [], body: "b" },
			{ number: 3, title: "T", labels: [], body: "b" },
		])).toContain("(3-5)");
	});
});

describe("config gates (PR-1)", () => {
	const withConfigDir = (dir: string, json?: unknown) => {
		mkdirSync(dir, { recursive: true });
		if (json !== undefined) writeFileSync(join(dir, "config.json"), JSON.stringify(json));
		const prev = process.env.HERDR_PLUGIN_CONFIG_DIR;
		process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
		return () => {
			if (prev === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
			else process.env.HERDR_PLUGIN_CONFIG_DIR = prev;
		};
	};

	test("no config file: both features off, defaults intact", async () => {
		const restore = withConfigDir(join(temp, "cfg-none"));
		try {
			const config = await loadConfig();
			expect(config.plan.enabled).toBe(false);
			expect(config.orchestrate.enabled).toBe(false);
			expect(config.plan.clusterLabelPrefix).toBe("cluster-");
			expect(config.plan.stages.map(s => s.name)).toEqual(["Spark", "Grill", "To spec", "To tickets", "Rephrase", "Free-form"]);
			expect(config.prompts.orchestrate).toContain("{contextFile}");
		} finally {
			restore();
		}
	});

	test("enabling plan keeps the default stage table", async () => {
		const dir = join(temp, "cfg-plan-on");
		const restore = withConfigDir(dir, { plan: { enabled: true } });
		try {
			const config = await loadConfig();
			expect(config.plan.enabled).toBe(true);
			expect(config.orchestrate.enabled).toBe(false);
			expect(config.plan.stages.map(s => s.name)).toEqual(["Spark", "Grill", "To spec", "To tickets", "Rephrase", "Free-form"]);
		} finally {
			restore();
		}
	});

	test("a user plan.stages replaces the default table wholesale", async () => {
		const dir = join(temp, "cfg-stages");
		const restore = withConfigDir(dir, {
			plan: { stages: [{ name: "Only", description: "one stage", prompt: "{idea}" }] },
		});
		try {
			const config = await loadConfig();
			expect(config.plan.enabled).toBe(false);
			expect(config.plan.stages).toEqual([{ name: "Only", description: "one stage", prompt: "{idea}" }]);
		} finally {
			restore();
		}
	});

	test("every default stage prompt ends with the local-fallback contract", async () => {
		const restore = withConfigDir(join(temp, "cfg-contract"));
		try {
			const config = await loadConfig();
			for (const stage of config.plan.stages) {
				expect(stage.prompt.endsWith("the board does that behind explicit consent.")).toBe(true);
			}
		} finally {
			restore();
		}
	});
});
