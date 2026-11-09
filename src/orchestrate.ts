// Orchestrator context builder: the selected tickets' bodies collected via `gh issue view` (read-only,
// comments ignored) into one human-inspectable markdown file under `.scratch/orchestrate/` — the prompt
// references the path, argv stays small.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { issueDetail, type Issue } from "./github";
import { selectionLabel } from "./wb";

/** One selected ticket as the orchestrator sees it: body only, comments ignored. */
export type TicketContext = {
	number: number;
	title: string;
	labels: string[];
	body: string;
};

/** Pure markdown builder: header (repo, count, range), then one section per ticket. */
export function orchestrateContext(repo: string, tickets: TicketContext[]): string {
	const range = selectionLabel(tickets.map(t => t.number));
	const head = [
		`# Sprint context — ${repo}`,
		"",
		`${tickets.length} ticket${tickets.length === 1 ? "" : "s"} (${range})`,
	];
	const sections = tickets.map(t =>
		["", `# ${t.number} — ${t.title}`, "", `labels: ${t.labels.join(", ")}`, "", t.body.trim() || "(no body)"].join("\n"),
	);
	return [...head, ...sections].join("\n") + "\n";
}

/** Collects the selected issues' bodies via the existing `gh.issueDetail` (bodies only, comments ignored). */
export async function collectTicketContexts(cwd: string, issues: Issue[]): Promise<TicketContext[]> {
	return Promise.all(
		issues.map(async issue => {
			const detail = await issueDetail(cwd, issue.number);
			return { number: issue.number, title: issue.title, labels: issue.labels, body: detail.body };
		}),
	);
}

/** Path for the context file — `.scratch/orchestrate/<range>-<YYYYMMDD-HHMMSS>.md`; the dir is created on write. */
export function contextFilePath(repoCwd: string, range: string): string {
	const dir = join(repoCwd, ".scratch", "orchestrate");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// an unwritable dir only fails the later file write, which surfaces there
	}
	const now = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	return join(dir, `${range}-${stamp}.md`);
}
