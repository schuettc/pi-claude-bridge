/**
 * Accounts core: the registry file, names, the active account, the resolver every
 * Claude Code child goes through, and restoring a session's account.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const acc = await import("../src/accounts.js");

const tempRoot = () => mkdtempSync(join(tmpdir(), "claude-accounts-"));
const work = { id: "a1b2c3d4", name: "work", configDir: "/tmp/accounts/a1b2c3d4" };
const registryWith = (...accounts) => ({ version: 1, default: acc.LAUNCH_ID, accounts: [{ ...acc.LAUNCH_ACCOUNT }, ...accounts] });

afterEach(() => {
	acc.resetAccountStateForTest();
	acc.__resetUsageIdentityCacheForTest();
});

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
		for (const name of ["add", "all", "list", "remove", "rename", "use"]) assert.match(acc.validateName(name, registry), /reserved/);
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

describe("usage-bus account identity", () => {
	const readers = (files) => ({
		readFile: (path) => {
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[path];
		},
		stat: (path) => {
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return { mtimeMs: files[`${path}:mtime`] ?? 1 };
		},
	});

	it("reads the email from a named account's <configDir>/.claude.json", () => {
		const path = join(work.configDir, ".claude.json");
		const identity = acc.accountUsageIdentity(work, readers({
			[path]: JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }),
		}));
		assert.deepEqual(identity, { id: work.id, label: "work@example.com" });
	});

	it("falls back to ~/.claude.json for the launch account, honoring CLAUDE_CONFIG_DIR", () => {
		const saved = process.env.CLAUDE_CONFIG_DIR;
		try {
			delete process.env.CLAUDE_CONFIG_DIR;
			const homePath = join(homedir(), ".claude.json");
			const viaHome = acc.accountUsageIdentity(acc.LAUNCH_ACCOUNT, readers({
				[homePath]: JSON.stringify({ oauthAccount: { emailAddress: "launch@example.com" } }),
				[`${homePath}:mtime`]: 1,
			}));
			assert.deepEqual(viaHome, { id: "launch", label: "launch@example.com" });

			process.env.CLAUDE_CONFIG_DIR = "/launch-dir";
			const viaConfigDir = acc.accountUsageIdentity(acc.LAUNCH_ACCOUNT, readers({
				"/launch-dir/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "env@example.com" } }),
				"/launch-dir/.claude.json:mtime": 2,
			}));
			assert.deepEqual(viaConfigDir, { id: "launch", label: "env@example.com" });
		} finally {
			if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
		}
	});

	it("falls back to the account's name when the file is missing, and never throws", () => {
		assert.deepEqual(acc.accountUsageIdentity(work, readers({})), { id: work.id, label: work.name });
	});

	it("falls back to the account's name when the file is malformed JSON", () => {
		const path = join(work.configDir, ".claude.json");
		assert.deepEqual(acc.accountUsageIdentity(work, readers({ [path]: "{ not json" })), { id: work.id, label: work.name });
	});

	it("falls back to the account's name when oauthAccount.emailAddress is missing", () => {
		const path = join(work.configDir, ".claude.json");
		assert.deepEqual(acc.accountUsageIdentity(work, readers({ [path]: JSON.stringify({ oauthAccount: {} }) })), { id: work.id, label: work.name });
	});

	it("caches by mtime, and picks up a re-sign-in once the mtime changes", () => {
		const path = join(work.configDir, ".claude.json");
		let reads = 0;
		const files = {
			[path]: JSON.stringify({ oauthAccount: { emailAddress: "first@example.com" } }),
			[`${path}:mtime`]: 100,
		};
		const countingReaders = {
			readFile: (p) => { reads++; return readers(files).readFile(p); },
			stat: (p) => readers(files).stat(p),
		};
		assert.deepEqual(acc.accountUsageIdentity(work, countingReaders), { id: work.id, label: "first@example.com" });
		assert.deepEqual(acc.accountUsageIdentity(work, countingReaders), { id: work.id, label: "first@example.com" });
		assert.equal(reads, 1, "same mtime: the cached label is reused without re-reading");

		files[path] = JSON.stringify({ oauthAccount: { emailAddress: "second@example.com" } });
		files[`${path}:mtime`] = 200;
		assert.deepEqual(acc.accountUsageIdentity(work, countingReaders), { id: work.id, label: "second@example.com" });
		assert.equal(reads, 2, "a new mtime re-reads and picks up the re-sign-in");
	});

	it("does not cache the name fallback when the file exists but fails to read or parse", () => {
		const path = join(work.configDir, ".claude.json");
		let reads = 0;
		const files = { [path]: "{ not json", [`${path}:mtime`]: 100 };
		const countingReaders = {
			readFile: (p) => { reads++; return readers(files).readFile(p); },
			stat: (p) => readers(files).stat(p),
		};
		assert.deepEqual(acc.accountUsageIdentity(work, countingReaders), { id: work.id, label: work.name });
		assert.deepEqual(acc.accountUsageIdentity(work, countingReaders), { id: work.id, label: work.name });
		assert.equal(reads, 2, "a parse failure is never cached: every call re-reads at the same mtime");

		files[path] = JSON.stringify({ oauthAccount: { emailAddress: "fixed@example.com" } });
		assert.deepEqual(acc.accountUsageIdentity(work, countingReaders), { id: work.id, label: "fixed@example.com" });
		assert.equal(reads, 3, "once the file parses, the email is read and can now be cached");
	});

	it("the real-filesystem default never reads the developer's actual ~/.claude.json in a unit test", () => {
		// tests/lib/setup.mjs points HOME at an empty temp dir for the whole suite, so the
		// launch account's real-filesystem default path resolves to a file that doesn't
		// exist, and accountUsageIdentity falls back to LAUNCH_ACCOUNT's own name rather
		// than the real machine's signed-in email. A reader-injected test cannot prove
		// this by itself: it has to call accountUsageIdentity with no readers at all.
		assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "CLAUDE_CONFIG_DIR must not point at a real config dir in tests");
		assert.equal(homedir(), process.env.HOME, "os.homedir() must follow setup.mjs's redirected HOME");
		assert.ok(homedir().includes(tmpdir()), "HOME must be a throwaway temp dir, not the developer's real home");
		assert.deepEqual(acc.accountUsageIdentity(acc.LAUNCH_ACCOUNT), { id: "launch", label: acc.LAUNCH_ACCOUNT.name });
	});
});

describe("active account change notifications", () => {
	const accountB = { id: "b1", name: "b", configDir: "/tmp/accounts/b1" };
	const accountC = { id: "c1", name: "c", configDir: "/tmp/accounts/c1" };

	it("notifies a listener only when the active account id actually changes", () => {
		const seen = [];
		const unsubscribe = acc.subscribeActiveAccountChange((account) => seen.push(account.id));
		try {
			acc.setActiveAccount(accountB);
			assert.deepEqual(seen, ["b1"]);
			acc.setActiveAccount({ ...accountB }); // same id, different object (e.g. a rename): not a switch
			assert.deepEqual(seen, ["b1"]);
			acc.setActiveAccount(accountC);
			assert.deepEqual(seen, ["b1", "c1"]);
		} finally {
			unsubscribe();
		}
	});

	it("a listener that throws does not stop the others from being notified", () => {
		const seen = [];
		const unsubscribeBad = acc.subscribeActiveAccountChange(() => { throw new Error("boom"); });
		const unsubscribeGood = acc.subscribeActiveAccountChange((account) => seen.push(account.id));
		try {
			assert.doesNotThrow(() => acc.setActiveAccount(accountB));
			assert.deepEqual(seen, ["b1"]);
		} finally {
			unsubscribeBad();
			unsubscribeGood();
		}
	});

	it("unsubscribe stops further notifications", () => {
		const seen = [];
		const unsubscribe = acc.subscribeActiveAccountChange((account) => seen.push(account.id));
		unsubscribe();
		acc.setActiveAccount(accountB);
		assert.deepEqual(seen, []);
	});
});

describe("signed-out text", () => {
	it("names the account for Claude Code's not-logged-in error", () => {
		assert.equal(acc.signedOutText("Not logged in · Please run /login", work), 'Claude account "work" is signed out. /claude-account to sign in again.');
	});
	it("recognizes Claude Code's other login failures, which end in 'Please run /login'", () => {
		for (const text of ["OAuth token revoked · Please run /login", "Invalid API key · Please run /login"]) {
			assert.equal(acc.signedOutText(text, work), 'Claude account "work" is signed out. /claude-account to sign in again.', text);
		}
	});
	it("recognizes the error when the SDK throws it with a prefix", () => {
		assert.ok(acc.signedOutText("Claude Code returned an error result: Not logged in · Please run /login", work));
	});
	it("leaves other errors alone", () => {
		assert.equal(acc.signedOutText("API Error: 500", work), undefined);
		assert.equal(acc.signedOutText("Claude rate limit (five_hour): You're out of extra usage", work), undefined);
	});
});
