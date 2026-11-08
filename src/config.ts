import { join } from "node:path";

/** A board column: open issues carrying `label` land here (first matching column wins). */
export type ColumnSpec = { title: string; label: string };

/** Where `/{skill}` runs put their work and what the board publishes back onto the tickets. */
export type PrototypeConfig = {
	/** Skill whose runs get `prompts.prototypeExtra` appended and whose artefacts `/attach` publishes. */
	skill: string;
	/** Branch namespace for `/{skill}` worktrees; `/attach` matches worktrees on it. */
	branchPrefix: string;
	/** Directory inside the worktree where the agent leaves the prototype and its screenshots. */
	dir: string;
	/** Globs, relative to `dir`, of the files published to the tickets. */
	artifactGlobs: string[];
};

/**
 * wb (sandbox manager) visibility: the `▣` card badge and the `/wb` pool view are read-only
 * surfaces; both hide when `enabled` is false (and when wb is not installed at all).
 */
export type WbConfig = {
	enabled: boolean;
};

export type Config = {
	/** herdr agent kind started for new tickets (`herdr agent start --kind`). */
	agent: string;
	columns: ColumnSpec[];
	/**
	 * Templates. `implement`/`refine` placeholders: {number} {title} {repo} {url} {branch}.
	 * `skill` placeholders: {skill} {skillPath} {count} {repo} {tickets} {list} {branch} {range} {extra}.
	 */
	prompts: { implement: string; refine: string; skill: string; prototypeExtra: string };
	/** Skill roots scanned for SKILL.md files; defaults to the shared agent skill dirs. */
	skillDirs?: string[];
	prototype: PrototypeConfig;
	wb: WbConfig;
};

const DEFAULTS: Config = {
	agent: "omp",
	columns: [
		{ title: "Needs triage", label: "needs-triage" },
		{ title: "Needs info", label: "needs-info" },
		{ title: "Ready for agent", label: "ready-for-agent" },
		{ title: "Ready for human", label: "ready-for-human" },
	],
	prompts: {
		implement:
			'Implement GitHub issue #{number} in {repo}: "{title}" ({url}). ' +
			"Read the full ticket first with `gh issue view {number} --comments`, then implement it end to end.",
		refine:
			'Help me refine GitHub issue #{number} in {repo}: "{title}" ({url}). ' +
			"Read it with `gh issue view {number} --comments`, ask me what should change, " +
			"then update it with `gh issue edit {number}`. Do not implement it.",
		skill:
			'Use the "{skill}" skill (it lives at {skillPath}) for {count} GitHub tickets in {repo}: {tickets}.\n' +
			"\n{list}\n" +
			"\nRead each ticket with `gh issue view <n> --comments` before starting. You are in a fresh git worktree on " +
			"branch `{branch}` — leave main untouched and keep every artefact on this branch.{extra}",
		prototypeExtra:
			"\n\nWhen the prototype is ready, capture it: save one full-page screenshot per variant as PNG under " +
			"`prototype/screenshots/` in this worktree, named after the variant, and commit them on this branch. " +
			"That way the issue board can post them on the tickets with `/attach` and the implementing agent knows exactly what to build.",
	},
	prototype: {
		skill: "prototype",
		branchPrefix: "slash/",
		dir: "prototype",
		artifactGlobs: ["**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.gif", "**/*.html"],
	},
	wb: {
		enabled: true,
	},
};

/** Loads `$HERDR_PLUGIN_CONFIG_DIR/config.json` over the defaults; `columns` replaces, the rest merges. */
export async function loadConfig(): Promise<Config> {
	const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
	if (!dir) return DEFAULTS;
	const file = Bun.file(join(dir, "config.json"));
	if (!(await file.exists())) return DEFAULTS;
	const user = (await file.json()) as Partial<Config>;
	return {
		agent: user.agent ?? DEFAULTS.agent,
		columns: user.columns ?? DEFAULTS.columns,
		prompts: { ...DEFAULTS.prompts, ...user.prompts },
		skillDirs: user.skillDirs ?? DEFAULTS.skillDirs,
		prototype: { ...DEFAULTS.prototype, ...user.prototype },
		wb: { ...DEFAULTS.wb, ...user.wb },
	};
}

export function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
