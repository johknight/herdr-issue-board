// Adapter for the to-tickets local markdown format (the drafts contract): one file per ticket under
// `.scratch/<slug>/issues/<NN>-<slug>.md`, rephrase proposals as `rephrase-<n>-<slug>.md`. Parsing is
// tolerant — malformed files are skipped silently, never thrown; a repo without `.scratch/` yields [].
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** A drafted ticket: `<NN>-<slug>.md` under `.scratch/<cluster>/issues/`, `nn` is the dependency order. */
export type TicketDraft = {
	kind: "ticket";
	nn: number;
	slug: string;
	cluster: string;
	title: string;
	path: string;
	body: string;
};

/** A drafted body replacement for an existing issue: `rephrase-<n>-<slug>.md`. */
export type RephraseDraft = {
	kind: "rephrase";
	issue: number;
	slug: string;
	cluster: string;
	path: string;
	body: string;
};

export type Draft = TicketDraft | RephraseDraft;

/** The `<cluster>` directory of a `.scratch/<cluster>/issues/` path (empty when the shape doesn't match). */
function clusterOf(rel: string): string {
	return rel.match(/\.scratch\/([^/]+)\/issues\//)?.[1] ?? "";
}

/** The first `# ` heading with a leading `<NN> —` prefix stripped; falls back to the filename slug. */
function titleOf(text: string, slug: string): string {
	const heading = text.split("\n").find(l => l.startsWith("# "));
	if (!heading) return slug;
	return heading.slice(2).replace(/^\d+\s*[—–-]\s*/, "").trim() || slug;
}

/**
 * Parses one draft file. Kind comes from the filename (`<NN>-<slug>.md` vs `rephrase-<n>-<slug>.md`),
 * the title from the first `# ` heading, the body is the whole file. Anything unparseable → undefined.
 */
export function parseDraftFile(rel: string, text: string): Draft | undefined {
	const file = rel.split("/").pop() ?? rel;
	const cluster = clusterOf(rel);
	const ticket = file.match(/^(\d{2,})-(.+)\.md$/);
	if (ticket) {
		const slug = ticket[2];
		return {
			kind: "ticket",
			nn: Number(ticket[1]),
			slug,
			cluster,
			title: titleOf(text, slug),
			path: rel,
			body: text,
		};
	}
	const rephrase = file.match(/^rephrase-(\d+)-(.+)\.md$/);
	if (rephrase) {
		return { kind: "rephrase", issue: Number(rephrase[1]), slug: rephrase[2], cluster, path: rel, body: text };
	}
	return undefined;
}

/**
 * Scans `.scratch/<cluster>/issues/*.md` (skipping the `orchestrate` context dir) and returns tickets sorted
 * by `nn` then rephrases by `issue`. Never throws — any failure yields an empty or partial list.
 */
export async function collectDrafts(repoCwd: string): Promise<Draft[]> {
	try {
		const scratchDir = join(repoCwd, ".scratch");
		const clusters = (await readdir(scratchDir, { withFileTypes: true }))
			.filter(e => e.isDirectory() && e.name !== "orchestrate")
			.map(e => e.name);
		const drafts: Draft[] = [];
		for (const cluster of clusters) {
			const issuesDir = join(scratchDir, cluster, "issues");
			let files: string[];
			try {
				files = (await readdir(issuesDir)).filter(f => f.endsWith(".md"));
			} catch {
				continue; // no issues dir in this cluster
			}
			for (const file of files) {
				const rel = `.scratch/${cluster}/issues/${file}`;
				try {
					const draft = parseDraftFile(rel, await Bun.file(join(issuesDir, file)).text());
					if (draft) drafts.push(draft);
				} catch {
					// unreadable file — skipped silently
				}
			}
		}
		const tickets = drafts.filter((d): d is TicketDraft => d.kind === "ticket").sort((a, b) => a.nn - b.nn);
		const rephrases = drafts.filter((d): d is RephraseDraft => d.kind === "rephrase").sort((a, b) => a.issue - b.issue);
		return [...tickets, ...rephrases];
	} catch {
		return []; // no `.scratch/` or unreadable — never a crash
	}
}

/** The y/N consent label text for the accepted drafts: "create 2 issues and update 1 ticket". */
export function consentSummary(drafts: Draft[], accepted: Set<string>): string {
	let create = 0;
	let update = 0;
	for (const d of drafts) {
		if (!accepted.has(d.path)) continue;
		if (d.kind === "ticket") create++;
		else update++;
	}
	return `create ${create} issue${create === 1 ? "" : "s"} and update ${update} ticket${update === 1 ? "" : "s"}`;
}
