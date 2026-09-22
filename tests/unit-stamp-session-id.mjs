/**
 * AGENT_SESSION_ID on the provider's Claude Code child is the TOP-LEVEL pi session
 * id captured at session_start, not the per-query options.sessionId.
 *
 * Inside streamClaudeAgentSdk upstream keeps a local `piSessionId`
 * (options.sessionId — a subagent's own id when a subagent's AgentSession calls
 * the provider). A module-level variable of the same name was silently shadowed
 * there after the 0.9.0 catch-up; tsc (strict: false) accepted it. muster reads
 * AGENT_SESSION_ID for caller identity, so the child must carry the hosting
 * session's id whatever session the query serves.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-stamp-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { __test } = mod;

const handlers = new Map();
let providerConfig;
mod.default({
	on: (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
	appendEntry: () => {},
});
const model = providerConfig.models[0];

const TOP = "pi-top-level-session";
const SUB = "pi-subagent-session";
const ctx = {
	cwd: process.cwd(),
	mode: "rpc",
	ui: { notify() {}, setStatus() {}, setWidget() {} },
	sessionManager: { getSessionId: () => TOP, getEntries: () => [] },
	modelRegistry: { getProvider: () => providerConfig },
};
for (const handler of handlers.get("session_start") ?? []) handler({ reason: "new" }, ctx);

afterEach(() => {
	__test.setQuery(null);
	__test.resetSharedSession();
});

describe("AGENT_SESSION_ID stamping on the provider path", () => {
	it("stamps the top-level session id even when the query serves another pi session", async () => {
		let env;
		__test.setQuery(({ options }) => {
			env = options.env;
			const gen = (async function* () {
				yield { type: "system", subtype: "init", session_id: "cc-stamp" };
				yield { type: "result", subtype: "success", is_error: false, result: "ok" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		await providerConfig.streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
			{ sessionId: SUB },
		).result();
		assert.ok(env, "the provider spawned a Claude Code child");
		assert.equal(env.AGENT_SESSION_ID, TOP, "the child carries the hosting session's id, not the query's");
		assert.equal(env.MUSTER_HOOK_DISABLE, "1");
	});
});
