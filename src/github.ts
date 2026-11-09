import { CommandError, run } from "./proc";

export type Issue = {
	number: number;
	title: string;
	url: string;
	labels: string[];
	assignees: string[];
	author: string;
	updatedAt: string;
};

export type IssueDetail = {
	body: string;
	comments: { author: string; body: string; createdAt: string }[];
};

const gh = (cwd: string, args: string[]) => run(["gh", ...args], cwd);

/** Parses `gh --json` output; a malformed payload becomes a `CommandError` naming the command. */
function parseJson<T>(out: string, what: string): T {
	try {
		return JSON.parse(out) as T;
	} catch (err) {
		throw new CommandError(`gh ${what}: unparseable JSON (${err instanceof Error ? err.message : String(err)})`);
	}
}

/** Hard cap on `gh issue list`; a hit means issues may be missing and the board must say so. */
export const ISSUE_LIMIT = 500;

export async function repoName(cwd: string): Promise<string> {
	return (await gh(cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
}

export async function listIssues(cwd: string): Promise<Issue[]> {
	const out = await gh(cwd, [
		"issue",
		"list",
		"--state",
		"open",
		"--limit",
		String(ISSUE_LIMIT),
		"--json",
		"number,title,url,labels,assignees,author,updatedAt",
	]);
	type Raw = {
		number: number;
		title: string;
		url: string;
		labels: { name: string }[];
		assignees: { login: string }[];
		author: { login: string } | null;
		updatedAt: string;
	};
	return parseJson<Raw[]>(out, "issue list").map(r => ({
		number: r.number,
		title: r.title,
		url: r.url,
		labels: r.labels.map(l => l.name),
		assignees: r.assignees.map(a => a.login),
		author: r.author?.login ?? "ghost",
		updatedAt: r.updatedAt,
	}));
}

export async function issueDetail(cwd: string, number: number): Promise<IssueDetail> {
	const out = await gh(cwd, ["issue", "view", String(number), "--json", "body,comments"]);
	const raw = parseJson<{
		body: string;
		comments: { author: { login: string } | null; body: string; createdAt: string }[];
	}>(out, `issue view ${number}`);
	return {
		body: raw.body,
		comments: raw.comments.map(c => ({ author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
	};
}

/** Adds `add` (if any) and removes the given labels in one edit. */
export async function relabel(cwd: string, number: number, add: string | null, remove: string[]): Promise<void> {
	const args = ["issue", "edit", String(number)];
	if (add) args.push("--add-label", add);
	if (remove.length) args.push("--remove-label", remove.join(","));
	if (args.length === 3) return;
	await gh(cwd, args);
}

export async function openInBrowser(cwd: string, number: number): Promise<void> {
	await gh(cwd, ["issue", "view", String(number), "--web"]);
}
