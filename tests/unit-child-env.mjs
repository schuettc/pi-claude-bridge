/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers, and muster hooks", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			MUSTER_HOOK_DISABLE: "1",
		});
	});

	it("marks a stamped child as part of the hosting session", () => {
		const env = __test.stampedChildEnv({ HOME: "/h" }, " pi-session ");
		assert.equal(env.AGENT_SESSION_ID, "pi-session");
		assert.equal(env.AGENT_SESSION_CHILD, "1");
		assert.equal(env.HOME, "/h");
	});

	it("replaces an inherited id and marker with the captured id", () => {
		const env = __test.stampedChildEnv(
			{ AGENT_SESSION_ID: "stale", AGENT_SESSION_CHILD: "1" },
			"pi-session",
		);
		assert.equal(env.AGENT_SESSION_ID, "pi-session");
		assert.equal(env.AGENT_SESSION_CHILD, "1");
	});

	it("unsets an inherited id and marker when no id was captured", () => {
		for (const captured of [undefined, "", "  "]) {
			const env = __test.stampedChildEnv(
				{ AGENT_SESSION_ID: "stale", AGENT_SESSION_CHILD: "1" },
				captured,
			);
			assert.equal(env.AGENT_SESSION_ID, undefined);
			assert.equal(env.AGENT_SESSION_CHILD, undefined);
		}
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// referencing CC_CHILD_ENV are the guard, and a fourth is a review question.
});
