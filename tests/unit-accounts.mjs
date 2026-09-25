/**
 * Accounts core: the registry file, names, the active account, the resolver every
 * Claude Code child goes through, and restoring a session's account.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acc = await import("../src/accounts.js");

const tempRoot = () => mkdtempSync(join(tmpdir(), "claude-accounts-"));
const work = { id: "a1b2c3d4", name: "work", configDir: "/tmp/accounts/a1b2c3d4" };
const registryWith = (...accounts) => ({ version: 1, default: acc.LAUNCH_ID, accounts: [{ ...acc.LAUNCH_ACCOUNT }, ...accounts] });

afterEach(() => acc.resetAccountStateForTest());

describe("registry file", () => {
	it("a missing file means only the launch account", () => {
		const root = tempRoot();
		try {
			const { registry, problem } = acc.loadRegistry(root);
			assert.equal(problem, undefined);
			assert.deepEqual(registry, { version: 1, default: "launch", accounts: [{ id: "launch", name: "default", configDir: null }] });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("round-trips, written with mode 0600", () => {
		const root = tempRoot();
		try {
			const registry = { ...registryWith(work), default: work.id };
			acc.saveRegistry(root, registry);
			assert.deepEqual(acc.loadRegistry(root), { registry });
			assert.equal(statSync(acc.registryPath(root)).mode & 0o777, 0o600);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("an unreadable file falls back to the launch account and reports the problem", () => {
		const root = tempRoot();
		try {
			mkdirSync(root, { recursive: true });
			writeFileSync(acc.registryPath(root), "{ not json");
			const { registry, problem } = acc.loadRegistry(root);
			assert.deepEqual(registry, acc.defaultRegistry());
			assert.match(problem, /accounts\.json is not a valid accounts file/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects a named account with no folder, and a launch account with one", () => {
		const root = tempRoot();
		try {
			for (const bad of [
				{ id: "x1", name: "x", configDir: null },
				{ id: "launch", name: "default", configDir: "/tmp/somewhere" },
			]) {
				writeFileSync(acc.registryPath(root), JSON.stringify({ version: 1, default: "launch", accounts: [bad] }));
				assert.ok(acc.loadRegistry(root).problem, JSON.stringify(bad));
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("a default that names no account falls back to launch", () => {
		const root = tempRoot();
		try {
			writeFileSync(acc.registryPath(root), JSON.stringify({ version: 1, default: "gone", accounts: [acc.LAUNCH_ACCOUNT, work] }));
			assert.equal(acc.loadRegistry(root).registry.default, "launch");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("accountsRoot is <agent dir>/claude-bridge", () => {
		assert.equal(acc.accountsRoot("/agent"), "/agent/claude-bridge");
	});
});

describe("names", () => {
	const registry = registryWith(work);
	it("accepts a well-formed new name", () => assert.equal(acc.validateName("personal", registry), undefined));
	it("rejects badly formed names", () => {
		for (const name of ["Work", "-x", "a b", "", "x".repeat(33), "wörk"]) assert.ok(acc.validateName(name, registry), name);
	});
	it("rejects a duplicate, including the launch account's 'default'", () => {
		assert.match(acc.validateName("work", registry), /already exists/);
		assert.match(acc.validateName("default", registry), /already exists/);
	});
	it("rejects subcommand words", () => {
		for (const name of ["add", "list", "remove", "use"]) assert.match(acc.validateName(name, registry), /reserved/);
	});
	it("lets an account keep its own name when renaming", () => {
		assert.equal(acc.validateName("work", registry, work.id), undefined);
	});
	it("mints unique 8-character hex ids", () => {
		const id = acc.newAccountId(registry);
		assert.match(id, /^[0-9a-f]{8}$/);
		assert.notEqual(id, work.id);
	});
	it("looks accounts up by id and by name separately", () => {
		assert.equal(acc.byId(registry, work.id), registry.accounts[1]);
		assert.equal(acc.byName(registry, "work"), registry.accounts[1]);
		assert.equal(acc.byId(registry, "work"), undefined);
	});
});

describe("active account and resolver", () => {
	it("starts on the launch account and follows setActiveAccount", () => {
		assert.equal(acc.getActiveAccount().id, "launch");
		acc.setActiveAccount(work);
		assert.equal(acc.getActiveAccount(), work);
	});

	it("is shared through globalThis, so a second module copy sees it", async () => {
		acc.setActiveAccount(work);
		const copy = await import("../src/accounts.js?second-copy");
		assert.equal(copy.getActiveAccount().id, work.id);
	});

	it("passes the launch environment through untouched", () => {
		const base = { HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CONFIG_DIR: "/custom" };
		assert.deepEqual(acc.accountEnv(base, acc.LAUNCH_ACCOUNT), base);
	});

	it("points a named account at its folder and drops inherited credentials", () => {
		const base = { HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "a", CLAUDE_CONFIG_DIR: "/custom" };
		const env = acc.accountEnv(base, work);
		assert.deepEqual(env, { HOME: "/h", CLAUDE_CONFIG_DIR: work.configDir });
		assert.equal(base.CLAUDE_CODE_OAUTH_TOKEN, "t", "the base env is not modified");
	});

	it("resolves the session-file directory", () => {
		const saved = process.env.CLAUDE_CONFIG_DIR;
		try {
			process.env.CLAUDE_CONFIG_DIR = "/launch-dir";
			assert.equal(acc.accountClaudeDir(acc.LAUNCH_ACCOUNT), "/launch-dir");
			assert.equal(acc.accountClaudeDir(work), work.configDir);
		} finally {
			if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
		}
	});
});

describe("restoring a session's account", () => {
	const entry = (data, customType = acc.ACCOUNT_ENTRY_TYPE) => ({ type: "custom", customType, data });
	const registry = { ...registryWith(work), default: work.id };

	it("uses the default when the session never switched", () => {
		assert.deepEqual(acc.restoreAccount([], registry), { account: registry.accounts[1] });
	});
	it("uses the latest entry and ignores other entry types", () => {
		const r = acc.restoreAccount([entry({ id: work.id, name: "work" }), entry({ id: "launch", name: "default" }), entry({ id: work.id }, "other")], registry);
		assert.equal(r.account.id, "launch");
		assert.equal(r.notice, undefined);
	});
	it("finds a renamed account by id", () => {
		const renamed = { ...registryWith({ ...work, name: "job" }) };
		assert.equal(acc.restoreAccount([entry({ id: work.id, name: "work" })], renamed).account.name, "job");
	});
	it("falls back to the default with a notice naming a removed account", () => {
		const r = acc.restoreAccount([entry({ id: "deadbeef", name: "old" })], registry);
		assert.equal(r.account.id, work.id);
		assert.equal(r.notice, 'Account "old" no longer exists; using work.');
	});
});

describe("signed-out text", () => {
	it("names the account for Claude Code's not-logged-in error", () => {
		assert.equal(acc.signedOutText("Not logged in · Please run /login", work), 'Claude account "work" is signed out. /claude-account to sign in again.');
	});
	it("leaves other errors alone", () => {
		assert.equal(acc.signedOutText("API Error: 500", work), undefined);
	});
});
