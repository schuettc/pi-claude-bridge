/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 *
 * The child is also told WHICH pi session it belongs to. The bridge captures its
 * own session id at session_start and stamps it as AGENT_SESSION_ID on every
 * child it spawns; it never lets a value already sitting in process.env through.
 * That inherited value is exactly the bug: pi-subagents runs children inside the
 * parent's process, another extension used to write the child's id into the
 * shared process.env, and every Claude Code child the parent spawned afterwards
 * announced itself as the subagent's.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// activate() loads the user's real ~/.pi/agent/claude-bridge.json. Whenever
// askClaude.enabled is true there, activate() reaches pi.registerTool(), which
// the mock `pi` below doesn't provide, and the session_start test would fail
// for a reason that has nothing to do with childEnv or session identity. Point
// loadConfig at an empty, unwritten directory so this file's activate() calls
// see no config, matching a machine with the default (askClaude disabled).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "claude-bridge-test-agent-dir-"));

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers, and muster hooks", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			MUSTER_HOOK_DISABLE: "1",
		});
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// referencing childEnv() are the guard, and a fourth is a review question.

	it("stamps the captured session id regardless of what the host env says", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSION_ID: "stale-from-a-subagent" };
		const env = __test.childEnv(base, "01a08409-parent");
		assert.equal(env.AGENT_SESSION_ID, "01a08409-parent");
		assert.equal(env.PATH, "/usr/bin");
		assert.equal(env.MUSTER_HOOK_DISABLE, "1", "CC_CHILD_ENV still applies");
	});

	it("does not let an inherited id through when nothing was captured", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSION_ID: "stale-from-a-subagent" };
		const env = __test.childEnv(base, undefined);
		assert.ok("AGENT_SESSION_ID" in env, "key is present so spawn unsets it");
		assert.equal(env.AGENT_SESSION_ID, undefined);
	});

	it("treats an empty captured id as none", () => {
		const env = __test.childEnv({ AGENT_SESSION_ID: "stale" }, "");
		assert.equal(env.AGENT_SESSION_ID, undefined);
	});

	it("never mutates the base environment", () => {
		const base = { AGENT_SESSION_ID: "stale" };
		__test.childEnv(base, "fresh");
		assert.equal(base.AGENT_SESSION_ID, "stale");
	});

	it("keeps CC_CHILD_ENV authoritative over both base and identity", () => {
		const env = __test.childEnv({ DISABLE_AUTO_COMPACT: "0" }, "x");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	});

	it("captures the session id at session_start and re-captures on every reason", () => {
		const handlers = activateWithMockPi();
		const ctxFor = (id) => ({ ui: null, mode: "interactive", sessionManager: { getSessionId: () => id } });

		handlers.get("session_start")({ reason: "startup" }, ctxFor("first"));
		assert.equal(__test.capturedSessionId(), "first");

		handlers.get("session_start")({ reason: "new" }, ctxFor("second"));
		assert.equal(__test.capturedSessionId(), "second", "/new mints a new id and the capture follows it");

		handlers.get("session_start")({ reason: "resume" }, ctxFor("third"));
		assert.equal(__test.capturedSessionId(), "third");
	});
});
