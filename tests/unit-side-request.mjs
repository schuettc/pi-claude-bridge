#!/usr/bin/env node

/**
 * Side requests: the route into a bridge model that pi's model runtime does not own.
 *
 * An extension driving its own `agentLoop` is served by pi-ai's default stream
 * function, which resolves the api id in pi-ai's registry rather than in pi's model
 * runtime — so `pi.registerProvider` alone leaves it unserved. That was not a failed
 * call but a dead process: `agentLoop` starts its run with `void
 * runAgentLoop(...).then(...)` and no `catch`, so the rejection escaped as an
 * unhandled one and pi exited.
 *
 * These pin the registration and the session isolation. Serving one for real needs a
 * Claude Code subprocess — see tests/int-side-request.mjs.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, openSession } from "cc-session-io";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {} });
	return handlers;
}

describe("api provider registration", () => {
	after(() => { __test.resetSharedSession(); });

	it("covers the api id in pi-ai's own registry, not just pi's model runtime", () => {
		const handlers = activateWithMockPi();
		assert.ok(
			getApiProvider("claude-bridge"),
			"unregistered here, an extension's own agentLoop on a bridge model throws where nothing catches it",
		);

		// A live session keeps serving side requests, so only shutdown may withdraw it.
		handlers.get("session_start")({ reason: "new" }, {});
		assert.ok(getApiProvider("claude-bridge"), "session_start must not withdraw the registration");

		handlers.get("session_shutdown")({}, {});
		assert.equal(getApiProvider("claude-bridge"), undefined, "shutdown leaves no route to a torn-down module");

		// The /reload shape: pi tears the old instance down before reactivating.
		activateWithMockPi();
		assert.ok(getApiProvider("claude-bridge"), "reactivation after shutdown must restore it");
	});
});

describe("side request session", () => {
	it("holds the caller's own history and leaves the shared session alone", () => {
		const cwd = mkdtempSync(join(tmpdir(), "side-request-"));
		const mainSession = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 42, cwd };
		__test.setSharedSession(null, mainSession);
		let sessionId;
		try {
			sessionId = __test.buildSideRequestSession([
				{ role: "user", content: "the caller's own first turn", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "and its reply" }], timestamp: Date.now() },
			], cwd, undefined, "claude-haiku-4-5");

			assert.notEqual(sessionId, mainSession.sessionId, "a side request must not write into pi's session");
			assert.deepEqual(__test.getSharedSession(), mainSession, "nor take over the shared-session bookkeeping");

			// Skipping the rebuild would drop this history silently: the prompt Claude Code
			// receives is only the caller's last user turn.
			const written = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			assert.equal(written.messages.length, 2, "the caller's prior turns must reach Claude Code");
		} finally {
			__test.resetSharedSession();
			if (sessionId) deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("side request vs pi's per-session mirrors (0.9.0)", () => {
	// Upstream 0.9.0 keys the CC session mirror, and history-rewrite staleness, by
	// options.sessionId. A side request may carry pi's own session id, yet its
	// history is its caller's: it must not read, move or consume anything that
	// belongs to that pi session, nor be discarded by that session's /compact.
	const P = "pi-side-host";

	after(() => { __test.setQuery(null); __test.resetSharedSession(); });

	it("serves no pi session: the host's mirror and pending rewrite are left alone", async () => {
		// Not the first instance in this process, so provider registration waits for
		// session_start (the last handler registered); a registry without the provider
		// makes it register, which hands us a model.
		let model;
		const starts = [];
		activate({
			on: (e, h) => { if (e === "session_start") starts.push(h); },
			registerProvider: (_n, config) => { model = { ...config.models[0], api: "claude-bridge", provider: "claude-bridge" }; },
			registerTool: () => {},
		});
		if (!model) starts.at(-1)({ reason: "startup" }, { modelRegistry: { getProvider: () => undefined } });
		const side = getApiProvider("claude-bridge");

		__test.resetSharedSession();
		const mirror = { sessionId: "22222222-2222-4222-8222-222222222222", cursor: 42, cwd: process.cwd(), piSessionId: P };
		__test.setSharedSession(P, { ...mirror });
		// The host session has compacted and not yet run a turn since.
		__test.markRebuildForSession(P, "test");
		const marked = __test.getSharedSession(P);

		let release;
		const gate = new Promise((r) => { release = r; });
		__test.setQuery(() => {
			const gen = (async function* () {
				yield { type: "system", subtype: "init", session_id: "cc-side" };
				await gate;
				yield { type: "result", subtype: "success", is_error: false, result: "done" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});

		const stream = side.streamSimple(model, { messages: [{ role: "user", content: "side task", timestamp: 1 }], tools: [] }, { sessionId: P });
		await new Promise((r) => setTimeout(r, 20));
		const inFlight = [...__test.activeQueryContexts];
		assert.equal(inFlight.length, 1, "the side request is in flight");
		assert.equal(inFlight[0].piSessionId, null, "a side request serves no pi session");

		// The host's pending rewrite is re-armed onto parked queries; not onto this one.
		__test.armStaleContexts();
		assert.equal(inFlight[0].historyStale, false, "the host's rewrite must not arm the side request");

		release();
		await stream.result();

		assert.deepEqual(__test.getSharedSession(P), marked, "the host session's mirror is not the side request's to move");
		assert.ok(__test.historyRewrittenBySession.has(P), "the host session's pending rewrite is still pending");
	});
});
