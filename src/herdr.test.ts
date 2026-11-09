// The prompt guard: herdr's CLI has no "--" end-of-options marker, so a leading "-" would be parsed
// as a flag. Asserted without a live herdr — the binary path is pointed at a file that cannot exist,
// which also proves the guard lets ordinary prompts through instead of being a blunt filter.
import { describe, expect, test } from "bun:test";

// `herdr.ts` captures HERDR_BIN_PATH at import time, so it must be set before the dynamic import.
process.env.HERDR_BIN_PATH = "/nonexistent/herdr-for-tests";
const { promptAgent } = await import("./herdr");

describe("promptAgent", () => {
	test("rejects prompt text starting with '-' — herdr would parse it as a flag", async () => {
		await expect(promptAgent("agent-1", "-x refactor the parser")).rejects.toThrow(
			"prompt text must not start with '-'",
		);
	});

	test("lets any other prompt through to herdr — the guard is not a filter", async () => {
		// No live herdr: the call fails at spawn, which is what proves it got past the guard.
		let failure: unknown;
		try {
			await promptAgent("agent-1", "refactor the -parser");
		} catch (err) {
			failure = err;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain("must not start with '-'");
	});
});
