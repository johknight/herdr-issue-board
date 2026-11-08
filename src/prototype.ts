// Prototype hand-off: find the worktree a `/{skill}` run created, publish its artefacts on the
// branch, and post the branch pointer plus screenshots on each ticket it was generated for.
import { basename, join } from "node:path";
import { CommandError, run } from "./proc";

export type Worktree = { path: string; branch: string };

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export async function listWorktrees(repoCwd: string): Promise<Worktree[]> {
	const out = await run(["git", "worktree", "list", "--porcelain"], repoCwd);
	const trees: Worktree[] = [];
	let path: string | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch ") && path) trees.push({ path, branch: line.slice("branch ".length).replace("refs/heads/", "") });
		else if (!line.trim()) path = null;
	}
	return trees;
}

/** The `<prefix>` worktree whose branch embeds this selection range, or undefined — never a guess. */
export function pickPrototypeWorktree(trees: Worktree[], prefix: string, range: string): Worktree | undefined {
	const tail = (t: Worktree) => t.branch.slice(prefix.length);
	return trees.find(t => t.branch.startsWith(prefix) && (tail(t) === range || tail(t).startsWith(`${range}-`)));
}

export type Artifact = { rel: string; abs: string; image: boolean };

/**
 * Collects hand-off files (screenshots + the prototype itself) from `<repoRoot>/<dir>`.
 * `rel` is repo-relative, so `git add` and raw-URL links use the same path.
 */
export async function findArtifacts(repoRoot: string, dir: string, globs: string[]): Promise<Artifact[]> {
	const root = join(repoRoot, dir);
	const found = new Set<string>();
	for (const pattern of globs) {
		try {
			for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) found.add(rel);
		} catch (err) {
			// A configured glob that cannot be scanned silently disables part of the hand-off.
			throw new CommandError(`could not scan "${pattern}" under ${root}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return [...found]
		.filter(rel => rel.split("/").every(part => part !== "node_modules" && !part.startsWith(".")))
		.sort()
		.slice(0, 60)
		.map(rel => ({ rel: join(dir, rel), abs: join(root, rel), image: IMAGE.test(rel) }));
}

/**
 * Stages and commits (only when dirty) the given paths on the worktree's branch — host-side git,
 * no network, no push. The wb-launcher `/attach` commits here and pushes only via consented
 * `wb publish` (BR-12).
 */
export async function commitArtifacts(wt: Worktree, rels: string[], message: string): Promise<void> {
	if (!rels.length) return;
	const dirty = (await run(["git", "status", "--porcelain", "--", ...rels], wt.path)).trim();
	if (dirty) {
		await run(["git", "add", "--", ...rels], wt.path);
		await run(["git", "commit", "-m", message, "--", ...rels], wt.path);
	}
}

/**
 * Stages, commits (only when dirty) and pushes the given paths on the worktree's branch — the
 * herdr-launcher legacy flow, kept verbatim (BR-12: under `launcher: "wb"` the board never
 * pushes git itself; the only push path there is a consented `wb publish`).
 */
export async function publishArtifacts(wt: Worktree, rels: string[], message: string): Promise<void> {
	if (!rels.length) return;
	await commitArtifacts(wt, rels, message);
	try {
		await run(["git", "push", "-u", "origin", wt.branch], wt.path);
	} catch (err) {
		throw new CommandError(`could not push ${wt.branch}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export const rawUrl = (repo: string, branch: string, rel: string) =>
	`https://raw.githubusercontent.com/${repo}/${branch}/${rel.split("/").map(encodeURIComponent).join("/")}`;

export type CommentInput = {
	branch: string;
	repo: string;
	skill?: string;
	numbers: number[];
	/** false = branch is local-only: no raw-URL embeds (they would 404), file list only. */
	pushed?: boolean;
	artifacts: Artifact[];
};

export function artifactComment(o: CommentInput): string {
	const pushed = o.pushed ?? true;
	const shots = pushed ? o.artifacts.filter(a => a.image).map(a => `![${basename(a.rel)}](${rawUrl(o.repo, o.branch, a.rel)})`) : [];
	const files = o.artifacts.filter(a => !a.image).map(a => `- \`${a.rel}\``);
	const how = o.skill
		? `Generated with the \`/${o.skill}\` skill from the issue board`
		: "Generated with the prototype skill from the issue board";
	const inspect = pushed
		? `Prototype branch: \`${o.branch}\` — inspect with \`git fetch origin && git checkout ${o.branch}\`.`
		: `Prototype branch: \`${o.branch}\` — committed locally, not pushed to origin yet.`;
	return [
		"### Prototype preview",
		"",
		`${how} for ${o.numbers.map(n => `#${n}`).join(", ")}.`,
		"",
		inspect,
		"",
		...(shots.length ? ["Screenshots of the prototype:", "", ...shots, ""] : []),
		...(files.length ? ["Prototype files:", "", ...files, ""] : []),
		"---",
		"",
		"Implement this ticket to match the prototype. The prototype is throwaway: fold the validated decision into the real code, then delete the branch.",
	].join("\n");
}

/**
 * Comments on each issue in turn, attempting every issue even after a failure; on any failure it
 * throws one honest summary naming what succeeded and what failed, instead of aborting mid-loop.
 * Serial on purpose: `gh issue comment` is a GraphQL mutation and GitHub asks for one request at a
 * time per user — firing N concurrently is what returns "was submitted too quickly".
 */
export async function commentOnIssues(cwd: string, numbers: number[], body: string, runner: typeof run = run): Promise<void> {
	const ok: number[] = [];
	const failed: string[] = [];
	for (const n of numbers) {
		try {
			await runner(["gh", "issue", "comment", String(n), "--body", body], cwd);
			ok.push(n);
		} catch (err) {
			failed.push(`failed on #${n}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (failed.length)
		throw new CommandError([...(ok.length ? [`commented on ${ok.map(n => `#${n}`).join(", ")}`] : []), ...failed].join("; "));
}
