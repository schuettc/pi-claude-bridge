/**
 * The active account decides where a turn's Claude Code session lives and which
 * login its child uses. A session written under one account's folder cannot be
 * resumed from another's, so a switch must rebuild in the new folder.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");
const acc = await import("../src/accounts.js");

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const history = () => [
	{ role: "user", content: "Hi", timestamp: Date.now() },
	{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
	{ role: "user", content: "Next", timestamp: Date.now() },
];

function seed(cwd, claudeDir) {
	const sessionId = randomUUID();
	const s = createSession({ sessionId, projectPath: cwd, claudeDir });
	s.importMessages([{ role: "user", content: "Hi" }, { role: "assistant", content: [{ type: "text", text: "Hello." }] }]);
	s.save();
	return sessionId;
}

afterEach(() => {
	__test.resetSharedSession();
	acc.resetAccountStateForTest();
});

describe("session placement follows the account", () => {
	it("resumes when the session already lives in this account's folder", () => {
		const cwd = temp("route-cwd-"), dirA = temp("route-a-");
		try {
			const sessionId = seed(cwd, dirA);
			__test.setSharedSession({ sessionId, cursor: 2, cwd, claudeDir: dirA });
			assert.equal(__test.syncSharedSession(history(), cwd, undefined, undefined, dirA).sessionId, sessionId);
		} finally { rmSync(cwd, { recursive: true, force: true }); rmSync(dirA, { recursive: true, force: true }); }
	});

	it("rebuilds a new session in the new folder after a switch, leaving the old file alone", () => {
		const cwd = temp("route-cwd-"), dirA = temp("route-a-"), dirB = temp("route-b-");
		try {
			const sessionId = seed(cwd, dirA);
			__test.setSharedSession({ sessionId, cursor: 2, cwd, claudeDir: dirA });
			const result = __test.syncSharedSession(history(), cwd, undefined, undefined, dirB);
			assert.ok(result.sessionId, "rebuilds from pi's history");
			assert.notEqual(result.sessionId, sessionId, "a new id: the old one belongs to the other folder");
			assert.equal(__test.getSharedSession().claudeDir, dirB);
			const rebuilt = openSession({ sessionId: result.sessionId, projectPath: cwd, claudeDir: dirB });
			assert.deepEqual(rebuilt.messages.map((m) => m.type), ["user", "assistant"]);
			assert.equal(openSession({ sessionId, projectPath: cwd, claudeDir: dirA }).messages.length, 2, "old file untouched");
		} finally { for (const d of [cwd, dirA, dirB]) rmSync(d, { recursive: true, force: true }); }
	});

	it("defaults the folder to the active account's", () => {
		const cwd = temp("route-cwd-"), dirA = temp("route-a-"), dirB = temp("route-b-");
		try {
			const sessionId = seed(cwd, dirA);
			__test.setSharedSession({ sessionId, cursor: 2, cwd, claudeDir: dirA });
			acc.setActiveAccount({ id: "b1", name: "b", configDir: dirB });
			const result = __test.syncSharedSession(history(), cwd);
			assert.notEqual(result.sessionId, sessionId);
			assert.equal(__test.getSharedSession().claudeDir, dirB);
		} finally { for (const d of [cwd, dirA, dirB]) rmSync(d, { recursive: true, force: true }); }
	});

	it("builds a side request's session in the active account's folder", () => {
		const cwd = temp("route-cwd-"), dirB = temp("route-b-");
		try {
			acc.setActiveAccount({ id: "b1", name: "b", configDir: dirB });
			const id = __test.buildSideRequestSession(history().slice(0, 2), cwd);
			assert.equal(openSession({ sessionId: id, projectPath: cwd, claudeDir: dirB }).messages.length, 2);
		} finally { for (const d of [cwd, dirB]) rmSync(d, { recursive: true, force: true }); }
	});
});

describe("child environment and errors follow the account", () => {
	it("the usage refresh applies the active account at each refresh", async () => {
		const dirB = "/tmp/accounts/b1";
		acc.setActiveAccount({ id: "b1", name: "b", configDir: dirB });
		let queryInput;
		const sdkQuery = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return Promise.resolve({}); },
			close() {},
		};
		await __test.refreshClaudeUsage(
			{ timeoutMs: 1_000 },
			{ query: (input) => { queryInput = input; return sdkQuery; }, cwd: "/tmp", env: { HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "t" }, provider: {} },
		).catch(() => {}); // the snapshot of an empty payload may throw; only the options matter here
		assert.deepEqual(queryInput.options.env, { HOME: "/h", CLAUDE_CONFIG_DIR: dirB });
	});

	it("a named account's child env keeps pointing at its folder even if the folder is gone", () => {
		const env = acc.accountEnv({ HOME: "/h" }, { id: "b1", name: "b", configDir: "/nonexistent/accounts/b1" });
		assert.equal(env.CLAUDE_CONFIG_DIR, "/nonexistent/accounts/b1", "never falls back to another login");
	});

	it("names the signed-out account in Claude Code's not-logged-in error", () => {
		acc.setActiveAccount({ id: "b1", name: "work", configDir: "/tmp/accounts/b1" });
		const text = __test.resultErrorText({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
		assert.equal(text, 'Claude account "work" is signed out. /claude-account to sign in again.');
	});

	it("leaves other result errors unchanged", () => {
		const text = __test.resultErrorText({ type: "result", subtype: "success", is_error: true, result: "API Error: 500" });
		assert.equal(text, "API Error: 500");
	});
});

describe("usage meter follows the account", () => {
	afterEach(() => __test.setInlineUsageSnapshot(undefined));

	it("uses the last turn's snapshot only while the same account is active", () => {
		const snapshot = { version: 1, provider: "claude", complete: true, windows: [] };
		__test.setInlineUsageSnapshot(snapshot);
		assert.equal(__test.cachedUsageForActiveAccount(), snapshot, "same account: reuse");
		acc.setActiveAccount({ id: "b1", name: "b", configDir: "/tmp/accounts/b1" });
		assert.equal(__test.cachedUsageForActiveAccount(), undefined, "after a switch: refresh instead");
		acc.setActiveAccount(acc.LAUNCH_ACCOUNT);
		assert.equal(__test.cachedUsageForActiveAccount(), snapshot, "back on the first account: its snapshot again");
	});
});
