// Kanban board of a repo's open GitHub issues, rendered as a full-screen terminal app inside a herdr pane.
// Columns come from labels (config.ts). Right-click or `m` on a card opens actions that hand the ticket to agents.
import { basename, join } from "node:path";
import { type ColumnSpec, type Config, fill, loadConfig, type PlanStage } from "./config";
import { collectDrafts, consentSummary, type Draft } from "./drafts";
import * as gh from "./github";
import * as hd from "./herdr";
import { collectTicketContexts, contextFilePath, orchestrateContext } from "./orchestrate";
import { copyToClipboard, run } from "./proc";
import * as proto from "./prototype";
import { ago, blocksToMarkdown, buildReport, type Block, reportPrompt } from "./report";
import { parseSelectionSpec, rangeLabel } from "./selection";
import { discoverSkills, type Skill } from "./skills";
import * as wb from "./wb";

const repoCwd = process.env.ISSUE_BOARD_CWD ?? process.cwd();
const originPane = process.env.ISSUE_BOARD_ORIGIN_PANE;
const selfPane = process.env.HERDR_PANE_ID;

// ── text helpers ────────────────────────────────────────────────────────────

const width = (s: string) => Bun.stringWidth(s);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Strips escape sequences and control characters from untrusted text (issue titles/bodies). */
function clean(s: string): string {
	return s
		.replace(/\r\n?/g, "\n")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
		.replace(/\t/g, "  ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

function truncate(s: string, w: number): string {
	if (w <= 0) return "";
	if (width(s) <= w) return s;
	let out = "";
	let used = 0;
	for (const ch of s) {
		const cw = width(ch);
		if (used + cw > w - 1) break;
		out += ch;
		used += cw;
	}
	return `${out}…`;
}

const fit = (s: string, w: number) => {
	const t = truncate(s, w);
	return t + " ".repeat(Math.max(0, w - width(t)));
};

function wrap(text: string, w: number): string[] {
	const lines: string[] = [];
	if (w < 2) return [truncate(text, w)];
	for (const para of text.split("\n")) {
		if (para.trim() === "") {
			lines.push("");
			continue;
		}
		let line = "";
		for (let word of para.split(/ +/)) {
			while (width(word) > w) {
				if (line) lines.push(line);
				line = "";
				const chars = [...word];
				let chunk = "";
				let used = 0;
				let i = 0;
				for (; i < chars.length && used + width(chars[i]) <= w; i++) {
					chunk += chars[i];
					used += width(chars[i]);
				}
				if (i === 0) i = 1;
				lines.push(chunk || chars[0]);
				word = chars.slice(i).join("");
			}
			if (!word) continue;
			if (!line) line = word;
			else if (width(line) + 1 + width(word) <= w) line += ` ${word}`;
			else {
				lines.push(line);
				line = word;
			}
		}
		if (line) lines.push(line);
	}
	return lines;
}

// SGR styles that turn themselves off without a full reset, so a surrounding inverse survives.
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const fg = (code: number, s: string) => `\x1b[${code}m${s}\x1b[39m`;
const INV = "\x1b[7m";
const RESET = "\x1b[0m";
const [RED, GREEN, YELLOW, CYAN, MAGENTA] = [31, 32, 33, 36, 35];

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");

// ── state ───────────────────────────────────────────────────────────────────

type Column = { spec: ColumnSpec | null; title: string; issues: gh.Issue[]; scroll: number };
type MenuItem = {
	label: string;
	disabled?: boolean;
	run?: () => unknown;
	submenu?: () => MenuItem[] | Promise<MenuItem[]>;
};
type Menu = { title: string; items: MenuItem[]; index: number; offset: number; x: number; y: number; parent: Menu | null };
type Detail = { issue: gh.Issue; data: gh.IssueDetail | null; error: string | null; scroll: number };
/** `/wb` state: the pool snapshot the read-only view renders, plus its scroll. */
type WbView = {
	tasks: wb.PoolTask[];
	/** Engine key from the repo's `.wb.json`; `?` when unset. */
	engine: string;
	/** Session counts, parallel to `tasks`. */
	counts: number[];
	loading: boolean;
	error: string | null;
	scroll: number;
};
type Rect = { x0: number; y0: number; x1: number; y1: number };

let config: Config;
let repo = "";
let issues: gh.Issue[] = [];
let columns: Column[] = [];
let loaded = false;
let selCol = 0;
let selRow = 0;
let colOffset = 0;
let menu: Menu | null = null;
let detail: Detail | null = null;
let agents: hd.AgentInfo[] = [];
let status: { text: string; color: number | null } = { text: "Loading issues…", color: null };
let busy = false;
/** Multi-selected ticket numbers (survives column moves and reloads). */
let selected = new Set<number>();
let skills: Skill[] = [];
let reportView: { blocks: Block[]; scroll: number; skill?: Skill; issues: gh.Issue[]; repo: string } | null = null;
/** Inline one-line text prompt shown in the status row while active. */
let input: { label: string; buffer: string; apply: (text: string) => void } | null = null;

// ── wb (sandbox manager) read-only surfaces ─────────────────────────────────
// Both degrade silently: when `wbReady` is false, no badge renders, `/wb` leaves the
// palette, and a failed refresh keeps the last-known pool instead of breaking the board.

/** wb surfaces are on: config allows them and a `wb` executable sits on PATH. */
let wbReady = false;
/** Pool snapshot behind the card badges; refreshed on the issue cycle, never awaited by render. */
let wbTasks: wb.PoolTask[] = [];
let wbByIssue = new Map<number, wb.PoolTask>();
/** Open `/wb` pool view (BR-4). */
let wbView: WbView | null = null;
/** BR-14 Review: the task diff rendered in a scrollable, read-only overlay. */
let wbDiffView: { task: string; lines: string[]; scroll: number } | null = null;
/** `/drafts` overlay: to-tickets local drafts with per-draft accept/skip and one consented commit. */
type DraftsView = {
	drafts: Draft[];
	/** Accepted draft paths — every draft starts accepted, `space` toggles. */
	accepted: Set<string>;
	/** Every draft path ever collected — only first-seen paths start accepted, skips stick. */
	seen: Set<string>;
	cursor: number;
	loading: boolean;
	scroll: number;
};
let draftsView: DraftsView | null = null;
/** True while `$EDITOR` owns the terminal (the `e` suspend): render and input stay off until it exits. */
let suspended = false;
/**
 * BR-12 consent context once `/attach` has committed locally: the consent prompt asks about
 * pushing, and `finishAttach` (from the prompt's y/N) publishes via `wb publish` or comments only.
 */
let attachPending: { task: string; branch: string; remoteBranch: string; numbers: number[]; artifacts: proto.Artifact[] } | null =
	null;

// Hit-test tables rebuilt every render (0-based screen cells).
let cardHits: (Rect & { col: number; row: number })[] = [];
let titleHits: (Rect & { col: number })[] = [];
let menuRect: Rect | null = null;
let menuItemRows: { y: number; index: number }[] = [];

const selectedIssue = (): gh.Issue | undefined => columns[selCol]?.issues[selRow];
const columnLabels = () => config.columns.map(c => c.label);

function setStatus(text: string, color: number | null = null) {
	status = { text, color };
	render();
}

function buildColumns() {
	const keep = selectedIssue()?.number;
	const buckets = config.columns.map(() => [] as gh.Issue[]);
	const rest: gh.Issue[] = [];
	for (const issue of issues) {
		const i = config.columns.findIndex(c => issue.labels.includes(c.label));
		(i >= 0 ? buckets[i] : rest).push(issue);
	}
	const scrolls = new Map(columns.map(c => [c.title, c.scroll]));
	columns = [];
	if (rest.length) columns.push({ spec: null, title: "No status", issues: rest, scroll: scrolls.get("No status") ?? 0 });
	config.columns.forEach((spec, i) =>
		columns.push({ spec, title: spec.title, issues: buckets[i], scroll: scrolls.get(spec.title) ?? 0 }),
	);
	if (keep !== undefined) {
		for (let c = 0; c < columns.length; c++) {
			const r = columns[c].issues.findIndex(i => i.number === keep);
			if (r >= 0) {
				selCol = c;
				selRow = r;
				return;
			}
		}
	}
	selCol = clamp(selCol, 0, columns.length - 1);
	selRow = clamp(selRow, 0, Math.max(0, columns[selCol].issues.length - 1));
}

/** Live agents this board started for an issue are named `issue-<n>` or `issue-<n>-<k>`. */
function agentFor(issue: gh.Issue): hd.AgentInfo | undefined {
	const re = new RegExp(`^issue-${issue.number}(-\\d+)?$`);
	return agents.find(a => a.name && re.test(a.name));
}

const statusColor = (s: string) =>
	s === "working" ? YELLOW : s === "blocked" ? RED : s === "idle" || s === "done" ? GREEN : MAGENTA;

// ── layout + render ─────────────────────────────────────────────────────────

const CARD_H = 3;
const GAP = 1;
const MIN_COL_W = 26;
const BODY_TOP = 3;

export type Layout = { W: number; H: number; visible: number; cw: number; bodyH: number; perCol: number };

function layout(): Layout {
	const W = process.stdout.columns ?? 80;
	const H = process.stdout.rows ?? 24;
	const n = Math.max(1, columns.length);
	const visible = clamp(Math.floor((W + 1) / (MIN_COL_W + 1)), 1, n);
	if (selCol < colOffset) colOffset = selCol;
	if (selCol >= colOffset + visible) colOffset = selCol - visible + 1;
	colOffset = clamp(colOffset, 0, n - visible);
	const cw = Math.floor((W - (visible - 1)) / visible);
	const bodyH = Math.max(1, H - BODY_TOP - 1);
	const perCol = Math.max(1, Math.floor((bodyH + GAP) / (CARD_H + GAP)));
	return { W, H, visible, cw, bodyH, perCol };
}

function ensureVisible() {
	const col = columns[selCol];
	if (!col) return;
	const { perCol } = layout();
	if (selRow < col.scroll) col.scroll = selRow;
	if (selRow >= col.scroll + perCol) col.scroll = selRow - perCol + 1;
}

function headerLine(W: number, left: string, right: string): string {
	const room = W - width(left) - 1;
	if (room <= 0) return bold(fit(left, W));
	return bold(left) + " ".repeat(Math.max(1, W - width(left) - width(truncate(right, room)))) + dim(truncate(right, room));
}

function cardLines(issue: gh.Issue, cw: number, cursor: boolean, marked: boolean): string[] {
	const inner = cw - 2;
	const head = `#${issue.number} `;
	const wrapped = wrap(head + clean(issue.title), inner);
	const t1 = wrapped[0] ?? "";
	const t2 = wrapped.length > 2 ? truncate(wrapped.slice(1).join(" "), inner) : (wrapped[1] ?? "");
	const line1 = t1.startsWith(head)
		? fg(CYAN, head) + bold(fit(t1.slice(head.length), inner - width(head)))
		: bold(fit(t1, inner));

	const agent = agentFor(issue);
	const wbTask = wbReady ? wbByIssue.get(issue.number) : undefined;
	const agentBadge = agent ? `◆ ${agent.status} ` : "";
	const wbBadge = wbTask ? (wbTask.dirty ? `▣● ` : `▣ `) : "";
	const badge = `${agentBadge}${wbBadge}`;
	const columnSet = new Set(columnLabels());
	const meta = [
		...issue.assignees.map(a => `@${a}`),
		...issue.labels.filter(l => !columnSet.has(l)),
		ago(issue.updatedAt),
	].join(" · ");
	const badgeStyles = (agent ? fg(statusColor(agent.status), agentBadge) : "") + (wbTask ? fg(YELLOW, wbBadge) : "");
	const line3 = badgeStyles + dim(fit(meta, inner - width(badge)));

	const pre = cursor ? INV : "";
	const mark = marked ? fg(MAGENTA, "▌") : " ";
	return [line1, fit(t2, inner), line3].map(l => `${pre}${mark} ${l}${RESET}`);
}

function renderBoard(L: Layout, rows: string[]) {
	const { W, cw, visible, bodyH, perCol } = L;
	const right = "space select · J/K extend · / slash · ⏎ details · m actions · r refresh · q quit";
	const picked = selected.size ? ` · ${selected.size} selected` : "";
	// "+": the gh issue list is capped at gh.ISSUE_LIMIT, so there may be hidden issues.
	const capped = issues.length === gh.ISSUE_LIMIT;
	rows[0] = headerLine(W, ` ${repo || "…"} · ${issues.length}${capped ? "+" : ""} open${picked}`, right);

	const shown = columns.slice(colOffset, colOffset + visible);
	const sep = dim("│");
	const titleParts: string[] = [];
	const ruleParts: string[] = [];
	const bodies: string[][] = [];
	shown.forEach((col, k) => {
		const ci = colOffset + k;
		const x0 = k * (cw + 1);
		const more = col.issues.length - col.scroll - perCol;
		const arrows = `${col.scroll > 0 ? "▲" : ""}${more > 0 ? "▼" : ""}`;
		const title = fit(` ${col.title} (${col.issues.length}) ${arrows}`, cw);
		titleParts.push(ci === selCol ? bold(fg(CYAN, title)) : bold(title));
		titleHits.push({ x0, x1: x0 + cw - 1, y0: 1, y1: 1, col: ci });
		ruleParts.push(dim("─".repeat(cw)));

		const lines: string[] = [];
		if (!col.issues.length) lines.push(dim(fit(loaded ? "  no issues" : "", cw)));
		for (let k2 = 0; k2 < perCol; k2++) {
			const r = col.scroll + k2;
			const issue = col.issues[r];
			if (!issue) break;
			const y0 = BODY_TOP + lines.length;
			cardHits.push({ x0, x1: x0 + cw - 1, y0, y1: y0 + CARD_H - 1, col: ci, row: r });
			lines.push(...cardLines(issue, cw, ci === selCol && r === selRow, selected.has(issue.number)));
			lines.push(" ".repeat(cw));
		}
		bodies.push(lines);
	});
	rows[1] = titleParts.join(sep);
	rows[2] = ruleParts.join(dim("┼"));
	for (let y = 0; y < bodyH; y++) {
		rows[BODY_TOP + y] = bodies.map(lines => lines[y] ?? " ".repeat(cw)).join(sep);
	}
}

function detailLines(d: Detail, w: number): string[] {
	if (d.error) return [fg(RED, d.error)];
	if (!d.data) return [dim("Loading…")];
	const out = wrap(clean(d.data.body || "(no description)"), w);
	for (const c of d.data.comments) {
		out.push("", fg(CYAN, `── @${c.author} · ${ago(c.createdAt)} ago ──`));
		out.push(...wrap(clean(c.body), w));
	}
	return out;
}

function renderDetail(L: Layout, rows: string[]) {
	const d = detail as Detail;
	const { W, bodyH } = L;
	const right = "esc back · right-click/m actions · o browser · j/k scroll";
	rows[0] = headerLine(W, ` #${d.issue.number} ${clean(d.issue.title)}`, right);
	const meta = [`by @${d.issue.author}`, ...d.issue.assignees.map(a => `@${a}`), ...d.issue.labels, d.issue.url];
	rows[1] = dim(fit(` ${meta.join(" · ")}`, W));
	rows[2] = dim("─".repeat(W));
	const lines = detailLines(d, W - 2);
	d.scroll = clamp(d.scroll, 0, Math.max(0, lines.length - bodyH));
	for (let y = 0; y < bodyH; y++) rows[BODY_TOP + y] = ` ${lines[d.scroll + y] ?? ""}`;
}

function renderMenu(m: Menu, L: Layout): string {
	const labels = m.items.map(it => it.label + (it.submenu ? "  ›" : ""));
	const w = clamp(Math.max(width(m.title) + 6, ...labels.map(l => width(l) + 4)), 10, L.W);
	const h = Math.min(m.items.length, Math.max(1, L.H - 2)) + 2;
	const shown = h - 2;
	if (m.index < m.offset) m.offset = m.index;
	if (m.index >= m.offset + shown) m.offset = m.index - shown + 1;
	m.offset = clamp(m.offset, 0, Math.max(0, m.items.length - shown));
	const x = clamp(m.x, 0, L.W - w);
	const y = clamp(m.y, 0, Math.max(0, L.H - h));
	m.x = x;
	m.y = y;
	menuRect = { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 };
	menuItemRows = [];
	const at = (row: number) => `\x1b[${row + 1};${x + 1}H`;
	const counter = m.items.length > shown ? ` ${m.index + 1}/${m.items.length}` : "";
	const titleText = truncate(` ${m.title}${counter} `, w - 4);
	let out = `${at(y)}${RESET}┌─${bold(titleText)}${"─".repeat(Math.max(0, w - 3 - width(titleText)))}┐`;
	for (let i = 0; i < shown; i++) {
		const index = m.offset + i;
		const item = m.items[index];
		if (!item) break;
		const text = fit(` ${labels[index]}`, w - 2);
		const styled = item.disabled ? dim(text) : index === m.index ? `${INV}${text}${RESET}` : text;
		out += `${at(y + 1 + i)}${RESET}│${styled}│`;
		menuItemRows.push({ y: y + 1 + i, index });
	}
	out += `${at(y + h - 1)}${RESET}└${"─".repeat(w - 2)}┘`;
	return out;
}

function render() {
	if (suspended || !process.stdout.isTTY) return;
	const L = layout();
	const rows: string[] = new Array(L.H).fill("");
	cardHits = [];
	titleHits = [];
	menuRect = null;
	menuItemRows = [];
	if (reportView) renderReport(L, rows);
	else if (wbView) renderWbView(L, rows);
	else if (wbDiffView) renderWbDiff(L, rows);
	else if (draftsView) renderDrafts(L, rows);
	else if (detail) renderDetail(L, rows);
	else renderBoard(L, rows);
	if (input) {
		rows[L.H - 1] = fg(CYAN, fit(` ${input.label} ${input.buffer}▌`, L.W));
	} else {
		const spin = busy ? "⠿ " : "";
		const text = fit(` ${spin}${status.text}`, L.W);
		rows[L.H - 1] = status.color ? fg(status.color, text) : dim(text);
	}

	let frame = "\x1b[?2026h";
	rows.forEach((row, i) => {
		// Clear first: EL after a full-width row would erase its last cell (pending-wrap state).
		frame += `\x1b[${i + 1};1H${RESET}\x1b[2K${row}${RESET}`;
	});
	if (menu) frame += renderMenu(menu, L);
	frame += "\x1b[?2026l";
	process.stdout.write(frame);
}

// ── actions ─────────────────────────────────────────────────────────────────

/** Runs one async operation with status-line feedback; ignores new work while one is running. */
async function act(label: string, fn: () => Promise<string | undefined>) {
	if (busy) return setStatus("Busy, wait for the current action to finish", YELLOW);
	busy = true;
	setStatus(`${label}…`);
	try {
		const done = await fn();
		busy = false;
		setStatus(done ?? `${label}: done`, GREEN);
	} catch (err) {
		busy = false;
		setStatus(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, RED);
	}
}

async function loadIssues(quiet = false) {
	const fetch = async () => {
		[repo, issues] = await Promise.all([repo ? repo : gh.repoName(repoCwd), gh.listIssues(repoCwd)]);
		loaded = true;
		buildColumns();
		pruneSelection();
		ensureVisible();
		const capped = issues.length === gh.ISSUE_LIMIT ? ` · showing first ${gh.ISSUE_LIMIT} issues` : "";
		return `${issues.length} open issues${capped} · ${new Date().toLocaleTimeString()}`;
	};
	if (quiet) {
		try {
			await fetch();
			render();
		} catch (err) {
			// A background refresh must never tear the board down; it says so in the status line instead.
			setStatus(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`, YELLOW);
		}
		return;
	}
	await act("Loading issues", fetch);
}

async function refreshAgents() {
	try {
		agents = await hd.listAgents();
		render();
	} catch (err) {
		// Best-effort badge data: name the failure, keep the board rendering.
		setStatus(`Agent list unavailable: ${err instanceof Error ? err.message : String(err)}`, YELLOW);
	}
}

/** Discovers the global skills the `/` palette offers; config `skillDirs` replaces the defaults. */
async function loadSkills() {
	try {
		skills = await discoverSkills({ dirs: config.skillDirs, repoCwd });
		render();
	} catch (err) {
		// Skill discovery is optional; an unreadable dir must not hide why `/` is empty.
		setStatus(`Skill scan failed: ${err instanceof Error ? err.message : String(err)}`, YELLOW);
	}
}

/** Stores a fresh pool snapshot; badges use the same task preference as the menus. */
function applyWbPool(tasks: wb.PoolTask[]) {
	wbTasks = tasks;
	const map = new Map<number, wb.PoolTask>();
	for (const n of new Set(tasks.flatMap(t => t.issues))) {
		const t = wb.taskForIssue(tasks, n);
		if (t) map.set(n, t);
	}
	wbByIssue = map;
}

/** Reloads the wb pool behind the card badges; failures keep the last-known snapshot. */
async function refreshWb() {
	if (!wbReady) return;
	try {
		applyWbPool(await wb.loadPool(repoCwd));
	} catch {}
	render();
}

/**
 * Launcher in effect for board actions (BR-10): config `wb.launcher` resolves against the enabled
 * flag and the PATH probe — a configured wb launcher with wb missing falls back to herdr with a
 * one-line notice instead of failing mid-selection.
 */
function launcher(): { wb: boolean; notice: string | null } {
	return wb.resolveLauncher(config.wb.launcher, config.wb.enabled, wb.wbAvailable());
}

/** Agent names must be unique among live agents: `base`, then `base-2`, `base-3`, … */
function uniqueName(base: string): string {
	const taken = new Set(agents.map(a => a.name));
	if (!taken.has(base)) return base;
	for (let k = 2; ; k++) if (!taken.has(`${base}-${k}`)) return `${base}-${k}`;
}

function promptFor(kind: "implement" | "refine", issue: gh.Issue, branch = "") {
	return fill(config.prompts[kind], { number: issue.number, title: issue.title, repo, url: issue.url, branch });
}

/** Starts a named agent in `pane`, sends the prompt, and jumps to it. */
async function launchNamed(base: string, pane: string, prompt: string, where = `in ${pane}`): Promise<string> {
	agents = await hd.listAgents();
	const name = uniqueName(base);
	await hd.startAgent(name, config.agent, pane);
	await hd.promptAgent(name, prompt);
	await refreshAgents();
	await hd.focusAgent(name);
	return `Started ${name} (${config.agent}) ${where}`;
}

const launch = (issue: gh.Issue, pane: string, prompt: string) => launchNamed(`issue-${issue.number}`, pane, prompt);

/**
 * `Enter→Implement` (the `i` key): under the wb launcher a sandboxed wb task starts on the BR-2
 * task id and wb opens the workspace pane itself; herdr keeps the pre-bridge flow (BR-11), with
 * a one-line notice when launcher "wb" fell back because wb is unavailable.
 */
function implementInWorktree(issue: gh.Issue) {
	const l = launcher();
	if (!l.wb) return implementInWorktreeHerdr(issue, l.notice);
	return act(`Starting wb task for #${issue.number}`, async () => {
		const task = wb.taskIdForIssue(issue.number);
		const mode = (await wb.wbRepoConfig(repoCwd)).mode === "serial" ? ("serial" as const) : ("tree" as const);
		const branch = wb.localBranchFor(task, mode);
		const prompt = `${promptFor("implement", issue, branch)} You are in a fresh git worktree on branch \`${branch}\`.`;
		await wb.wbStart(task, repoCwd, config.wb.agent, prompt);
		void refreshWb();
		return `Started wb task ${task} (${config.wb.agent})`;
	});
}

function implementInWorktreeHerdr(issue: gh.Issue, notice: string | null) {
	return act(`Creating worktree for #${issue.number}${notice ? ` — ${notice}` : ""}`, async () => {
		const branch = `issue/${issue.number}-${slug(issue.title)}`;
		const pane = await hd.createWorktree(repoCwd, branch, `#${issue.number} ${truncate(issue.title, 24)}`);
		const prompt = `${promptFor("implement", issue, branch)} You are in a fresh git worktree on branch \`${branch}\`.`;
		return launch(issue, pane, prompt);
	});
}

function launchInSplit(issue: gh.Issue, kind: "implement" | "refine") {
	return act(`Starting agent for #${issue.number}`, async () => {
		if (!originPane) throw new Error("no origin pane to split (open the board via its action)");
		const pane = await hd.splitPane(originPane, repoCwd);
		return launch(issue, pane, promptFor(kind, issue));
	});
}

function sendToAgent(issue: gh.Issue, agent: hd.AgentInfo) {
	return act(`Sending #${issue.number} to ${agent.target}`, async () => {
		await hd.promptAgent(agent.target, promptFor("implement", issue));
		return `Sent #${issue.number} to ${agent.target}`;
	});
}

function moveTo(issue: gh.Issue, target: ColumnSpec | null) {
	return act(`Moving #${issue.number}`, async () => {
		const remove = issue.labels.filter(l => columnLabels().includes(l) && l !== target?.label);
		await gh.relabel(repoCwd, issue.number, target && !issue.labels.includes(target.label) ? target.label : null, remove);
		issue.labels = [...issue.labels.filter(l => !remove.includes(l)), ...(target ? [target.label] : [])];
		buildColumns();
		ensureVisible();
		void loadIssues(true);
		return `Moved #${issue.number} to ${target?.title ?? "No status"}`;
	});
}

function openDetail(issue: gh.Issue) {
	const d: Detail = { issue, data: null, error: null, scroll: 0 };
	detail = d;
	menu = null;
	render();
	gh.issueDetail(repoCwd, issue.number).then(
		data => {
			d.data = data;
			render();
		},
		err => {
			d.error = err instanceof Error ? err.message : String(err);
			render();
		},
	);
}

function openBrowser(issue: gh.Issue) {
	return act(`Opening #${issue.number}`, async () => {
		await gh.openInBrowser(repoCwd, issue.number);
		return `Opened ${issue.url}`;
	});
}

/**
 * The wb task a card's action menu maps to (BR-14): only under the wb launcher, and only when the
 * ticket maps onto a pool task (BR-2) — the herdr launcher hides Review/Finish entirely.
 */
function wbMenuTask(issue: gh.Issue): wb.PoolTask | undefined {
	if (!launcher().wb) return undefined;
	return wb.taskForIssue(wbTasks, issue.number);
}

/**
 * The wb pool task behind a card's badge — the same mapping the badge renders (wb enabled +
 * on PATH + issue→worktree), never launcher-gated: the open-task action rides the badge path.
 */
function wbBadgeTask(issue: gh.Issue): wb.PoolTask | undefined {
	return wbReady ? wbByIssue.get(issue.number) : undefined;
}

/** BR-14 Review: the task's diff in a scrollable, read-only overlay (`wb diff`, the report-view precedent). */
function reviewWbTask(t: wb.PoolTask) {
	return act(`Diffing wb task ${t.task}`, async () => {
		const out = await wb.wbDiff(t.task, repoCwd);
		wbDiffView = { task: t.task, lines: clean(out).split("\n"), scroll: 0 };
		return `wb diff ${t.task} — read-only`;
	});
}

/** BR-14 Finish chooser: the local lifeclose action; the confirm then names consequence and parent. */
function openFinishMenu(t: wb.PoolTask) {
	const items: MenuItem[] = [
		{ label: "merge · merge the task branch into its parent locally", run: () => confirmFinishWb(t, "merge") },
		{ label: "squash · fold the task into one commit on its parent", run: () => confirmFinishWb(t, "squash") },
		{ label: "kill · discard the task branch and its worktree", run: () => confirmFinishWb(t, "kill") },
	];
	const x = menuRect ? menuRect.x1 + 1 : 2;
	menu = { title: `Finish ${t.task}`, items, index: 0, offset: 0, x, y: menuRect ? menuRect.y0 : BODY_TOP, parent: null };
	render();
}

/** The repo root's checked-out branch — the parent a wb task branched from (task confirms name it). */
async function headBranch(): Promise<string> {
	try {
		return (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repoCwd)).trim() || "parent branch";
	} catch {
		return "parent branch";
	}
}

/**
 * Explicit finish confirm (BR-14): names the action's consequence and the target/parent branch;
 * only a `y` answer runs the local-only `wb finish` — anything else leaves everything untouched.
 */
async function confirmFinishWb(t: wb.PoolTask, action: wb.WbFinishAction) {
	const parent = await headBranch();
	const consequence =
		action === "kill" ? `changes on ${t.branch} discarded, worktree deleted` : `${t.branch} merged into ${parent} locally, worktree deleted`;
	input = {
		label: `Finish ${t.task} — ${action}: ${consequence}. [y/N]`,
		buffer: "",
		apply: text => {
			if (wb.consentAnswer(text)) void finishWbTask(t, action);
			else setStatus(`Finish of ${t.task} cancelled — nothing changed`, YELLOW);
		},
	};
	render();
}

/** The consented lifeclose: local merge/teardown via `wb finish --json`; the BR-9 result lands in the notice line. */
function finishWbTask(t: wb.PoolTask, action: wb.WbFinishAction) {
	return act(`Finishing ${t.task} (${action})`, async () => {
		const result = await wb.wbFinish(t.task, repoCwd, action);
		await refreshWb();
		if (!result) return `Finished ${t.task} (${action})`;
		return action === "kill"
			? `Killed ${t.task} — ${result.branch} discarded, worktree deleted`
			: `Finished ${t.task}: ${(result.sha ?? "").slice(0, 7)} on ${result.parent} (branch ${result.branch}, worktree deleted)`;
	});
}

/**
 * Card action: open the task's pool worktree with its agent-session tabs in the workbench
 * herdr session (`wb up`, non-interactive). A down session boots first — a `wb-session` split
 * pane runs `herdr session attach workbench` in the pane's own TTY, then a bounded wait polls
 * the session server up before `wb up` runs (it no-ops silently while the session is down).
 * Serial pools open the shared `serial` worktree, where serial-task sessions live.
 */
function openInWorkbenchSession(t: wb.PoolTask) {
	const target = wb.wbUpTarget(t);
	return act(`Opening ${t.task} in the workbench session`, async () => {
		let booted = false;
		if (!(await hd.sessionServerRunning("workbench"))) {
			if (!originPane) throw new Error("no origin pane to split (open the board via its action)");
			setStatus("Workbench session down — booting it in a wb-session split pane…");
			const pane = await hd.splitPane(originPane, repoCwd);
			await hd.renamePane(pane, "wb-session").catch(() => {});
			await hd.runHerdrInPane(pane, ["session", "attach", "workbench"]);
			booted = true;
			// Bounded heads-up for the boot: poll the session server a few seconds, never hard-block.
			for (let waited = 0; waited < 8_000 && !(await hd.sessionServerRunning("workbench")); waited += 500)
				await new Promise(resolve => setTimeout(resolve, 500));
		}
		setStatus(`Running wb up ${target}…`);
		const { out, err } = await wb.wbUp(target, repoCwd);
		return wb.wbUpNotice({ out, err }, target, basename(repoCwd), booted);
	});
}

function issueMenu(issue: gh.Issue): MenuItem[] {
	const wbTask = wbMenuTask(issue);
	const wbOpen = wbBadgeTask(issue);
	return [
		{ label: "Implement in new worktree", run: () => implementInWorktree(issue) },
		{ label: "Implement in split pane", run: () => launchInSplit(issue, "implement") },
		{ label: "Refine ticket with agent", run: () => launchInSplit(issue, "refine") },
		{ label: "Slash", submenu: () => slashItems() },
		...(wbOpen
			? [{ label: `Open task in workbench session · wb up ${wb.wbUpTarget(wbOpen)}`, run: () => openInWorkbenchSession(wbOpen) }]
			: []),
		...(wbTask
			? [
					{ label: `Review · wb diff ${wbTask.task} (read-only)`, run: () => reviewWbTask(wbTask) },
					{ label: `Finish · merge, squash or kill ${wbTask.task} locally`, run: () => openFinishMenu(wbTask) },
				]
			: []),
		{
			label: "Send to running agent",
			submenu: async () => {
				const live = await hd.listAgents();
				if (!live.length) return [{ label: "No running agents", disabled: true }];
				live.sort((a, b) => Number(b.cwd.startsWith(repoCwd)) - Number(a.cwd.startsWith(repoCwd)));
				return live.map(a => ({
					label: `${a.target} · ${a.kind} · ${a.status}${a.title ? ` · ${truncate(a.title, 36)}` : ""}`,
					disabled: a.status === "blocked",
					run: () => sendToAgent(issue, a),
				}));
			},
		},
		{
			label: "Move to",
			submenu: () =>
				[null, ...config.columns].map(spec => ({
					label: spec?.title ?? "No status",
					disabled: (spec ? issue.labels.includes(spec.label) : !issue.labels.some(l => columnLabels().includes(l))),
					run: () => moveTo(issue, spec),
				})),
		},
		{ label: "View details", run: () => openDetail(issue) },
		{ label: "Open in browser", run: () => openBrowser(issue) },
	];
}

function firstEnabled(items: MenuItem[], from = 0, step = 1): number {
	for (let k = 0; k < items.length; k++) {
		const i = (((from + k * step) % items.length) + items.length) % items.length;
		if (!items[i].disabled) return i;
	}
	return 0;
}

function openMenu(issue: gh.Issue, x: number, y: number) {
	const items = issueMenu(issue);
	menu = { title: `#${issue.number}`, items, index: firstEnabled(items), offset: 0, x, y, parent: null };
	render();
}

/** Keyboard-opened menus anchor beside the selected card (or near the top in detail view). */
function openMenuAtSelection() {
	const issue = detail?.issue ?? selectedIssue();
	if (!issue) return;
	const hit = cardHits.find(h => h.col === selCol && h.row === selRow);
	openMenu(issue, hit ? hit.x0 + 4 : 2, hit ? hit.y0 + 1 : BODY_TOP);
}

async function activate(m: Menu, index: number) {
	const item = m.items[index];
	if (!item || item.disabled) return;
	if (item.submenu) {
		const items = await item.submenu();
		const w = menuRect ? menuRect.x1 - menuRect.x0 + 1 : 0;
		menu = { title: item.label, items, index: firstEnabled(items), offset: 0, x: m.x + w - 2, y: m.y + index + 1, parent: m };
		return render();
	}
	menu = null;
	render();
	await item.run?.();
}

// ── multi-select ────────────────────────────────────────────────────────────

const flatIssues = () => columns.flatMap(c => c.issues);

/** The tickets an action covers: the multi-selection, or (when allowed) every open ticket. */
function pickedIssues(allowAll: boolean): gh.Issue[] {
	const all = flatIssues();
	const picks = selected.size ? all.filter(i => selected.has(i.number)) : allowAll ? all : [];
	return [...picks].sort((a, b) => a.number - b.number);
}

function setSelection(numbers: Iterable<number>, note?: string) {
	selected = new Set(numbers);
	setStatus(note ?? (selected.size ? `${selected.size} selected · / for slash commands` : "selection cleared"));
}

/** Drops selected numbers that are no longer open (called after every reload). */
function pruneSelection() {
	if (!selected.size) return;
	const open = new Set(issues.map(i => i.number));
	const next = new Set([...selected].filter(n => open.has(n)));
	if (next.size !== selected.size) selected = next;
}

function toggleSelect(issue: gh.Issue) {
	const next = new Set(selected);
	if (next.has(issue.number)) next.delete(issue.number);
	else next.add(issue.number);
	setSelection(next);
}

/** Grows the selection one card at a time through the flattened board order. */
function extendSelection(dir: 1 | -1) {
	const flat = flatIssues();
	if (!flat.length) return;
	const indexOf = (n: number) => flat.findIndex(i => i.number === n);
	const edge = selected.size ? (dir === 1 ? Math.max(...[...selected].map(indexOf)) : Math.min(...[...selected].map(indexOf))) : indexOf(selectedIssue()?.number ?? -1);
	const target = clamp((edge < 0 ? indexOf(selectedIssue()?.number ?? -1) : edge) + dir, 0, flat.length - 1);
	const issue = flat[target];
	selCol = columns.findIndex(c => c.issues.includes(issue));
	selRow = columns[selCol].issues.indexOf(issue);
	ensureVisible();
	const next = new Set(selected);
	next.add(issue.number);
	setSelection(next);
}

/** Toggles every card in the focused column. */
function selectColumn() {
	const col = columns[selCol];
	if (!col) return;
	const next = new Set(selected);
	const all = col.issues.length > 0 && col.issues.every(i => next.has(i.number));
	for (const i of col.issues) {
		if (all) next.delete(i.number);
		else next.add(i.number);
	}
	setSelection(next, `${next.size} selected`);
}

function openSelectPrompt() {
	input = {
		label: "#183-192, 183,185, label:bug, @user, all, none ─",
		buffer: "",
		apply: text => {
			const { numbers, note } = parseSelectionSpec(text, flatIssues());
			setSelection(numbers, note);
		},
	};
	render();
}

// ── slash commands: local report, then global skills ────────────────────────

function slashItems(): MenuItem[] {
	return [
		{ label: "/report · local summary of the selection", run: () => openReport(undefined) },
		{ label: "/select · pick tickets by range, label or assignee", run: () => openSelectPrompt() },
		{ label: "/attach · post prototype screenshots on the tickets", run: () => attachPrototype() },
		...(config.plan.enabled
			? [
					{ label: "/plan · start the planning loop at any stage", run: () => openPlanMenu() },
					{ label: "/drafts · review agent-drafted tickets", run: () => openDraftsView() },
				]
			: []),
		...(config.orchestrate.enabled
			? [{ label: "/orchestrate · run a sprint over the selection", run: () => orchestrateSelection() }]
			: []),
		...(wbReady ? [{ label: "/wb · read-only overview of the wb pool", run: () => openWbView() }] : []),
		{ label: `${skills.length} global skills`, disabled: true },
		...skills.map(s => ({
			label: `/${s.name}${s.description ? ` · ${truncate(s.description, 44)}` : ""}`,
			run: () => runSkill(s),
		})),
	];
}

function openSlashPalette(x = 2, y = BODY_TOP) {
	const items = slashItems();
	menu = { title: "/slash", items, index: firstEnabled(items), offset: 0, x, y, parent: null };
	render();
}

function openReport(skill?: Skill) {
	const picks = pickedIssues(true);
	reportView = {
		blocks: buildReport({ repo, issues: picks, total: issues.length, columns: config.columns, skill }),
		scroll: 0,
		skill,
		issues: picks,
		repo,
	};
	menu = null;
	render();
	if (!selected.size) setStatus(`Nothing selected — reporting all ${picks.length} open tickets`, null);
}

function reportLines(blocks: Block[], w: number): string[] {
	const out: string[] = [];
	for (const b of blocks) {
		switch (b.kind) {
			case "title":
				out.push(...wrap(b.text, w).map(bold));
				break;
			case "meta":
				out.push(...wrap(b.text, w).map(dim));
				break;
			case "rule":
				out.push(dim("─".repeat(Math.max(1, w))));
				break;
			case "heading":
				if (out.length) out.push("");
				out.push(bold(fg(CYAN, b.text)));
				break;
			case "kv": {
				const lines = wrap(`${b.key}: ${b.value}`, w);
				out.push(...lines.map((l, i) => (i === 0 ? bold(`${b.key}:`) + l.slice(b.key.length + 1) : l)));
				break;
			}
			case "ticket":
				out.push(...wrap(b.text, w).map(bold));
				out.push(...wrap(b.meta, w).map(dim));
				break;
			case "text":
				out.push(...wrap(b.text, w));
				break;
		}
	}
	return out;
}

function renderReport(L: Layout, rows: string[]) {
	const r = reportView as NonNullable<typeof reportView>;
	const { W, bodyH } = L;
	const right = "/ switch skill · e export · y copy · a agent · esc back";
	rows[0] = headerLine(W, ` ${r.skill ? `Report · /${r.skill.name}` : "Report · quick summary"} · ${r.issues.length} tickets`, right);
	rows[1] = dim(fit(` ${r.repo} · ${r.issues.map(i => `#${i.number}`).join(" ")}`, W));
	rows[2] = dim("─".repeat(W));
	const lines = reportLines(r.blocks, W - 2);
	r.scroll = clamp(r.scroll, 0, Math.max(0, lines.length - bodyH));
	for (let y = 0; y < bodyH; y++) rows[BODY_TOP + y] = ` ${lines[r.scroll + y] ?? ""}`;
}

function exportReport() {
	const r = reportView;
	if (!r) return;
	return act("Exporting report", async () => {
		const file = join(repoCwd, `issue-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
		await Bun.write(file, blocksToMarkdown(r.blocks));
		return `Wrote ${file}`;
	});
}

function copyReport() {
	const r = reportView;
	if (!r) return;
	return act("Copying report", async () => {
		await copyToClipboard(blocksToMarkdown(r.blocks));
		return `Copied ${r.issues.length} tickets to the clipboard`;
	});
}

/** `a` in the report view: hand the report prompt to a new or running agent. */
function openReportAgentMenu() {
	const r = reportView;
	if (!r) return;
	const text = reportPrompt(r.repo, r.issues, r.skill);
	const items: MenuItem[] = [
		{ label: "New agent in split pane", run: () => reportInSplit(text) },
		{
			label: "Send to running agent",
			submenu: async () => {
				const live = await hd.listAgents();
				if (!live.length) return [{ label: "No running agents", disabled: true }];
				live.sort((a, b) => Number(b.cwd.startsWith(repoCwd)) - Number(a.cwd.startsWith(repoCwd)));
				return live.map(a => ({
					label: `${a.target} · ${a.kind} · ${a.status}${a.title ? ` · ${truncate(a.title, 36)}` : ""}`,
					disabled: a.status === "blocked",
					run: () =>
						act(`Sending report to ${a.target}`, async () => {
							await hd.promptAgent(a.target, text);
							return `Sent the report prompt to ${a.target}`;
						}),
				}));
			},
		},
	];
	menu = { title: "Send report", items, index: 0, offset: 0, x: 2, y: BODY_TOP, parent: null };
	render();
}

function reportInSplit(text: string) {
	return act("Starting agent for the report", async () => {
		if (!originPane) throw new Error("no origin pane to split (open the board via its action)");
		const pane = await hd.splitPane(originPane, repoCwd);
		return launchNamed("issue-report", pane, text);
	});
}

// ── /wb: read-only pool view ────────────────────────────────────────────────

/** `/wb`: a report-style, read-only look at the focused repo's wb pool. */
function openWbView() {
	wbView = { tasks: wbTasks, engine: "?", counts: wbTasks.map(() => 0), loading: true, error: null, scroll: 0 };
	menu = null;
	render();
	void loadWbView();
}

/** Fills the `/wb` view: pool tasks, `.wb.json` engine, per-task session counts. */
async function loadWbView() {
	const v = wbView;
	if (!v) return;
	v.loading = true;
	render();
	try {
		const [tasks, sessions, cfg] = await Promise.all([wb.loadPool(repoCwd), wb.wbSessions(), wb.wbRepoConfig(repoCwd)]);
		applyWbPool(tasks);
		v.tasks = tasks;
		v.counts = tasks.map(t => wb.sessionsForTask(sessions, t, basename(repoCwd)));
		v.engine = cfg.engine ?? "?";
		v.error = null;
	} catch (err) {
		v.error = err instanceof Error ? err.message : String(err);
	}
	v.loading = false;
	render();
}

/** Body lines of the `/wb` view; empty pool degrades to a one-line note. */
function wbViewLines(v: WbView, w: number): string[] {
	if (v.error) return [fg(RED, v.error)];
	if (v.loading) return [dim("Loading…")];
	if (!v.tasks.length) return [dim("wb not found / repo not in the wb pool")];
	const out: string[] = [];
	v.tasks.forEach((t, i) => {
		out.push(...wrap(clean(t.task), w).map(bold));
		const meta = [
			t.branch,
			`engine ${v.engine}`,
			`${v.counts[i]} session${v.counts[i] === 1 ? "" : "s"}`,
			...(t.dirty ? ["● dirty"] : []),
		].join(" · ");
		out.push(...wrap(clean(meta), w).map(dim));
	});
	const next = v.tasks[0].task;
	out.push("", ...wrap(`next: wb diff ${next} · wb finish ${next} (host commands — the board never runs them)`, w).map(dim));
	return out;
}

function renderWbView(L: Layout, rows: string[]) {
	const v = wbView as WbView;
	const { W, bodyH } = L;
	const right = "r reload · j/k scroll · esc back";
	rows[0] = headerLine(W, ` wb pool · ${v.tasks.length} task${v.tasks.length === 1 ? "" : "s"}`, right);
	rows[1] = dim(fit(` ${repo || "…"} · engine ${v.engine} · read-only`, W));
	rows[2] = dim("─".repeat(W));
	const lines = wbViewLines(v, W - 2);
	v.scroll = clamp(v.scroll, 0, Math.max(0, lines.length - bodyH));
	for (let y = 0; y < bodyH; y++) rows[BODY_TOP + y] = ` ${lines[v.scroll + y] ?? ""}`;
}

/** BR-14 Review overlay: `wb diff` output, one line per screen row, strictly read-only. */
function renderWbDiff(L: Layout, rows: string[]) {
	const v = wbDiffView as NonNullable<typeof wbDiffView>;
	const { W, bodyH } = L;
	rows[0] = headerLine(W, ` wb diff · ${v.task}`, "read-only · j/k scroll · esc back");
	rows[1] = dim(fit(` ${repo || "…"} · worktree diff against the parent branch`, W));
	rows[2] = dim("─".repeat(W));
	v.scroll = clamp(v.scroll, 0, Math.max(0, v.lines.length - bodyH));
	for (let y = 0; y < bodyH; y++) rows[BODY_TOP + y] = ` ${truncate(v.lines[v.scroll + y] ?? "", W - 2)}`;
}

// ── /plan + /drafts + /orchestrate: planning loop, drafts review, sprint launch ─

/** `/plan`: the config stage table as a submenu — one stage, one prompt-with-context launch. */
function openPlanMenu() {
	const items: MenuItem[] = config.plan.stages.map(stage => ({
		label: `${stage.name}${stage.description ? ` · ${truncate(stage.description, 44)}` : ""}`,
		run: () => promptPlanIdea(stage),
	}));
	menu = { title: "/plan stages", items, index: firstEnabled(items), offset: 0, x: 2, y: BODY_TOP, parent: null };
	render();
}

/** The stage's inline idea prompt — empty allowed when the selection carries the context. */
function promptPlanIdea(stage: PlanStage) {
	input = {
		label: "idea or instruction —",
		buffer: "",
		apply: text => void launchPlanStage(stage, text),
	};
	render();
}

/**
 * One `/plan` launch = one stage: a conversational HOST agent in a split pane (no worktree, no
 * sandbox — the `reportInSplit` precedent) carrying the stage prompt, the idea and the selection.
 * The board never chains stages; adapting course = steering the agent or picking another stage.
 */
function launchPlanStage(stage: PlanStage, idea: string) {
	const picks = pickedIssues(false);
	if (!idea.trim() && !picks.length) return setStatus("Type an idea or select tickets first", YELLOW);
	return act(`Starting plan · ${stage.name}`, async () => {
		if (!originPane) throw new Error("no origin pane to split (open the board via its action)");
		const skill = stage.skill ? skills.find(s => s.name === stage.skill) : undefined;
		const prompt = fill(stage.prompt, {
			idea,
			repo,
			selection: picks.map(i => `#${i.number} ${i.title}`).join("\n"),
			skillPath: skill?.path ?? "",
		});
		const pane = await hd.splitPane(originPane, repoCwd);
		const started = await launchNamed(`plan-${slug(stage.name)}`, pane, prompt);
		return `${started} — drafts land under .scratch/<slug>/issues/ — /drafts to review`;
	});
}

/** `/drafts`: collect on open (`r` re-collects); every draft starts accepted. */
function openDraftsView() {
	draftsView = { drafts: [], accepted: new Set(), seen: new Set(), cursor: 0, loading: true, scroll: 0 };
	menu = null;
	render();
	void reloadDrafts();
}

/** Re-collects the drafts, keeping existing accept/skip choices; only first-seen paths start accepted. */
async function reloadDrafts() {
	const v = draftsView;
	if (!v) return;
	v.loading = true;
	render();
	v.drafts = await collectDrafts(repoCwd);
	for (const d of v.drafts) {
		if (v.seen.has(d.path)) continue; // an explicitly skipped draft is never re-accepted
		v.seen.add(d.path);
		v.accepted.add(d.path);
	}
	v.cursor = clamp(v.cursor, 0, Math.max(0, v.drafts.length - 1));
	v.loading = false;
	render();
}

/** Body lines of the `/drafts` overlay; no drafts degrade to a one-line note. */
function draftsViewLines(v: DraftsView, w: number): string[] {
	if (v.loading) return [dim("Collecting drafts…")];
	if (!v.drafts.length) return [dim("no drafts under .scratch/<cluster>/issues/ — run /plan, then r")];
	const out: string[] = [];
	v.drafts.forEach((d, i) => {
		const mark = v.accepted.has(d.path) ? "✓" : "·";
		const id = d.kind === "ticket" ? `#${String(d.nn).padStart(2, "0")} ${d.slug}` : `rephrase #${d.issue}`;
		const pre = i === v.cursor ? INV : "";
		out.push(`${pre}${mark} ${bold(fit(clean(id), w - 2))}${RESET}`);
		const meta = [...(d.kind === "ticket" ? [clean(d.title)] : []), `cluster ${clean(d.cluster)}`].join(" · ");
		out.push(`${pre}${dim(fit(`  ${meta}`, w))}${RESET}`);
	});
	return out;
}

function renderDrafts(L: Layout, rows: string[]) {
	const v = draftsView as DraftsView;
	const { W, bodyH } = L;
	v.cursor = clamp(v.cursor, 0, Math.max(0, v.drafts.length - 1));
	const right = "space accept · e edit · c create/update · r reload · j/k move · esc back";
	rows[0] = headerLine(W, ` drafts · ${v.drafts.length} draft${v.drafts.length === 1 ? "" : "s"}`, right);
	const cur = v.drafts[v.cursor];
	rows[1] = dim(fit(` ${repo || "…"}${cur ? ` · ${clean(cur.path)}` : ""}`, W));
	rows[2] = dim("─".repeat(W));
	const lines = draftsViewLines(v, W - 2);
	const top = v.cursor * 2;
	if (top < v.scroll) v.scroll = top;
	if (top + 2 > v.scroll + bodyH) v.scroll = top + 2 - bodyH;
	v.scroll = clamp(v.scroll, 0, Math.max(0, lines.length - bodyH));
	for (let y = 0; y < bodyH; y++) rows[BODY_TOP + y] = ` ${lines[v.scroll + y] ?? ""}`;
}

/** `space`: toggle the cursor row's accept/skip (drafts are identified by their path). */
function toggleDraftAccept() {
	const v = draftsView;
	const d = v?.drafts[v.cursor];
	if (!v || !d) return;
	if (v.accepted.has(d.path)) v.accepted.delete(d.path);
	else v.accepted.add(d.path);
}

/**
 * `e`: the `$EDITOR` suspend dance — leave the alt screen and raw mode, run the editor with
 * inherited stdio on the draft file, then restore the board and re-collect (the file may have
 * changed). No `$EDITOR` → the path lands on the clipboard with a notice.
 */
async function editDraftFile() {
	const v = draftsView;
	const d = v?.drafts[v.cursor];
	if (!v || !d) return;
	const file = join(repoCwd, d.path);
	const editor = process.env.EDITOR;
	if (!editor) {
		try {
			await copyToClipboard(file);
			setStatus(`No $EDITOR — copied the draft path: ${file}`, YELLOW);
		} catch {
			setStatus(`No $EDITOR — draft file: ${file}`, YELLOW);
		}
		return;
	}
	suspended = true;
	process.stdin.pause();
	process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	try {
		const proc = Bun.spawn([...editor.split(/\s+/).filter(Boolean), file], {
			cwd: repoCwd,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		await proc.exited;
	} catch {
		// the restore below is the important part — the notice slot shows nothing was edited
	}
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J");
	suspended = false;
	await reloadDrafts();
}

/**
 * `c` in the overlay: the single y/N consent (the BR-12 precedent) in front of every GitHub
 * mutation this feature makes — yes runs the create/edit commit, anything else keeps the drafts.
 */
function openDraftsConsent() {
	const v = draftsView;
	if (!v) return;
	if (!v.drafts.some(d => v.accepted.has(d.path))) return setStatus("No drafts accepted — space toggles a draft", YELLOW);
	input = {
		label: `${consentSummary(v.drafts, v.accepted)} on ${repo}? [y/N]`,
		buffer: "",
		apply: text => {
			if (wb.consentAnswer(text)) void commitDrafts();
			else setStatus("nothing created — drafts kept", YELLOW);
		},
	};
	render();
}

/**
 * The consented commit — the board's only `createIssue`/`editIssueBody` call site. Tickets are
 * created in `nn` order (blockers get lower numbers) with the column + cluster labels filtered by
 * the read-only `listLabels` preflight (missing labels are skipped and named, never created);
 * rephrase drafts replace their issue's body. Bodies travel as `--body-file` paths, never argv.
 */
function commitDrafts() {
	return act("Committing drafts", async () => {
		const v = draftsView;
		if (!v) throw new Error("drafts view closed");
		const existing = new Set(await gh.listLabels(repoCwd));
		const columnLabel = config.columns[0]?.label;
		const skipped = new Set<string>();
		const created: number[] = [];
		const updated: number[] = [];
		for (const d of v.drafts) {
			if (!v.accepted.has(d.path)) continue;
			if (d.kind === "ticket") {
				const wanted = [columnLabel, `${config.plan.clusterLabelPrefix}${d.cluster}`].filter((l): l is string => !!l);
				const labels = wanted.filter(l => existing.has(l));
				for (const l of wanted) if (!existing.has(l)) skipped.add(l);
				created.push(await gh.createIssue(repoCwd, d.title, join(repoCwd, d.path), labels));
			} else {
				await gh.editIssueBody(repoCwd, d.issue, join(repoCwd, d.path));
				updated.push(d.issue);
			}
		}
		await loadIssues(true);
		const parts = [
			created.length ? `created ${created.map(n => `#${n}`).join(" ")}` : "",
			updated.length ? `updated ${updated.map(n => `#${n}`).join(" ")}` : "",
			skipped.size ? `labels skipped (not on repo): ${[...skipped].join(", ")}` : "",
		].filter(Boolean);
		return parts.join(" · ") || "nothing to do";
	});
}

/**
 * `/orchestrate`: the selection's bodies into one context file, then a HOST orchestrator agent in
 * a split pane with the pipeline-contract prompt (plan first, read-only on GitHub, wb dispatch,
 * consented finish). The board adds no wb wrappers — the orchestrator fans out `wb start` itself.
 */
function orchestrateSelection() {
	const picks = pickedIssues(false);
	if (!picks.length) return setStatus("Select tickets first (space or /select), then run a slash command", YELLOW);
	const numbers = picks.map(i => i.number);
	const range = rangeLabel(numbers);
	return act(`Orchestrating ${numbers.length} ticket${numbers.length === 1 ? "" : "s"}`, async () => {
		if (!originPane) throw new Error("no origin pane to split (open the board via its action)");
		const contexts = await collectTicketContexts(repoCwd, picks);
		const file = contextFilePath(repoCwd, range);
		await Bun.write(file, orchestrateContext(repo, contexts));
		const prompt = fill(config.prompts.orchestrate, {
			repo,
			tickets: numbers.map(n => `#${n}`).join(", "),
			list: picks.map(i => `- #${i.number} ${i.title} (${i.url})`).join("\n"),
			range,
			contextFile: file,
		});
		const pane = await hd.splitPane(originPane, repoCwd);
		const started = await launchNamed(`orchestrate-${range}`, pane, prompt);
		return `${started} — context: ${file}`;
	});
}

// ── skills: run in a fresh worktree, then publish the prototype back ────────

/** Branch + prompt variables for a `/{skill}` run over the current selection. */
function skillVars(skill: Skill) {
	const picks = pickedIssues(false);
	const numbers = picks.map(i => i.number);
	const range = rangeLabel(numbers);
	return {
		picks,
		numbers,
		range,
		branch: `${config.prototype.branchPrefix}${range}-${slug(skill.name)}`,
		list: picks.map(i => `- #${i.number} ${i.title} (${i.url})`).join("\n"),
	};
}

/**
 * `/{skill}`: under the wb launcher one sandboxed wb task per run on the BR-2 id
 * (`issues-<range>-<skill>`) — wb opens the pane and delivers the prompt (BR-11). A multi-ticket
 * run on a serial repo is refused up front with a `wb mode tree` hint; a dirty serial worktree
 * surfaces wb's own abort line (first stderr line of the nonzero exit) in the notice slot.
 */
async function runSkill(skill: Skill) {
	const { picks, numbers, range, branch, list } = skillVars(skill);
	if (!picks.length) return setStatus("Select tickets first (space or /select), then run a slash command", YELLOW);
	const l = launcher();
	if (!l.wb) return runSkillHerdr(skill, l.notice);
	const mode = (await wb.wbRepoConfig(repoCwd)).mode === "serial" ? ("serial" as const) : ("tree" as const);
	if (mode === "serial" && numbers.length > 1)
		return setStatus(`Refused: serial wb repo cannot fan out over ${numbers.length} tickets — run \`wb mode tree\``, YELLOW);
	return act(`Running /${skill.name} on ${numbers.length} tickets`, async () => {
		const task = wb.taskIdForSkill(numbers, slug(skill.name));
		const taskBranch = wb.localBranchFor(task, mode);
		const prompt = fill(config.prompts.skill, {
			skill: skill.name,
			skillPath: skill.path,
			count: numbers.length,
			repo,
			tickets: numbers.map(n => `#${n}`).join(", "),
			list,
			branch: taskBranch,
			range,
			extra: skill.name === config.prototype.skill ? config.prompts.prototypeExtra : "",
		});
		await wb.wbStart(task, repoCwd, config.wb.agent, prompt);
		void refreshWb();
		return `Started wb task ${task} (${config.wb.agent})`;
	});
}

/** The herdr-launcher `/{skill}` flow, kept verbatim (fallback carries the wb-unavailable notice). */
function runSkillHerdr(skill: Skill, notice: string | null) {
	const { picks, numbers, range, branch, list } = skillVars(skill);
	if (!picks.length) return setStatus("Select tickets first (space or /select), then run a slash command", YELLOW);
	return act(`Running /${skill.name} on ${numbers.length} tickets${notice ? ` — ${notice}` : ""}`, async () => {
		const pane = await hd.createWorktree(repoCwd, branch, `#${range} ${skill.name}`);
		const prompt = fill(config.prompts.skill, {
			skill: skill.name,
			skillPath: skill.path,
			count: numbers.length,
			repo,
			tickets: numbers.map(n => `#${n}`).join(", "),
			list,
			branch,
			range,
			extra: skill.name === config.prototype.skill ? config.prompts.prototypeExtra : "",
		});
		const base = `${slug(skill.name)}-${range}`.slice(0, 31).replace(/-$/, "");
		return launchNamed(base, pane, prompt, `on ${branch}`);
	});
}

/**
 * `/attach` (BR-12): under the wb launcher this recomputes the BR-2 task id, finds the pool
 * worktree for it, commits dirty artefacts locally (no network), then asks `push <branch> to
 * origin? [y/N]` — yes pushes via consented `wb publish` (the only push path), no comments with
 * the branch pointer anyway. Under herdr the legacy `slash/*` flow runs verbatim.
 */
function attachPrototype() {
	const picks = pickedIssues(false);
	if (!picks.length) return setStatus("Select the tickets the prototype was generated for", YELLOW);
	const numbers = picks.map(i => i.number);
	const l = launcher();
	if (!l.wb) return attachPrototypeHerdr(numbers, l.notice);
	const taskId = wb.taskIdForSkill(numbers, slug(config.prototype.skill));
	return act(`Attaching prototype to ${numbers.length} tickets`, async () => {
		const pool = await wb.loadPool(repoCwd);
		const t = pool.find(p => p.task === taskId);
		if (!t) throw new Error(`no wb task \`${taskId}\` — run /${config.prototype.skill} on these tickets first`);
		const artifacts = await proto.findArtifacts(t.path, config.prototype.dir, config.prototype.artifactGlobs);
		if (!artifacts.length) throw new Error(`no artefacts under ${config.prototype.dir}/ in ${t.path}`);
		await proto.commitArtifacts(t, artifacts.map(a => a.rel), `prototype: #${rangeLabel(numbers)} artefacts`);
		const remoteBranch = wb.remoteBranchFor(t.task, t.mode);
		attachPending = { task: t.task, branch: t.branch, remoteBranch, numbers, artifacts };
		input = { label: `push ${remoteBranch} to origin? [y/N]`, buffer: "", apply: text => void finishAttach(wb.consentAnswer(text)) };
		return `Committed ${artifacts.length} artefact${artifacts.length === 1 ? "" : "s"} on ${t.branch} — push consent below`;
	});
}

/** Consent resolved: yes → `wb publish` then comment; no → comment only, nothing pushed. */
function finishAttach(consent: boolean) {
	const a = attachPending;
	attachPending = null;
	if (!a) return setStatus("Nothing to attach", YELLOW);
	return act(`${consent ? "Publishing" : "Commenting"} prototype for ${a.numbers.length} tickets`, async () => {
		if (consent) await wb.wbPublish(a.task, repoCwd);
		const repoTarget = await gh.repoName(repoCwd);
		await proto.commentOnIssues(
			repoCwd,
			a.numbers,
			proto.artifactComment({ branch: consent ? a.remoteBranch : a.branch, repo: repoTarget, skill: config.prototype.skill, numbers: a.numbers, artifacts: a.artifacts, pushed: consent }),
		);
		const shots = a.artifacts.filter(x => x.image).length;
		return consent
			? `Commented on ${a.numbers.length} tickets (${a.remoteBranch} pushed via wb publish, ${shots} screenshots)`
			: `Commented on ${a.numbers.length} tickets (${a.branch} committed locally, not pushed, ${shots} screenshots)`;
	});
}

/** The herdr-launcher `/attach` flow, kept verbatim (BR-12 legacy path). */
function attachPrototypeHerdr(numbers: number[], notice: string | null) {
	const range = rangeLabel(numbers);
	return act(`Attaching prototype to ${numbers.length} tickets${notice ? ` — ${notice}` : ""}`, async () => {
		const trees = await proto.listWorktrees(repoCwd);
		const wt = proto.pickPrototypeWorktree(trees, config.prototype.branchPrefix, range);
		if (!wt) throw new Error(`no prototype worktree on a "${config.prototype.branchPrefix}${range}" or "${config.prototype.branchPrefix}${range}-<skill>" branch in this repo`);
		const artifacts = await proto.findArtifacts(wt.path, config.prototype.dir, config.prototype.artifactGlobs);
		if (!artifacts.length) throw new Error(`no artefacts under ${config.prototype.dir}/ in ${wt.path}`);
		await proto.publishArtifacts(wt, artifacts.map(a => a.rel), `prototype: #${range} artefacts`);
		const repoTarget = await gh.repoName(repoCwd);
		const skill = reportView?.skill?.name ?? wt.branch.replace(/^.*\//, "").replace(`${range}-`, "");
		await proto.commentOnIssues(repoCwd, numbers, proto.artifactComment({ branch: wt.branch, repo: repoTarget, skill, numbers, artifacts }));
		const shots = artifacts.filter(a => a.image).length;
		return `Commented on ${numbers.length} tickets (${wt.branch}, ${shots} screenshots)`;
	});
}

// ── input ───────────────────────────────────────────────────────────────────

function moveSel(dc: number, dr: number) {
	if (!columns.length) return;
	if (dc) {
		selCol = clamp(selCol + dc, 0, columns.length - 1);
		const col = columns[selCol];
		selRow = clamp(selRow, 0, Math.max(0, col.issues.length - 1));
		// Keep the selection in the visible window rather than jumping to a stale row.
		if (selRow < col.scroll || selRow >= col.scroll + layout().perCol) selRow = clamp(col.scroll, 0, Math.max(0, col.issues.length - 1));
	}
	if (dr) selRow = clamp(selRow + dr, 0, Math.max(0, columns[selCol].issues.length - 1));
	ensureVisible();
	render();
}

function onKey(key: string) {
	if (key === "ctrl-c") return quit();
	if (input) {
		const p = input;
		if (key === "esc") input = null;
		else if (key === "enter") {
			input = null;
			p.apply(p.buffer);
			return;
		} else if (key === "backspace") p.buffer = p.buffer.slice(0, -1);
		else if (key.length === 1 && key >= " ") p.buffer += key;
		return render();
	}
	if (menu) {
		const m = menu;
		if (key === "up" || key === "k") m.index = firstEnabled(m.items, m.index - 1, -1);
		else if (key === "down" || key === "j") m.index = firstEnabled(m.items, m.index + 1, 1);
		else if (key === "enter" || key === "right" || key === "l" || key === " ") return void activate(m, m.index);
		else if (key === "esc" || key === "left" || key === "h" || key === "q") menu = m.parent;
		return render();
	}
	if (reportView) {
		const r = reportView;
		const page = Math.max(1, layout().bodyH - 2);
		if (key === "esc" || key === "q" || key === "backspace" || key === "h" || key === "left") reportView = null;
		else if (key === "down" || key === "j") r.scroll++;
		else if (key === "up" || key === "k") r.scroll--;
		else if (key === "pgdn" || key === " ") r.scroll += page;
		else if (key === "pgup") r.scroll -= page;
		else if (key === "g" || key === "home") r.scroll = 0;
		else if (key === "G" || key === "end") r.scroll = Number.MAX_SAFE_INTEGER;
		else if (key === "/") return openSlashPalette();
		else if (key === "e") return void exportReport();
		else if (key === "y") return void copyReport();
		else if (key === "a" || key === "m" || key === ".") return openReportAgentMenu();
		return render();
	}
	if (wbView) {
		const v = wbView;
		const page = Math.max(1, layout().bodyH - 2);
		if (key === "esc" || key === "q" || key === "backspace" || key === "h" || key === "left") wbView = null;
		else if (key === "down" || key === "j") v.scroll++;
		else if (key === "up" || key === "k") v.scroll--;
		else if (key === "pgdn" || key === " ") v.scroll += page;
		else if (key === "pgup") v.scroll -= page;
		else if (key === "g" || key === "home") v.scroll = 0;
		else if (key === "G" || key === "end") v.scroll = Number.MAX_SAFE_INTEGER;
		else if (key === "r") return void loadWbView();
		return render();
	}
	if (wbDiffView) {
		const v = wbDiffView;
		const page = Math.max(1, layout().bodyH - 2);
		if (key === "esc" || key === "q" || key === "backspace" || key === "h" || key === "left") wbDiffView = null;
		else if (key === "down" || key === "j") v.scroll++;
		else if (key === "up" || key === "k") v.scroll--;
		else if (key === "pgdn" || key === " ") v.scroll += page;
		else if (key === "pgup") v.scroll -= page;
		else if (key === "g" || key === "home") v.scroll = 0;
		else if (key === "G" || key === "end") v.scroll = Number.MAX_SAFE_INTEGER;
		return render();
	}
	if (draftsView) {
		const v = draftsView;
		const page = Math.max(1, layout().bodyH - 2);
		if (key === "esc" || key === "q" || key === "backspace" || key === "h" || key === "left") draftsView = null;
		else if (key === "down" || key === "j") v.cursor++;
		else if (key === "up" || key === "k") v.cursor--;
		else if (key === "pgdn") v.cursor += page;
		else if (key === "pgup") v.cursor -= page;
		else if (key === "g" || key === "home") v.cursor = 0;
		else if (key === "G" || key === "end") v.cursor = Number.MAX_SAFE_INTEGER;
		else if (key === " ") toggleDraftAccept();
		else if (key === "r") return void reloadDrafts();
		else if (key === "e") return void editDraftFile();
		else if (key === "c") return openDraftsConsent();
		return render();
	}
	if (detail) {
		const page = Math.max(1, layout().bodyH - 2);
		if (key === "esc" || key === "q" || key === "backspace" || key === "h" || key === "left") detail = null;
		else if (key === "down" || key === "j") detail.scroll++;
		else if (key === "up" || key === "k") detail.scroll--;
		else if (key === "pgdn" || key === " ") detail.scroll += page;
		else if (key === "pgup") detail.scroll -= page;
		else if (key === "g" || key === "home") detail.scroll = 0;
		else if (key === "G" || key === "end") detail.scroll = Number.MAX_SAFE_INTEGER;
		else if (key === "m" || key === ".") return openMenuAtSelection();
		else if (key === "o") return void openBrowser(detail.issue);
		else if (key === "i") return void implementInWorktree(detail.issue);
		return render();
	}
	const issue = selectedIssue();
	switch (key) {
		case "q":
		case "esc":
			return quit();
		case "left":
		case "h":
			return moveSel(-1, 0);
		case "right":
		case "l":
			return moveSel(1, 0);
		case "up":
		case "k":
			return moveSel(0, -1);
		case "down":
		case "j":
			return moveSel(0, 1);
		case "pgup":
			return moveSel(0, -layout().perCol);
		case "pgdn":
			return moveSel(0, layout().perCol);
		case "g":
		case "home":
			return moveSel(0, -Number.MAX_SAFE_INTEGER);
		case "G":
		case "end":
			return moveSel(0, Number.MAX_SAFE_INTEGER);
		case "r":
			if (wbReady) void refreshWb();
			return void loadIssues();
		case "enter":
			return issue && openDetail(issue);
		case " ":
		case "x":
			return issue && toggleSelect(issue);
		case "J":
			return extendSelection(1);
		case "K":
			return extendSelection(-1);
		case "A":
			return selectColumn();
		case "c":
			return setSelection([]);
		case "S":
			return openSelectPrompt();
		case "/":
			return openSlashPalette();
		case "m":
		case ".":
			return openMenuAtSelection();
		case "o":
			return issue && void openBrowser(issue);
		case "i":
			return issue && void implementInWorktree(issue);
	}
}

const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

function onMouse(button: number, x: number, y: number) {
	if (button & 32) return; // motion
	const wheel = button & 64 ? (button & 1 ? 1 : -1) : 0;
	const btn = button & 3;

	if (wheel) {
		if (menu) {
			menu.index = firstEnabled(menu.items, menu.index + wheel, wheel > 0 ? 1 : -1);
			return render();
		}
		if (reportView) {
			reportView.scroll += wheel * 3;
			return render();
		}
		if (wbView) {
			wbView.scroll += wheel * 3;
			return render();
		}
		if (wbDiffView) {
			wbDiffView.scroll += wheel * 3;
			return render();
		}
		if (draftsView) {
			draftsView.cursor += wheel * 3;
			return render();
		}
		if (detail) {
			detail.scroll += wheel * 3;
			return render();
		}
		const hit = titleHits.find(h => x >= h.x0 && x <= h.x1);
		const col = hit && columns[hit.col];
		if (!col) return;
		col.scroll = clamp(col.scroll + wheel, 0, Math.max(0, col.issues.length - layout().perCol));
		return render();
	}

	if (menu) {
		if (menuRect && inside(menuRect, x, y)) {
			const row = menuItemRows.find(r => r.y === y);
			if (row) {
				menu.index = row.index;
				void activate(menu, row.index);
			}
			return;
		}
		menu = null;
		if (btn !== 2) return render();
	}

	if (reportView) return;
	if (wbView) return;
	if (wbDiffView) return;
	if (draftsView) return;
	if (detail) {
		if (btn === 2) openMenu(detail.issue, x, y);
		return;
	}

	const title = titleHits.find(h => inside(h, x, y));
	if (title) return moveSel(title.col - selCol, 0);
	const card = cardHits.find(h => inside(h, x, y));
	if (!card) return render();
	const issue = columns[card.col].issues[card.row];
	const wasSelected = card.col === selCol && card.row === selRow;
	selCol = card.col;
	selRow = card.row;
	if (btn === 2) return openMenu(issue, x, y);
	if (btn === 0 && wasSelected) return openDetail(issue);
	render();
}

function csiKey(params: string, final: string): string {
	if (final === "~") return { "1": "home", "4": "end", "5": "pgup", "6": "pgdn", "7": "home", "8": "end" }[params.split(";")[0]] ?? "";
	return { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab" }[final] ?? "";
}

function onData(data: string) {
	if (suspended) return; // editor keystrokes must never reach onKey, even if pause ever fails
	let i = 0;
	while (i < data.length) {
		const rest = data.slice(i);
		let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
		if (m) {
			if (m[4] === "M") onMouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
			i += m[0].length;
			continue;
		}
		m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest) ?? /^\x1bO()([A-Z])/.exec(rest);
		if (m) {
			onKey(csiKey(m[1], m[2]));
			i += m[0].length;
			continue;
		}
		if (rest[0] === "\x1b") {
			onKey("esc");
			i += rest[1] && rest[1] !== "\x1b" ? 2 : 1; // drop alt+key's key
			continue;
		}
		const ch = String.fromCodePoint(rest.codePointAt(0) ?? 0);
		i += ch.length;
		const named: Record<string, string> = { "\r": "enter", "\n": "enter", "\x03": "ctrl-c", "\x7f": "backspace", "\x08": "backspace" };
		onKey(named[ch] ?? ch);
	}
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function quit(): never {
	process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.exit(0);
}

config = await loadConfig();
buildColumns();
wbReady = config.wb.enabled && wb.wbAvailable();
if (selfPane) hd.routeRightClickToPane(selfPane).catch(() => {});
process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J");
process.stdin.setRawMode(true);
process.stdin.on("data", (buf: Buffer) => onData(buf.toString("utf8")));
process.stdout.on("resize", () => {
	ensureVisible();
	render();
});
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);
render();
void loadIssues();
void refreshAgents();
void loadSkills();
if (wbReady) void refreshWb();
setInterval(refreshAgents, 3000);
setInterval(() => {
	void loadIssues(true);
	if (wbReady) void refreshWb();
}, 120_000);
