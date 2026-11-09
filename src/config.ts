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
 * wb (sandbox manager) visibility and launch engine. `enabled` gates the read-only surfaces (the
 * `▣` card badge, the `/wb` pool view); `launcher` picks the engine for board actions — `herdr`
 * (default, unchanged upstream flow) or `wb` (agents start sandboxed via `wb start`); `agent` is
 * the wb argv agent used under `launcher: "wb"` (`omp` is a herdr kind, not a wb agent — the
 * config, not a translation table, decides).
 */
export type WbConfig = {
	enabled: boolean;
	launcher: "herdr" | "wb";
	agent: string;
};

/** One `/plan` stage: a prompt-with-context launch point, never a pipeline step. */
export type PlanStage = {
	/** Palette label of the stage (e.g. `Spark`). */
	name: string;
	/** One-line hint shown in the stage submenu. */
	description: string;
	/** johns-tools skill the stage starts (`{skillPath}` resolves from the discovered skills; unset → prompt without it). */
	skill?: string;
	/** Prompt template; placeholders {idea} {repo} {selection} {skillPath}. */
	prompt: string;
};

/** `/plan` visibility and stage table. `enabled` gates the `/plan` and `/drafts` surfaces. */
export type PlanConfig = {
	enabled: boolean;
	/** Replaces wholesale when provided (the `columns` precedent). */
	stages: PlanStage[];
	/** Label prefix grouping issues created from one planning run (`cluster-<slug>`). */
	clusterLabelPrefix: string;
};

/** `/orchestrate` visibility. `enabled` gates the `/orchestrate` surface. */
export type OrchestrateConfig = {
	enabled: boolean;
};

export type Config = {
	/** herdr agent kind started for new tickets (`herdr agent start --kind`). */
	agent: string;
	columns: ColumnSpec[];
	/**
	 * Templates. `implement`/`refine` placeholders: {number} {title} {repo} {url} {branch}.
	 * `skill` placeholders: {skill} {skillPath} {count} {repo} {tickets} {list} {branch} {range} {extra}.
	 * `orchestrate` placeholders: {repo} {tickets} {list} {range} {contextFile}.
	 */
	prompts: { implement: string; refine: string; skill: string; prototypeExtra: string; orchestrate: string };
	/** Skill roots scanned for SKILL.md files; defaults to the shared agent skill dirs. */
	skillDirs?: string[];
	prototype: PrototypeConfig;
	wb: WbConfig;
	plan: PlanConfig;
	orchestrate: OrchestrateConfig;
};

/** The to-tickets local-format contract every stage prompt ends with (drafts land as local markdown; GitHub stays untouched). */
const LOCAL_FALLBACK_CONTRACT =
	"Draft tickets as local markdown under `.scratch/<slug>/issues/` — one file per ticket `<NN>-<slug>.md` in " +
	"dependency order; rephrase proposals as `rephrase-<n>-<slug>.md`. Do NOT create, edit or comment on GitHub " +
	"issues — the board does that behind explicit consent.";

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
		orchestrate:
			"You are the orchestrator of a sprint over {tickets} in {repo} (selection {range}).\n" +
			"\n" +
			"Read the context file first — {contextFile} holds the number, title, labels and body of every selected ticket.\n" +
			"\n" +
			"Pipeline contract:\n" +
			"- Plan first, adaptable: start with a PLAN over the tickets, rephrasing/restructuring as proposals, then " +
			"continue into the default course — but the operator steers; no sequence is forced.\n" +
			"- Read-only on GitHub: `gh issue view`/`gh issue list` only; never `gh issue create/edit/comment` — replan " +
			"results come back as proposals (markdown here and/or files under `.scratch/`), never applied edits.\n" +
			"- Dispatch workers via `wb start issue-<n>` per ticket, batches as `issues-<range>-<slug>`; workers land in " +
			"wb sandboxes — badges, Review, Finish and `/attach` apply unchanged.\n" +
			"- Finish consented: `wb diff` for review; `wb finish`/`wb publish` only after the operator's explicit yes in " +
			"this pane; never push unprompted.\n" +
			"\n" +
			"{list}",
	},
	prototype: {
		skill: "prototype",
		branchPrefix: "slash/",
		dir: "prototype",
		artifactGlobs: ["**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.gif", "**/*.html"],
	},
	wb: {
		enabled: true,
		launcher: "herdr",
		agent: "pi",
	},
	plan: {
		enabled: false,
		stages: [
			{
				name: "Spark",
				description: "directions for a fresh idea",
				skill: "spark-ideas",
				prompt:
					'Use the "spark-ideas" skill (it lives at {skillPath}) in {repo}. Fresh idea: {idea}\n\n{selection}\n\n' +
					"Offer 2-3 directions with tradeoffs, then develop the one I pick. " +
					LOCAL_FALLBACK_CONTRACT,
			},
			{
				name: "Grill",
				description: "stress-test a plan or decision",
				skill: "grilling",
				prompt:
					'Use the "grilling" skill (it lives at {skillPath}) in {repo}. Stress-test this plan or decision: {idea}\n\n{selection}\n\n' +
					"Interview me relentlessly, attack the weakest assumptions, and record the resolved decisions. " +
					LOCAL_FALLBACK_CONTRACT,
			},
			{
				name: "To spec",
				description: "turn idea/notes into a spec",
				skill: "to-spec",
				prompt:
					'Use the "to-spec" skill (it lives at {skillPath}) in {repo}. Turn this idea and these notes into a spec: {idea}\n\n{selection}\n\n' +
					"Write the spec as local markdown under `.scratch/`. " +
					LOCAL_FALLBACK_CONTRACT,
			},
			{
				name: "To tickets",
				description: "break a spec into tracer-bullet tickets, local mode",
				skill: "to-tickets",
				prompt:
					'Use the "to-tickets" skill (it lives at {skillPath}) in {repo}. Break this spec into tracer-bullet tickets, local mode: {idea}\n\n{selection}\n\n' +
					"Number the tickets in dependency order, blockers first. " +
					LOCAL_FALLBACK_CONTRACT,
			},
			{
				name: "Rephrase",
				description: "draft a new body for the selected ticket(s)",
				prompt:
					"Draft a new body for the selected ticket(s) in {repo}. Instruction: {idea}\n\n{selection}\n\n" +
					"Write each proposal as a local rephrase draft file for the board to apply behind consent. " +
					LOCAL_FALLBACK_CONTRACT,
			},
			{
				name: "Free-form",
				description: "no stage; the idea plus the selection is the whole prompt",
				prompt: "{idea}\n\n{selection}\n\n" + LOCAL_FALLBACK_CONTRACT,
			},
		],
		clusterLabelPrefix: "cluster-",
	},
	orchestrate: {
		enabled: false,
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
		plan: { ...DEFAULTS.plan, ...user.plan },
		orchestrate: { ...DEFAULTS.orchestrate, ...user.orchestrate },
	};
}

export function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
