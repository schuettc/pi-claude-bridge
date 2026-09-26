# Claude accounts (`/claude-account`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one pi install use several Claude subscription accounts, each signed in once and chosen per session from a `/claude-account` panel, with `pi-claude-bridge` as the only extension needed.

**Architecture:** A new `src/accounts.ts` owns the account registry, the process-wide active account (on `globalThis`) and one resolver, which every Claude Code child environment and every session-file call in `src/index.ts` goes through. Sign-in (`src/signin.ts`) runs `claude auth login` with an `open` stand-in that sends the browser through claude.ai's logout while keeping the sign-in request. `src/account-service.ts` holds the operations; `src/accounts-panel.ts` and `src/account-command.ts` are the UI over it.

**Tech Stack:** TypeScript (run by pi through tsx, no build step), `@earendil-works/pi-coding-agent` / `pi-tui` 0.87.1, `cc-session-io`, `@anthropic-ai/claude-agent-sdk` 0.3.280, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-25-claude-accounts-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Work on branch `feat/claude-accounts` in `pi-claude-bridge/.worktrees/claude-accounts`. Never push to `schuettc-publish`; never publish.
- Peer floor stays `@earendil-works/pi-coding-agent >=0.86.1`; develop against the installed 0.87.1.
- Verified against Claude Code 2.1.282 and Agent SDK 0.3.280.
- The sign-in `open` stand-in is macOS only (`/usr/bin/open`). Linux is out of scope.
- The bridge never reads, copies or stores a credential.
- Registry: `<pi agent dir>/claude-bridge/accounts.json`, written atomically, mode 0600. Account folders: `<pi agent dir>/claude-bridge/accounts/<id>/`, mode 0700. `configDir` is absolute and never moves.
- Launch account: id `launch`, name `default`, `configDir: null`. Its environment passes through untouched. Never set `CLAUDE_CONFIG_DIR` to `~/.claude` for it.
- Named account environment: sets `CLAUDE_CONFIG_DIR` and removes `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- `process.env` is never modified.
- Names match `^[a-z0-9][a-z0-9-]{0,31}$`, are unique, and exclude `add`, `list`, `remove` and `use`.
- Session entry: `customType` `claude-bridge-account`, data `{ id, name }`.
- Signed-out text, exactly: `Claude account "<name>" is signed out. /claude-account to sign in again.`
- Code style: tabs, `.js` import specifiers for local modules, `strict: false` tsconfig. Tests are `tests/unit-*.mjs` / `tests/int-*.mjs` with `node:test` and `node:assert/strict`.
- Commands: `npm run typecheck`, `npm run test:unit`. Both must pass at the end of every task.

## Review Focus

1. **Two panes change accounts at the same time:** each mutation reloads `accounts.json` just before writing, so one pane never wipes out an account another pane added. Test: Task 4, "a second service sees the first one's account before it writes".
2. **pi exits while `claude auth login` is waiting:** the login and its child processes are killed, and no port is left listening. Test: Task 3, "cancelAllSignins kills every running sign-in's process group".
3. **An account's login expires, or its folder is deleted outside pi:** the turn fails with the signed-out message naming that account. It never silently runs on another login. Test: Task 2, "names the signed-out account" and "a named account's child env keeps pointing at its folder".
4. **A session is resumed after its account was renamed or removed:** renamed → the same account, found by id. Removed → the default account plus a notice naming the old account. Test: Task 1, restore tests.
5. **Name collisions:** a new account named `default` (the launch account's name) or a subcommand word is rejected before any folder is made. Test: Task 1 `validateName` and Task 4 "rejects a duplicate name without creating a folder".

---

### Task 1: Accounts core (`src/accounts.ts`)

**Files:**
- Create: `src/accounts.ts`
- Test: `tests/unit-accounts.mjs`

**Interfaces:**
- Consumes: `getAgentDir` from `@earendil-works/pi-coding-agent`.
- Produces (all exported from `src/accounts.ts`):
  - Constants: `LAUNCH_ID = "launch"`, `ACCOUNT_ENTRY_TYPE = "claude-bridge-account"`, `RESERVED_NAMES`, `LAUNCH_ACCOUNT: Readonly<Account>`.
  - Types: `interface Account { id: string; name: string; configDir: string | null }`, `interface Registry { version: 1; default: string; accounts: Account[] }`, `interface LoadedRegistry { registry: Registry; problem?: string }`, `interface AccountEntryData { id: string; name: string }`.
  - Registry: `accountsRoot(agentDir?: string): string`, `registryPath(root: string): string`, `defaultRegistry(): Registry`, `loadRegistry(root: string): LoadedRegistry`, `saveRegistry(root: string, registry: Registry): void`.
  - Names and lookup: `validateName(name: string, registry: Registry, exceptId?: string): string | undefined` (a reason, or `undefined` when valid), `newAccountId(registry: Registry): string`, `byId(registry, id): Account | undefined`, `byName(registry, name): Account | undefined`.
  - Active account: `accountState(): { active: Account; restored: boolean }`, `getActiveAccount(): Account`, `setActiveAccount(account: Account): void`, `resetAccountStateForTest(): void`.
  - Resolver: `accountEnv(base: Record<string, string | undefined>, account: Account): Record<string, string | undefined>`, `accountClaudeDir(account: Account): string | undefined`.
  - Session and errors: `restoreAccount(entries: readonly { type: string; customType?: string; data?: unknown }[], registry: Registry): { account: Account; notice?: string }`, `signedOutText(text: string, account: Account): string | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit-accounts.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-accounts.mjs`
Expected: FAIL, `Cannot find module '../src/accounts.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/accounts.ts`:

```ts
// Several Claude subscription accounts in one pi install. This module owns the
// registry file, the process-wide active account, and the resolver that every
// Claude Code child environment and every session-file call goes through.
//
// Each account is a Claude Code config directory signed in with `claude auth
// login`. The launch account (id "launch") is the login pi was started with: its
// environment passes through untouched, because on macOS an unset
// CLAUDE_CONFIG_DIR and an explicit ~/.claude are different Keychain entries.
// Credentials never pass through this module.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const LAUNCH_ID = "launch";
export const ACCOUNT_ENTRY_TYPE = "claude-bridge-account";
// Subcommand words of /claude-account: an account with one of these names could
// not be switched to by name.
export const RESERVED_NAMES: readonly string[] = ["add", "list", "remove", "use"];
// An environment credential outranks a config directory's stored login, so a
// named account must not inherit one (verified in upstream PR #60).
const TOKEN_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Account {
	id: string;
	name: string;
	configDir: string | null;
}

export interface Registry {
	version: 1;
	default: string;
	accounts: Account[];
}

export interface LoadedRegistry {
	registry: Registry;
	problem?: string;
}

export interface AccountEntryData {
	id: string;
	name: string;
}

export const LAUNCH_ACCOUNT: Readonly<Account> = Object.freeze({ id: LAUNCH_ID, name: "default", configDir: null });

export function accountsRoot(agentDir = getAgentDir()): string {
	return join(agentDir, "claude-bridge");
}

export function registryPath(root: string): string {
	return join(root, "accounts.json");
}

export function defaultRegistry(): Registry {
	return { version: 1, default: LAUNCH_ID, accounts: [{ ...LAUNCH_ACCOUNT }] };
}

/** Read the registry. A missing file is the launch account alone; an unreadable
 *  one is the same, plus a problem the caller must report and must not overwrite. */
export function loadRegistry(root: string): LoadedRegistry {
	const path = registryPath(root);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { registry: defaultRegistry() };
		return { registry: defaultRegistry(), problem: `cannot read ${path}: ${(error as Error).message}` };
	}
	try {
		return { registry: parseRegistry(JSON.parse(text)) };
	} catch (error) {
		return { registry: defaultRegistry(), problem: `${path} is not a valid accounts file: ${(error as Error).message}` };
	}
}

function parseRegistry(raw: any): Registry {
	if (!raw || raw.version !== 1 || !Array.isArray(raw.accounts)) throw new Error("expected version 1 with an accounts list");
	const accounts: Account[] = [];
	for (const entry of raw.accounts) {
		if (typeof entry?.id !== "string" || typeof entry?.name !== "string") throw new Error("an account is missing its id or name");
		const launch = entry.id === LAUNCH_ID;
		if (launch ? entry.configDir !== null : typeof entry.configDir !== "string") {
			throw new Error(`account "${entry.name}": only the launch account has no configDir`);
		}
		accounts.push({ id: entry.id, name: entry.name, configDir: entry.configDir });
	}
	if (!accounts.some((a) => a.id === LAUNCH_ID)) accounts.unshift({ ...LAUNCH_ACCOUNT });
	const def = accounts.some((a) => a.id === raw.default) ? raw.default : LAUNCH_ID;
	return { version: 1, default: def, accounts };
}

/** Write atomically (temp file + rename) with mode 0600. */
export function saveRegistry(root: string, registry: Registry): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = registryPath(root);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** A reason the name is unusable, or undefined when it is fine. */
export function validateName(name: string, registry: Registry, exceptId?: string): string | undefined {
	if (!NAME_PATTERN.test(name)) return "use lowercase letters, digits and -, up to 32 characters, starting with a letter or digit";
	if (RESERVED_NAMES.includes(name)) return `"${name}" is reserved for a /claude-account subcommand`;
	if (registry.accounts.some((a) => a.name === name && a.id !== exceptId)) return `an account named "${name}" already exists`;
	return undefined;
}

export function newAccountId(registry: Registry): string {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (id !== LAUNCH_ID && !registry.accounts.some((a) => a.id === id)) return id;
	}
}

export function byId(registry: Registry, id: string): Account | undefined {
	return registry.accounts.find((a) => a.id === id);
}

export function byName(registry: Registry, name: string): Account | undefined {
	return registry.accounts.find((a) => a.name === name);
}

// One active account per pi process, on globalThis so every module copy (a
// subagent can load this module fresh) sees the same one.
const STATE_KEY = Symbol.for("pi-claude-bridge.accounts.v1");

interface AccountState {
	active: Account;
	// Whether a top-level session_start has applied a session's account yet. A
	// later "startup" is an in-process subagent session and must leave it alone.
	restored: boolean;
}

export function accountState(): AccountState {
	const g = globalThis as Record<symbol, AccountState | undefined>;
	return (g[STATE_KEY] ??= { active: LAUNCH_ACCOUNT, restored: false });
}

export function getActiveAccount(): Account {
	return accountState().active;
}

export function setActiveAccount(account: Account): void {
	accountState().active = account;
}

export function resetAccountStateForTest(): void {
	delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
}

/** The Claude Code child environment for an account. Never modifies `base`. */
export function accountEnv(base: Record<string, string | undefined>, account: Account): Record<string, string | undefined> {
	if (account.configDir === null) return base;
	const env: Record<string, string | undefined> = { ...base, CLAUDE_CONFIG_DIR: account.configDir };
	for (const key of TOKEN_VARS) delete env[key];
	return env;
}

/** The directory an account's Claude Code session files live under. */
export function accountClaudeDir(account: Account): string | undefined {
	return account.configDir ?? process.env.CLAUDE_CONFIG_DIR;
}

/** The account a session should run on: its latest account entry, else the default. */
export function restoreAccount(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
	registry: Registry,
): { account: Account; notice?: string } {
	const fallback = byId(registry, registry.default) ?? LAUNCH_ACCOUNT;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== ACCOUNT_ENTRY_TYPE) continue;
		const data = entry.data as Partial<AccountEntryData> | undefined;
		if (typeof data?.id !== "string") continue;
		const found = byId(registry, data.id);
		if (found) return { account: found };
		return { account: fallback, notice: `Account "${data.name ?? data.id}" no longer exists; using ${fallback.name}.` };
	}
	return { account: fallback };
}

/** Claude Code's not-logged-in error, restated with the account name. */
export function signedOutText(text: string, account: Account): string | undefined {
	return /^Not logged in\b/.test(text)
		? `Claude account "${account.name}" is signed out. /claude-account to sign in again.`
		: undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-accounts.mjs`
Expected: PASS, all tests.
Then run: `npm run typecheck && npm run test:unit`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/accounts.ts tests/unit-accounts.mjs
git commit -m "feat(accounts): registry, active account and resolver"
```

---

### Task 2: Route every Claude Code child and session file through the resolver (`src/index.ts`)

**Files:**
- Modify: `src/index.ts` (imports; `SessionState` ~L253; `readCarriedAttachments` ~L281; `resultErrorText` ~L474; `runIsolatedSummary` env ~L546; `verifyWrittenSession` ~L655/660; `debugSessionPaths` ~L684; `syncSharedSession` ~L712-800; `buildSideRequestSession` ~L816; `refreshClaudeUsage` query options ~L1198; `streamClaudeAgentSdk` ~L1947-2190; `promptAndWait` ~L2220-2290)
- Test: `tests/unit-account-routing.mjs`

**Interfaces:**
- Consumes (Task 1): `accountClaudeDir`, `accountEnv`, `getActiveAccount`, `signedOutText`, `Account`.
- Produces:
  - `SessionState` gains `claudeDir?: string`: the directory its session file lives under (`undefined` = the launch default).
  - `syncSharedSession(messages, cwd, customToolNameToSdk?, modelId?, claudeDir = accountClaudeDir(getActiveAccount()))`.
  - `buildSideRequestSession(priorMessages, cwd, customToolNameToSdk?, modelId?, claudeDir = accountClaudeDir(getActiveAccount()))`.
  - `resultErrorText` returns the signed-out text for Claude Code's not-logged-in error.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit-account-routing.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-account-routing.mjs`
Expected: FAIL. "rebuilds a new session in the new folder" fails because the session is reused; the usage-refresh env and signed-out tests fail.

- [ ] **Step 3: Implement**

All edits are in `src/index.ts`.

**3a. Import.** Next to the other local imports (e.g. after the `./usage-bus.js` import):

```ts
import { accountClaudeDir, accountEnv, getActiveAccount, signedOutText } from "./accounts.js";
```

**3b. `SessionState`.** Add as the last field:

```ts
	// The Claude Code config directory this session's file lives under
	// (undefined = the launch login's default). A turn under a different
	// account cannot resume it, so syncSharedSession rebuilds in the new one.
	claudeDir?: string;
```

**3c. `readCarriedAttachments`.** Replace the signature and the `openSession` call:

```ts
function readCarriedAttachments(sessionId: string, cwd: string, claudeDir: string | undefined): CarriedAttachment[] {
	try {
		const previous = openSession({ sessionId, projectPath: cwd, claudeDir });
```

**3d. `resultErrorText`.** Rename the existing function to `rawResultErrorText` (body unchanged), and add the wrapper immediately after it:

```ts
function resultErrorText(message: SDKMessage): string | undefined {
	const text = rawResultErrorText(message);
	return text === undefined ? undefined : signedOutText(text, getActiveAccount()) ?? text;
}
```

**3e. `runIsolatedSummary`.** Replace `env: stampedChildEnv(process.env, piSessionId),` with:

```ts
				env: accountEnv(stampedChildEnv(process.env, piSessionId), getActiveAccount()),
```

**3f. Diagnostics.** In `verifyWrittenSession`, replace `CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}` with `account=${getActiveAccount().name} CLAUDE_CONFIG_DIR=${accountClaudeDir(getActiveAccount()) ?? "(unset)"}`, and `claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null` with `claudeConfigDir: accountClaudeDir(getActiveAccount()) ?? null`. In `debugSessionPaths`, replace `env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}` with `account=${getActiveAccount().name} claudeDir=${accountClaudeDir(getActiveAccount()) ?? "(unset)"}`.

**3g. `syncSharedSession`.** Add the parameter:

```ts
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	claudeDir: string | undefined = accountClaudeDir(getActiveAccount()),
): SyncResult {
```

In the REUSE guard, add the directory check:

```ts
	if (sharedSession && !sharedSession.needsRebuild && sharedSession.claudeDir === claudeDir && priorMessages.length >= sharedSession.cursor) {
```

In the REUSE path's cursor update, keep the directory: `sharedSession = { ...sharedSession, cursor: priorMessages.length, cwd };` already spreads it, so no change there.

Replace the REBUILD block from `const previousSessionId = sharedSession?.sessionId;` through `sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };` with:

```ts
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	const previousDir = sharedSession?.claudeDir;
	// A session in another account's directory is left alone (another pane may
	// own it) and replaced by a new id here: rebuilding in place is only safe
	// within one directory.
	const sameDir = previousSessionId !== undefined && previousDir === claudeDir;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above — or
	// when the account changed.
	const preserveId = sameDir && !sharedSession?.forceRotate;
	// Before deleteSession — it wipes the file these live in.
	const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd, previousDir) : [];
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, claudeDir);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
	session.save();
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd);
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd, claudeDir };
```

Keep the `Case 2` / `Case 4` debug lines; change the final debug line's label so an account switch is visible in logs:

```ts
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : sameDir ? "rotated-post-abort" : "rotated-account"}`);
```

**3h. `buildSideRequestSession`.** Add the parameter and pass it:

```ts
function buildSideRequestSession(
	priorMessages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	claudeDir: string | undefined = accountClaudeDir(getActiveAccount()),
): string {
	const session = createSession({
		projectPath: cwd,
		claudeDir,
```

**3i. `refreshClaudeUsage`.** In the `dependencies.query({ ... options: { ... } })` call, replace `env: dependencies.env,` with:

```ts
				// The environment was captured at session start; the account can have
				// changed since, so apply the active one at each refresh.
				env: accountEnv(dependencies.env, getActiveAccount()),
```

**3j. `streamClaudeAgentSdk`.** Directly after `const cwd = process.cwd();` add:

```ts
	// The account is captured once per turn: a switch mid-turn applies from the next one.
	const account = getActiveAccount();
	const claudeDir = accountClaudeDir(account);
```

Then, inside the same function:
- `buildSideRequestSession(sidePriorMessages, cwd, customToolNameToSdk, cliModel)` → `buildSideRequestSession(sidePriorMessages, cwd, customToolNameToSdk, cliModel, claudeDir)`.
- `syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel)` → `syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, claudeDir)`.
- `const childEnv = stampedChildEnv(process.env, piSessionId);` → `const childEnv = accountEnv(stampedChildEnv(process.env, piSessionId), account);`.
- In the completion handler: `deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);` → `deleteSession(capturedSessionId, cwd, claudeDir);` and `sharedSession = { sessionId, cursor, cwd };` → `sharedSession = { sessionId, cursor, cwd, claudeDir };`.
- In `.finally`: `deleteSession(syncResult.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR)` → `deleteSession(syncResult.sessionId, cwd, claudeDir)`.

**3k. `promptAndWait` (AskClaude).** After `const cliModel = …;` add:

```ts
	const account = getActiveAccount();
	const claudeDir = accountClaudeDir(account);
```

Change `if (sharedSession) {` in the shared-mode block to `if (sharedSession && sharedSession.claudeDir === claudeDir) {` (a session in another account's folder cannot be resumed), change `syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, cliModel)` to `syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, cliModel, claudeDir)`, and `env: stampedChildEnv(process.env, piSessionId),` to `env: accountEnv(stampedChildEnv(process.env, piSessionId), account),`.

**3l. Check nothing was missed:**

Run: `grep -n "process.env.CLAUDE_CONFIG_DIR\|stampedChildEnv(process.env" src/index.ts`
Expected: only the `stampedChildEnv(process.env, …)` calls wrapped in `accountEnv(…)`, plus the usage-owner binding in `bindClaudeUsageAdapterOwner` (`env: stampedChildEnv(process.env, sessionId)`), which stays unwrapped because 3i applies the account at refresh time. No `process.env.CLAUDE_CONFIG_DIR` remains.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-account-routing.mjs tests/unit-sync-shared-session.mjs tests/unit-usage-bus.mjs tests/unit-child-env.mjs`
Expected: PASS.
Then: `npm run typecheck && npm run test:unit`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/unit-account-routing.mjs
git commit -m "feat(accounts): route child env and session files through the active account"
```

---

### Task 3: Browser sign-in (`src/signin.ts`)

**Files:**
- Create: `src/signin.ts`
- Test: `tests/unit-signin.mjs`

**Interfaces:**
- Consumes (Task 1): `accountEnv`, `Account`.
- Produces:
  - `rewriteSigninUrl(arg: string): string | undefined`.
  - `type SigninResult = { ok: true; rewritten: boolean } | { ok: false; reason: string; cancelled: boolean }`.
  - `interface SigninRun { readonly done: Promise<SigninResult>; cancel(): void }`.
  - `interface SigninOptions { claudeBin?: string; openBin?: string; baseEnv?: Record<string, string | undefined> }`.
  - `startSignin(account: Account, opts?: SigninOptions): SigninRun`.
  - `cancelAllSignins(): void`.
  - `interface AuthStatus { loggedIn: boolean; email?: string; subscriptionType?: string; problem?: string }`.
  - `readAuthStatus(account: Account, opts?: { claudeBin?: string; baseEnv?: Record<string, string | undefined> }): Promise<AuthStatus>`.
  - `signOut(account: Account, opts?: { claudeBin?: string; baseEnv?: Record<string, string | undefined> }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit-signin.mjs`:

```js
/**
 * Sign-in: `claude auth login` runs with an `open` stand-in that routes the browser
 * through claude.ai's logout while keeping this run's sign-in request. Fake `claude`
 * and fake `open` scripts stand in for the real ones; no browser opens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const signin = await import("../src/signin.js");

const LAUNCH = { id: "launch", name: "default", configDir: null };
const QUERY = "code=true&client_id=9d1c&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54704%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=abc-_123&code_challenge_method=S256&state=w2H-3q";

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), "signin-test-"));
	const script = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };
	const opened = join(dir, "opened");
	const openBin = script("fake-open", `printf '%s\\n' "$@" > "${opened}"`);
	return { dir, script, opened, openBin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitUntil(check, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
	throw new Error("condition not met in time");
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("rewriteSigninUrl", () => {
	for (const origin of ["https://claude.com/cai", "https://claude.ai"]) {
		it(`sends ${origin} sign-in through logout, keeping the query byte for byte`, () => {
			const out = signin.rewriteSigninUrl(`${origin}/oauth/authorize?${QUERY}`);
			assert.ok(out.startsWith("https://claude.ai/logout?returnTo="));
			const returnTo = decodeURIComponent(out.slice("https://claude.ai/logout?returnTo=".length));
			assert.equal(returnTo, `/oauth/authorize?${QUERY}`);
		});
	}
	it("leaves anything else alone", () => {
		for (const other of ["https://example.com/", "http://claude.ai/oauth/authorize?x=1", "https://claude.ai/login?x=1", "-a"]) {
			assert.equal(signin.rewriteSigninUrl(other), undefined, other);
		}
	});
});

describe("startSignin", () => {
	it("opens the logout URL for a sign-in URL and reports success", async () => {
		const s = sandbox();
		try {
			const claudeBin = s.script("claude", `open "https://claude.com/cai/oauth/authorize?${QUERY}"\necho "Login successful."`);
			const result = await signin.startSignin(LAUNCH, { claudeBin, openBin: s.openBin }).done;
			assert.deepEqual(result, { ok: true, rewritten: true });
			assert.equal(readFileSync(s.opened, "utf8").trim(), signin.rewriteSigninUrl(`https://claude.com/cai/oauth/authorize?${QUERY}`));
		} finally { s.cleanup(); }
	});

	it("passes other URLs through and says so", async () => {
		const s = sandbox();
		try {
			const claudeBin = s.script("claude", `open "https://example.com/"`);
			const result = await signin.startSignin(LAUNCH, { claudeBin, openBin: s.openBin }).done;
			assert.deepEqual(result, { ok: true, rewritten: false });
			assert.equal(readFileSync(s.opened, "utf8").trim(), "https://example.com/");
		} finally { s.cleanup(); }
	});

	it("reports a failure with Claude Code's last line", async () => {
		const s = sandbox();
		try {
			const claudeBin = s.script("claude", `echo "Paste code here if prompted >"\necho "OAuth error: invalid_grant" >&2\nexit 1`);
			const result = await signin.startSignin(LAUNCH, { claudeBin, openBin: s.openBin }).done;
			assert.deepEqual(result, { ok: false, reason: "OAuth error: invalid_grant", cancelled: false });
		} finally { s.cleanup(); }
	});

	it("runs a named account's login in its folder without inherited credentials", async () => {
		const s = sandbox();
		try {
			const seen = join(s.dir, "seen");
			const claudeBin = s.script("claude", `printf '%s|%s' "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" > "${seen}"`);
			const account = { id: "b1", name: "work", configDir: join(s.dir, "acct") };
			await signin.startSignin(account, { claudeBin, openBin: s.openBin, baseEnv: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "t" } }).done;
			assert.equal(readFileSync(seen, "utf8"), `${account.configDir}|unset`);
		} finally { s.cleanup(); }
	});

	it("cancel kills the whole process group and removes the stand-in", async () => {
		const s = sandbox();
		try {
			const pidFile = join(s.dir, "pid");
			const claudeBin = s.script("claude", `sleep 60 &\necho $! > "${pidFile}"\nwait`);
			const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("claude-bridge-signin-")));
			const run = signin.startSignin(LAUNCH, { claudeBin, openBin: s.openBin });
			await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
			const grandchild = Number(readFileSync(pidFile, "utf8"));
			run.cancel();
			assert.deepEqual(await run.done, { ok: false, reason: "cancelled", cancelled: true });
			await waitUntil(() => !alive(grandchild));
			const after = readdirSync(tmpdir()).filter((n) => n.startsWith("claude-bridge-signin-") && !before.has(n));
			assert.deepEqual(after, [], "the stand-in directory is removed");
		} finally { s.cleanup(); }
	});

	it("cancelAllSignins kills every running sign-in's process group", async () => {
		const s = sandbox();
		try {
			const pidFile = join(s.dir, "pid");
			const claudeBin = s.script("claude", `sleep 60 &\necho $! > "${pidFile}"\nwait`);
			const run = signin.startSignin(LAUNCH, { claudeBin, openBin: s.openBin });
			await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
			const grandchild = Number(readFileSync(pidFile, "utf8"));
			signin.cancelAllSignins();
			assert.equal((await run.done).cancelled, true);
			await waitUntil(() => !alive(grandchild));
		} finally { s.cleanup(); }
	});
});

describe("readAuthStatus and signOut", () => {
	it("reads a signed-in status", async () => {
		const s = sandbox();
		try {
			const claudeBin = s.script("claude", `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.io","subscriptionType":"max"}'`);
			assert.deepEqual(await signin.readAuthStatus(LAUNCH, { claudeBin }), { loggedIn: true, email: "a@b.io", subscriptionType: "max" });
		} finally { s.cleanup(); }
	});
	it("treats a non-zero exit with loggedIn:false as signed out", async () => {
		const s = sandbox();
		try {
			const claudeBin = s.script("claude", `echo '{"loggedIn":false}'\nexit 1`);
			assert.equal((await signin.readAuthStatus(LAUNCH, { claudeBin })).loggedIn, false);
		} finally { s.cleanup(); }
	});
	it("reports unreadable output as a problem", async () => {
		const s = sandbox();
		try {
			const claudeBin = s.script("claude", `echo nope`);
			const status = await signin.readAuthStatus(LAUNCH, { claudeBin });
			assert.equal(status.loggedIn, false);
			assert.ok(status.problem);
		} finally { s.cleanup(); }
	});
	it("signOut runs `claude auth logout` in the account's folder", async () => {
		const s = sandbox();
		try {
			const seen = join(s.dir, "seen");
			const claudeBin = s.script("claude", `printf '%s %s|%s' "$1" "$2" "$CLAUDE_CONFIG_DIR" > "${seen}"`);
			await signin.signOut({ id: "b1", name: "work", configDir: "/tmp/acct-b1" }, { claudeBin });
			assert.equal(readFileSync(seen, "utf8"), "auth logout|/tmp/acct-b1");
		} finally { s.cleanup(); }
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-signin.mjs`
Expected: FAIL, `Cannot find module '../src/signin.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/signin.ts`:

```ts
// Browser sign-in for one account, and reading its login state.
//
// `claude auth login` opens its sign-in page by running `open <url>`. Its PATH
// gets a per-run directory holding an `open` stand-in, which sends a sign-in URL
// through claude.ai's logout with the request attached:
// https://claude.ai/logout?returnTo=/oauth/authorize?<query>. Anthropic's own
// "Switch account" button drops the request, and the browser is usually signed
// in to a different account than the one being added. See the spec, "Why
// switching accounts failed, and the fix".
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEnv, type Account } from "./accounts.js";

type Env = Record<string, string | undefined>;

// Self-contained on purpose: its source is copied into the stand-in script.
export function rewriteSigninUrl(arg: string): string | undefined {
	const match = /^https:\/\/(?:claude\.com\/cai|claude\.ai)\/oauth\/authorize\?([\s\S]*)$/.exec(arg);
	if (!match) return undefined;
	return `https://claude.ai/logout?returnTo=${encodeURIComponent(`/oauth/authorize?${match[1]}`)}`;
}

export type SigninResult = { ok: true; rewritten: boolean } | { ok: false; reason: string; cancelled: boolean };

export interface SigninRun {
	readonly done: Promise<SigninResult>;
	cancel(): void;
}

export interface SigninOptions {
	claudeBin?: string;
	openBin?: string;
	baseEnv?: Env;
}

export interface AuthStatus {
	loggedIn: boolean;
	email?: string;
	subscriptionType?: string;
	problem?: string;
}

// Running sign-ins, shared by every module copy, so pi exiting stops them all.
const RUNNING_KEY = Symbol.for("pi-claude-bridge.signin-running.v1");
const g = globalThis as Record<symbol, unknown>;
const running = (g[RUNNING_KEY] ??= new Set<SigninRun>()) as Set<SigninRun>;
const EXIT_HOOK_KEY = Symbol.for("pi-claude-bridge.signin-exit-hook.v1");
if (!g[EXIT_HOOK_KEY]) {
	g[EXIT_HOOK_KEY] = true;
	process.on("exit", () => cancelAllSignins());
}

export function cancelAllSignins(): void {
	for (const run of [...running]) run.cancel();
}

function standInSource(openBin: string): string {
	return [
		`#!${process.execPath}`,
		`"use strict";`,
		`const { spawnSync } = require("node:child_process");`,
		`const { appendFileSync } = require("node:fs");`,
		`const rewriteSigninUrl = ${rewriteSigninUrl.toString()};`,
		`const args = process.argv.slice(2);`,
		`const out = args.map((a) => rewriteSigninUrl(a) ?? a);`,
		`appendFileSync(process.env.CLAUDE_BRIDGE_SIGNIN_LOG, JSON.stringify({ rewritten: out.some((a, i) => a !== args[i]) }) + "\\n");`,
		`const result = spawnSync(${JSON.stringify(openBin)}, out, { stdio: "inherit" });`,
		`process.exit(result.status ?? 1);`,
		``,
	].join("\n");
}

function lastLine(output: string): string | undefined {
	return output
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("Paste code here"))
		.pop();
}

/** Start `claude auth login` for an account. Resolves when it exits or is cancelled. */
export function startSignin(account: Account, opts: SigninOptions = {}): SigninRun {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-signin-"));
	const log = join(dir, "open.log");
	// The stand-in is CommonJS; this keeps a package.json further up from saying otherwise.
	writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
	writeFileSync(join(dir, "open"), standInSource(opts.openBin ?? "/usr/bin/open"), { mode: 0o700 });
	const base = opts.baseEnv ?? process.env;
	const env: Env = { ...accountEnv(base, account), PATH: `${dir}:${base.PATH ?? ""}`, CLAUDE_BRIDGE_SIGNIN_LOG: log };
	// Claude Code would use $BROWSER instead of `open`, bypassing the stand-in.
	delete env.BROWSER;

	let output = "";
	let cancelled = false;
	// detached: its own process group, so cancel() also stops what it started.
	const child = spawn(opts.claudeBin ?? "claude", ["auth", "login", "--claudeai"], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	const keep = (data: Buffer) => { output = (output + data.toString()).slice(-4000); };
	child.stdout?.on("data", keep);
	child.stderr?.on("data", keep);

	const run: SigninRun = {
		done: new Promise<SigninResult>((resolve) => {
			let settled = false;
			const finish = (result: SigninResult) => {
				if (settled) return;
				settled = true;
				running.delete(run);
				rmSync(dir, { recursive: true, force: true });
				resolve(result);
			};
			child.on("error", (error) => finish({ ok: false, reason: error.message, cancelled: false }));
			child.on("exit", (code, signal) => {
				const rewritten = existsSync(log) && readFileSync(log, "utf8").includes('"rewritten":true');
				if (cancelled) finish({ ok: false, reason: "cancelled", cancelled: true });
				else if (code === 0) finish({ ok: true, rewritten });
				else finish({ ok: false, reason: lastLine(output) ?? `claude auth login exited with ${code ?? signal}`, cancelled: false });
			});
		}),
		cancel() {
			cancelled = true;
			if (child.pid !== undefined) {
				try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
			}
		},
	};
	running.add(run);
	return run;
}

export function readAuthStatus(account: Account, opts: { claudeBin?: string; baseEnv?: Env } = {}): Promise<AuthStatus> {
	return new Promise((resolve) => {
		execFile(
			opts.claudeBin ?? "claude",
			["auth", "status", "--json"],
			{ env: accountEnv(opts.baseEnv ?? process.env, account), timeout: 15_000 },
			(error, stdout) => {
				try {
					const status = JSON.parse(stdout);
					resolve({
						loggedIn: status.loggedIn === true,
						...(typeof status.email === "string" ? { email: status.email } : {}),
						...(typeof status.subscriptionType === "string" ? { subscriptionType: status.subscriptionType } : {}),
					});
				} catch {
					resolve({ loggedIn: false, problem: error ? error.message : "unreadable `claude auth status` output" });
				}
			},
		);
	});
}

export function signOut(account: Account, opts: { claudeBin?: string; baseEnv?: Env } = {}): Promise<void> {
	return new Promise((resolve) => {
		execFile(opts.claudeBin ?? "claude", ["auth", "logout"], { env: accountEnv(opts.baseEnv ?? process.env, account), timeout: 15_000 }, () => resolve());
	});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-signin.mjs`
Expected: PASS.
If "opens the logout URL" fails because the stand-in's `rewriteSigninUrl` source does not run under plain node (tsx output can differ), print it with `node --import tsx -e 'import("./src/signin.ts").then(m => console.log(m.rewriteSigninUrl.toString()))'` and fix the function so its transpiled source is plain JavaScript with no helper references. Do not replace the approach.
Then: `npm run typecheck && npm run test:unit`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/signin.ts tests/unit-signin.mjs
git commit -m "feat(accounts): browser sign-in through claude.ai logout; auth status"
```

---

### Task 4: Account operations (`src/account-service.ts`)

**Files:**
- Create: `src/account-service.ts`
- Test: `tests/unit-account-service.mjs`

**Interfaces:**
- Consumes (Task 1): `Account`, `LoadedRegistry`, `Registry`, `LAUNCH_ID`, `byName`, `byId`, `getActiveAccount`, `loadRegistry`, `newAccountId`, `saveRegistry`, `setActiveAccount`, `validateName`. (Task 3): `AuthStatus`, `SigninRun`.
- Produces:
  - `type Result<T> = { ok: true; value: T } | { ok: false; reason: string }`.
  - `interface SigninOutcome { status: AuthStatus; rewritten: boolean }`.
  - `interface AccountServiceDeps { root: string; startSignin(account: Account): SigninRun; readStatus(account: Account): Promise<AuthStatus>; signOut(account: Account): Promise<void>; onSwitch(account: Account): void; onChange(): void }`.
  - `class AccountService` with:
    - `load(): LoadedRegistry` and `active(): Account`.
    - `switchTo(name: string): Result<Account>`, `setDefault(name: string): Result<Account>`, `rename(name: string, next: string): Result<Account>`.
    - `remove(name: string): Promise<Result<{ switchedTo?: Account }>>`.
    - `add(name: string, onStart?: (run: SigninRun) => void): Promise<Result<{ account: Account } & SigninOutcome>>`.
    - `signInAgain(name: string, onStart?: (run: SigninRun) => void): Promise<Result<SigninOutcome>>`.
  - Failure reasons: a cancelled sign-in returns `reason: "cancelled"`; other sign-in failures start with `Sign-in didn't finish: `.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit-account-service.mjs`:

```js
/**
 * Account operations over the registry file, with sign-in and status stubbed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acc = await import("../src/accounts.js");
const { AccountService } = await import("../src/account-service.js");

let root, log;

function makeService(over = {}) {
	return new AccountService({
		root,
		startSignin: () => ({ done: Promise.resolve({ ok: true, rewritten: true }), cancel() {} }),
		readStatus: async () => ({ loggedIn: true, email: "court@subaud.io", subscriptionType: "max" }),
		signOut: async (a) => { log.push(["signOut", a.name]); },
		onSwitch: (a) => log.push(["switch", a.name]),
		onChange: () => log.push(["change"]),
		...over,
	});
}
const accountDirs = () => existsSync(join(root, "accounts")) ? readdirSync(join(root, "accounts")) : [];

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "account-service-")); log = []; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); acc.resetAccountStateForTest(); });

describe("add", () => {
	it("signs in, then saves the account with an absolute folder under accounts/<id>", async () => {
		const r = await makeService().add("work");
		assert.equal(r.ok, true);
		const { account, status, rewritten } = r.value;
		assert.equal(account.configDir, join(root, "accounts", account.id));
		assert.equal(statSync(account.configDir).mode & 0o777, 0o700);
		assert.deepEqual(status, { loggedIn: true, email: "court@subaud.io", subscriptionType: "max" });
		assert.equal(rewritten, true);
		assert.deepEqual(acc.loadRegistry(root).registry.accounts.map((a) => a.name), ["default", "work"]);
		assert.equal(statSync(acc.registryPath(root)).mode & 0o777, 0o600);
		assert.deepEqual(log, [["change"]]);
	});

	it("runs sign-in against the new account and hands the run to the caller", async () => {
		let seen, handed;
		const run = { done: Promise.resolve({ ok: true, rewritten: true }), cancel() {} };
		await makeService({ startSignin: (a) => { seen = a; return run; } }).add("work", (r) => { handed = r; });
		assert.equal(seen.name, "work");
		assert.equal(handed, run);
	});

	it("rejects a duplicate name without creating a folder or signing in", async () => {
		let started = false;
		const r = await makeService({ startSignin: () => { started = true; } }).add("default");
		assert.equal(r.ok, false);
		assert.match(r.reason, /already exists/);
		assert.equal(started, false);
		assert.deepEqual(accountDirs(), []);
	});

	it("a failed sign-in removes the folder and saves nothing", async () => {
		const r = await makeService({ startSignin: () => ({ done: Promise.resolve({ ok: false, reason: "boom", cancelled: false }), cancel() {} }) }).add("work");
		assert.deepEqual(r, { ok: false, reason: "Sign-in didn't finish: boom" });
		assert.deepEqual(accountDirs(), []);
		assert.equal(existsSync(acc.registryPath(root)), false);
	});

	it("a cancelled sign-in says cancelled", async () => {
		const r = await makeService({ startSignin: () => ({ done: Promise.resolve({ ok: false, reason: "cancelled", cancelled: true }), cancel() {} }) }).add("work");
		assert.deepEqual(r, { ok: false, reason: "cancelled" });
	});

	it("a sign-in that leaves no login fails and cleans up", async () => {
		const r = await makeService({ readStatus: async () => ({ loggedIn: false }) }).add("work");
		assert.equal(r.ok, false);
		assert.match(r.reason, /^Sign-in didn't finish/);
		assert.deepEqual(accountDirs(), []);
	});

	it("a second service sees the first one's account before it writes", async () => {
		const paneA = makeService(), paneB = makeService();
		await paneA.add("work");
		assert.equal((await paneB.add("personal")).ok, true);
		assert.deepEqual(acc.loadRegistry(root).registry.accounts.map((a) => a.name), ["default", "work", "personal"]);
	});

	it("refuses every change while the accounts file is unreadable, leaving it untouched", async () => {
		writeFileSync(acc.registryPath(root), "{ broken");
		const service = makeService();
		for (const r of [await service.add("work"), service.setDefault("default"), service.rename("default", "home")]) {
			assert.equal(r.ok, false);
			assert.match(r.reason, /accounts file/);
		}
		assert.equal(readFileSync(acc.registryPath(root), "utf8"), "{ broken");
	});
});

describe("switch, default, rename", () => {
	it("switches this session and reports it", async () => {
		const service = makeService();
		await service.add("work");
		const r = service.switchTo("work");
		assert.equal(r.ok, true);
		assert.equal(acc.getActiveAccount().name, "work");
		assert.deepEqual(log.at(-1), ["switch", "work"]);
	});

	it("an unknown name fails", () => {
		assert.deepEqual(makeService().switchTo("nope"), { ok: false, reason: 'No account named "nope".' });
	});

	it("stores the default by id", async () => {
		const service = makeService();
		const { value } = await service.add("work");
		assert.equal(service.setDefault("work").ok, true);
		assert.equal(acc.loadRegistry(root).registry.default, value.account.id);
	});

	it("renaming keeps the id and folder, and updates the active account", async () => {
		const service = makeService();
		const { value } = await service.add("work");
		service.switchTo("work");
		assert.equal(service.rename("work", "job").ok, true);
		const renamed = acc.byId(acc.loadRegistry(root).registry, value.account.id);
		assert.deepEqual(renamed, { ...value.account, name: "job" });
		assert.equal(acc.getActiveAccount().name, "job");
	});

	it("renaming validates the new name", async () => {
		const service = makeService();
		await service.add("work");
		assert.match(service.rename("work", "default").reason, /already exists/);
	});
});

describe("remove", () => {
	it("refuses the launch account", async () => {
		const r = await makeService().remove("default");
		assert.equal(r.ok, false);
		assert.match(r.reason, /rename it instead/);
	});

	it("signs out, deletes the folder, resets the default and moves this session", async () => {
		const service = makeService();
		const { value } = await service.add("work");
		service.setDefault("work");
		service.switchTo("work");
		const r = await service.remove("work");
		assert.equal(r.ok, true);
		assert.equal(r.value.switchedTo.id, "launch");
		assert.equal(existsSync(value.account.configDir), false);
		assert.equal(acc.loadRegistry(root).registry.default, "launch");
		assert.equal(acc.getActiveAccount().id, "launch");
		assert.ok(log.some((e) => e[0] === "signOut" && e[1] === "work"));
		assert.deepEqual(log.at(-1), ["switch", "default"]);
	});
});

describe("signInAgain", () => {
	it("signs an existing account in without changing the registry", async () => {
		const service = makeService();
		await service.add("work");
		const before = readFileSync(acc.registryPath(root), "utf8");
		const r = await service.signInAgain("work");
		assert.equal(r.ok, true);
		assert.equal(readFileSync(acc.registryPath(root), "utf8"), before);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-account-service.mjs`
Expected: FAIL, `Cannot find module '../src/account-service.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/account-service.ts`:

```ts
// Account operations shared by the /claude-account panel and its subcommands.
// Every change reloads accounts.json just before writing it, so two panes
// editing accounts do not overwrite each other's additions.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	byId,
	byName,
	getActiveAccount,
	LAUNCH_ACCOUNT,
	LAUNCH_ID,
	loadRegistry,
	newAccountId,
	saveRegistry,
	setActiveAccount,
	validateName,
	type Account,
	type LoadedRegistry,
	type Registry,
} from "./accounts.js";
import type { AuthStatus, SigninRun } from "./signin.js";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SigninOutcome {
	status: AuthStatus;
	rewritten: boolean;
}

export interface AccountServiceDeps {
	root: string;
	startSignin(account: Account): SigninRun;
	readStatus(account: Account): Promise<AuthStatus>;
	signOut(account: Account): Promise<void>;
	/** This session now uses `account`: record it and refresh the footer. */
	onSwitch(account: Account): void;
	/** The accounts changed in a way the footer may show. */
	onChange(): void;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });

export class AccountService {
	#deps: AccountServiceDeps;

	constructor(deps: AccountServiceDeps) {
		this.#deps = deps;
	}

	load(): LoadedRegistry {
		return loadRegistry(this.#deps.root);
	}

	active(): Account {
		return getActiveAccount();
	}

	switchTo(name: string): Result<Account> {
		const account = byName(this.load().registry, name);
		if (!account) return fail(`No account named "${name}".`);
		setActiveAccount(account);
		this.#deps.onSwitch(account);
		return ok(account);
	}

	setDefault(name: string): Result<Account> {
		return this.#mutate<Account>((registry) => {
			const account = byName(registry, name);
			if (!account) return fail<Account>(`No account named "${name}".`);
			registry.default = account.id;
			return ok(account);
		});
	}

	rename(name: string, next: string): Result<Account> {
		const result = this.#mutate((registry) => {
			const account = byName(registry, name);
			if (!account) return fail<Account>(`No account named "${name}".`);
			const problem = validateName(next, registry, account.id);
			if (problem) return fail<Account>(`Not renamed: ${problem}.`);
			account.name = next;
			return ok(account);
		});
		if (result.ok) {
			if (getActiveAccount().id === result.value.id) setActiveAccount(result.value);
			this.#deps.onChange();
		}
		return result;
	}

	async remove(name: string): Promise<Result<{ switchedTo?: Account }>> {
		const { registry, problem } = this.load();
		if (problem) return fail(`The accounts file has a problem, so nothing was changed: ${problem}`);
		const account = byName(registry, name);
		if (!account) return fail(`No account named "${name}".`);
		if (account.id === LAUNCH_ID) return fail("The login pi started with can't be removed; rename it instead.");
		await this.#deps.signOut(account);
		const saved = this.#mutate<Registry>((current) => {
			current.accounts = current.accounts.filter((a) => a.id !== account.id);
			if (current.default === account.id) current.default = LAUNCH_ID;
			return ok(current);
		});
		if (!saved.ok) return saved;
		rmSync(account.configDir!, { recursive: true, force: true });
		let switchedTo: Account | undefined;
		if (getActiveAccount().id === account.id) {
			switchedTo = byId(saved.value, saved.value.default) ?? { ...LAUNCH_ACCOUNT };
			setActiveAccount(switchedTo);
			this.#deps.onSwitch(switchedTo);
		} else {
			this.#deps.onChange();
		}
		return ok({ switchedTo });
	}

	async add(name: string, onStart?: (run: SigninRun) => void): Promise<Result<{ account: Account } & SigninOutcome>> {
		const { registry, problem } = this.load();
		if (problem) return fail(`The accounts file has a problem, so nothing was changed: ${problem}`);
		const invalid = validateName(name, registry);
		if (invalid) return fail(`Not added: ${invalid}.`);
		const id = newAccountId(registry);
		const configDir = join(this.#deps.root, "accounts", id);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const account: Account = { id, name, configDir };
		const signedIn = await this.#signIn(account, onStart);
		if (!signedIn.ok) {
			rmSync(configDir, { recursive: true, force: true });
			return signedIn;
		}
		const saved = this.#mutate<undefined>((current) => {
			const again = validateName(name, current);
			if (again) return fail<undefined>(`Not added: ${again}.`);
			current.accounts.push(account);
			return ok(undefined);
		});
		if (!saved.ok) {
			await this.#deps.signOut(account);
			rmSync(configDir, { recursive: true, force: true });
			return saved;
		}
		this.#deps.onChange();
		return ok({ account, ...signedIn.value });
	}

	async signInAgain(name: string, onStart?: (run: SigninRun) => void): Promise<Result<SigninOutcome>> {
		const account = byName(this.load().registry, name);
		if (!account) return fail(`No account named "${name}".`);
		return this.#signIn(account, onStart);
	}

	async #signIn(account: Account, onStart?: (run: SigninRun) => void): Promise<Result<SigninOutcome>> {
		const run = this.#deps.startSignin(account);
		onStart?.(run);
		const result = await run.done;
		if (!result.ok) return fail(result.cancelled ? "cancelled" : `Sign-in didn't finish: ${result.reason}`);
		const status = await this.#deps.readStatus(account);
		if (!status.loggedIn) return fail(`Sign-in didn't finish: ${status.problem ?? "Claude Code reports no login for this account"}`);
		return ok({ status, rewritten: result.rewritten });
	}

	#mutate<T>(change: (registry: Registry) => Result<T>): Result<T> {
		const { registry, problem } = this.load();
		if (problem) return fail(`The accounts file has a problem, so nothing was changed: ${problem}`);
		const result = change(registry);
		if (result.ok) saveRegistry(this.#deps.root, registry);
		return result;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-account-service.mjs`
Expected: PASS.
Then: `npm run typecheck && npm run test:unit`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/account-service.ts tests/unit-account-service.mjs
git commit -m "feat(accounts): add, switch, default, rename, remove, sign in again"
```

---

### Task 5: The panel (`src/panel-box.ts`, `src/accounts-panel.ts`)

**Files:**
- Create: `src/panel-box.ts` (a copy of `renderBox` from `pi-extensions/packages/pi-typesafe-ai/src/panel.ts`)
- Create: `src/accounts-panel.ts`
- Test: `tests/unit-accounts-panel.mjs`

**Interfaces:**
- Consumes (Task 1): `Account`, `LAUNCH_ID`. (Task 3): `AuthStatus`, `SigninRun`. (Task 4): `AccountService`, `Result`.
- Produces:
  - `panel-box.ts`: `BOX_WIDTH = 56`, `PADDING = 2`, `interface PanelTheme`, `renderBox(opts: { title: string; body: string[]; footer: string; width: number; theme: PanelTheme }): string[]`.
  - `accounts-panel.ts`: `class AccountsPanel implements Component`, whose constructor takes `AccountsPanelOptions { service: Pick<AccountService, "load" | "active" | "switchTo" | "setDefault" | "rename" | "remove" | "add" | "signInAgain">; readStatus(account: Account): Promise<AuthStatus>; theme: PanelTheme; requestRender(): void; onClose(): void }`, and exposes `idle(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit-accounts-panel.mjs`:

```js
/**
 * The /claude-account panel, driven by keys against a fake service.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

const { AccountsPanel } = await import("../src/accounts-panel.js");
const { BOX_WIDTH, renderBox } = await import("../src/panel-box.js");

const plain = { fg: (_c, t) => t, bold: (t) => t };
const ENTER = "\r", ESC = "\x1b", DOWN = "\x1b[B", UP = "\x1b[A";
const LAUNCH = { id: "launch", name: "default", configDir: null };
const WORK = { id: "a1b2c3d4", name: "work", configDir: "/tmp/accounts/a1b2c3d4" };

function fakeService({ accounts = [LAUNCH, WORK], defaultId = "launch", activeId = "launch" } = {}) {
	const state = { registry: { version: 1, default: defaultId, accounts: accounts.map((a) => ({ ...a })) }, active: null, calls: [] };
	state.active = state.registry.accounts.find((a) => a.id === activeId);
	const find = (name) => state.registry.accounts.find((a) => a.name === name);
	state.service = {
		load: () => ({ registry: structuredClone(state.registry) }),
		active: () => state.active,
		switchTo(name) { state.calls.push(["switchTo", name]); state.active = find(name); return { ok: true, value: state.active }; },
		setDefault(name) { state.calls.push(["setDefault", name]); state.registry.default = find(name).id; return { ok: true, value: find(name) }; },
		rename(name, next) { state.calls.push(["rename", name, next]); if (next === "bad!") return { ok: false, reason: "Not renamed: bad name." }; find(name).name = next; return { ok: true, value: find(next) }; },
		async remove(name) { state.calls.push(["remove", name]); state.registry.accounts = state.registry.accounts.filter((a) => a.name !== name); return { ok: true, value: {} }; },
		add: async () => ({ ok: false, reason: "not stubbed" }),
		signInAgain: async () => ({ ok: false, reason: "not stubbed" }),
	};
	return state;
}

async function open(state, statuses = {}) {
	let closed = false;
	const panel = new AccountsPanel({
		service: state.service,
		readStatus: async (a) => statuses[a.id] ?? { loggedIn: true, email: `${a.name}@example.com`, subscriptionType: "max" },
		theme: plain,
		requestRender: () => {},
		onClose: () => { closed = true; },
	});
	await panel.idle();
	const screen = (width = 100) => panel.render(width).join("\n");
	const press = async (...keys) => { for (const k of keys) { panel.handleInput(k); await panel.idle(); } };
	return { panel, screen, press, isClosed: () => closed };
}

describe("frame", () => {
	it("renderBox draws an exact-width rounded frame", () => {
		for (const width of [120, BOX_WIDTH, 40]) {
			const lines = renderBox({ title: "🔑 claude · accounts", body: ["x".repeat(200)], footer: "esc close", width, theme: plain });
			for (const line of lines) assert.equal(visibleWidth(line), Math.min(BOX_WIDTH, width));
			assert.ok(lines[0].startsWith("╭") && lines.at(-1).startsWith("╰"));
		}
	});

	it("every panel line is the box width, and the height is the same in every mode", async () => {
		const state = fakeService();
		const { panel, press } = await open(state);
		const heights = new Set();
		const check = () => {
			const lines = panel.render(120);
			for (const line of lines) assert.equal(visibleWidth(line), BOX_WIDTH, JSON.stringify(line));
			heights.add(lines.length);
		};
		check();
		await press(DOWN, DOWN, ENTER); check();       // name field
		await press(ESC, UP, "r"); check();              // rename field
		await press(ESC, "x"); check();                  // confirm remove
		assert.equal(heights.size, 1, `heights: ${[...heights]}`);
	});
});

describe("rows", () => {
	it("marks the active and default accounts and shows email and plan", async () => {
		const { screen } = await open(fakeService({ defaultId: WORK.id }));
		const text = screen();
		assert.match(text, /→ default\s+●\s+default@example\.com · Max/);
		assert.match(text, /work\s+work@example\.com · Max\s+default/);
		assert.match(text, /\+ Add account/);
		assert.match(text, /↑↓ select · enter use · d default · esc close/);
	});

	it("shows a signed-out account as signed out", async () => {
		const { screen } = await open(fakeService(), { [WORK.id]: { loggedIn: false } });
		assert.match(screen(), /work\s+signed out/);
	});
});

describe("keys", () => {
	it("enter switches this session", async () => {
		const state = fakeService();
		const { screen, press } = await open(state);
		await press(DOWN, ENTER);
		assert.deepEqual(state.calls, [["switchTo", "work"]]);
		assert.match(screen(), /✓ Switched to work \(next turn\)\./);
	});

	it("enter on a signed-out account signs it in again", async () => {
		const state = fakeService();
		let asked;
		state.service.signInAgain = async (name) => { asked = name; return { ok: true, value: { status: { loggedIn: true, email: "w@x.io" }, rewritten: true } }; };
		const { screen, press } = await open(state, { [WORK.id]: { loggedIn: false } });
		await press(DOWN, ENTER);
		assert.equal(asked, "work");
		assert.match(screen(), /✓ Signed in work as w@x\.io\./);
	});

	it("d sets the default", async () => {
		const state = fakeService();
		const { press } = await open(state);
		await press(DOWN, "d");
		assert.deepEqual(state.calls, [["setDefault", "work"]]);
	});

	it("r renames, and a rejected name keeps the field open with the reason", async () => {
		const state = fakeService();
		const { screen, press } = await open(state);
		await press(DOWN, "r", "\x15", ..."bad!", ENTER);
		assert.match(screen(), /✗ Not renamed: bad name\./);
		assert.match(screen(), /enter save · esc back/);
		await press("\x15", ..."job", ENTER);
		assert.deepEqual(state.calls.at(-1), ["rename", "work", "job"]);
		assert.match(screen(), /job/);
	});

	it("x refuses the launch account", async () => {
		const state = fakeService();
		const { screen, press } = await open(state);
		await press("x");
		assert.match(screen(), /can't be removed; rename it instead/);
		assert.deepEqual(state.calls, []);
	});

	it("x asks first, and only y removes", async () => {
		const state = fakeService({ activeId: WORK.id });
		const { screen, press } = await open(state);
		await press(DOWN, "x");
		assert.match(screen(), /Remove work\?/);
		assert.match(screen(), /This session moves to default\./);
		await press("n");
		assert.deepEqual(state.calls, []);
		await press("x", "y");
		assert.deepEqual(state.calls, [["remove", "work"]]);
	});

	it("esc closes", async () => {
		const { press, isClosed } = await open(fakeService());
		await press(ESC);
		assert.equal(isClosed(), true);
	});
});

describe("adding an account", () => {
	it("asks for a name, waits for the browser, then reports the login", async () => {
		const state = fakeService();
		let release, cancelled = false;
		state.service.add = async (name, onStart) => {
			onStart({ done: new Promise(() => {}), cancel() { cancelled = true; } });
			await new Promise((r) => { release = r; });
			return { ok: true, value: { account: { id: "b2", name, configDir: "/tmp/b2" }, status: { loggedIn: true, email: "p@x.io", subscriptionType: "pro" }, rewritten: true } };
		};
		const { panel, screen, press } = await open(state);
		await press(DOWN, DOWN, ENTER);
		assert.match(screen(), /Name for the new account/);
		for (const k of "personal") panel.handleInput(k);
		panel.handleInput(ENTER);
		await new Promise((r) => setImmediate(r));
		assert.match(screen(), /waiting for browser sign-in…/);
		assert.match(screen(), /esc cancel/);
		release();
		await panel.idle();
		assert.match(screen(), /✓ Signed in personal as p@x\.io\./);
		assert.equal(cancelled, false);
	});

	it("esc while waiting cancels the sign-in", async () => {
		const state = fakeService();
		let finish;
		state.service.add = (name, onStart) => new Promise((resolve) => {
			finish = resolve;
			onStart({ done: new Promise(() => {}), cancel() { resolve({ ok: false, reason: "cancelled" }); } });
		});
		const { panel, screen, press } = await open(state);
		await press(DOWN, DOWN, ENTER);
		for (const k of "work2") panel.handleInput(k);
		panel.handleInput(ENTER);
		await new Promise((r) => setImmediate(r));
		await press(ESC);
		assert.match(screen(), /Sign-in cancelled\./);
		assert.ok(finish);
	});

	it("notes when the browser opened without the sign-out step", async () => {
		const state = fakeService();
		state.service.add = async (name) => ({ ok: true, value: { account: { id: "b2", name, configDir: "/tmp/b2" }, status: { loggedIn: true, email: "p@x.io" }, rewritten: false } });
		const { panel, screen, press } = await open(state);
		await press(DOWN, DOWN, ENTER);
		for (const k of "p2") panel.handleInput(k);
		panel.handleInput(ENTER);
		await panel.idle();
		assert.match(screen(), /browser opened without the sign-out step/);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-accounts-panel.mjs`
Expected: FAIL, `Cannot find module '../src/accounts-panel.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/panel-box.ts`:

```ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// The frame of the /claude-account panel, copied from pi-typesafe-ai's panel,
// which copies creel's popup (tackle/internal/creel/tui.go): a rounded border
// 56 columns wide with two columns of padding, a bold title and a dim footer.
// Copied rather than shared so the bridge stays self-contained.

export const BOX_WIDTH = 56;
export const PADDING = 2;

/** The subset of pi's Theme the panel uses. */
export interface PanelTheme {
	fg(color: "accent" | "border" | "dim" | "muted" | "success" | "error" | "warning" | "text", text: string): string;
	bold(text: string): string;
}

export function renderBox(opts: { title: string; body: string[]; footer: string; width: number; theme: PanelTheme }): string[] {
	const { theme } = opts;
	const outer = Math.max(PADDING * 2 + 4, Math.min(BOX_WIDTH, opts.width));
	const inner = outer - 2 - PADDING * 2;
	const border = (text: string) => theme.fg("border", text);
	const row = (content: string) => {
		const fitted = truncateToWidth(content, inner, "…");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
		return `${border("│")}${" ".repeat(PADDING)}${fitted}${pad}${" ".repeat(PADDING)}${border("│")}`;
	};
	const body = [theme.bold(opts.title), "", ...opts.body, "", theme.fg("dim", opts.footer)];
	return [
		border(`╭${"─".repeat(outer - 2)}╮`),
		...body.map(row),
		border(`╰${"─".repeat(outer - 2)}╯`),
	];
}
```

Create `src/accounts-panel.ts`:

```ts
// The panel a bare /claude-account opens: one row per account, "+ Add account",
// the selected row's description, one message line, and a key-hint footer.
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { LAUNCH_ID, type Account } from "./accounts.js";
import type { AccountService, Result, SigninOutcome } from "./account-service.js";
import { BOX_WIDTH, PADDING, renderBox, type PanelTheme } from "./panel-box.js";
import type { AuthStatus, SigninRun } from "./signin.js";

type PanelService = Pick<AccountService, "load" | "active" | "switchTo" | "setDefault" | "rename" | "remove" | "add" | "signInAgain">;

export interface AccountsPanelOptions {
	service: PanelService;
	readStatus(account: Account): Promise<AuthStatus>;
	theme: PanelTheme;
	requestRender(): void;
	onClose(): void;
}

type Mode = "list" | "name" | "rename" | "confirmRemove" | "signingIn";

const INNER = BOX_WIDTH - 2 - PADDING * 2;
const NAME_WIDTH = 12;
const DETAIL_WIDTH = 26;
const HELP_LINES = 3;
const FOOTERS: Record<Mode, string> = {
	list: "↑↓ select · enter use · d default · esc close",
	name: "enter save · esc back",
	rename: "enter save · esc back",
	confirmRemove: "y remove · any other key keeps it",
	signingIn: "esc cancel",
};
const WAITING_HELP = "On Claude's page, enter the account's email, click the link in the email, then Authorize.";

const plan = (type?: string) => (type ? type[0]!.toUpperCase() + type.slice(1) : undefined);

export class AccountsPanel implements Component {
	#o: AccountsPanelOptions;
	#mode: Mode = "list";
	#selected = 0;
	#accounts: Account[] = [];
	#defaultId = LAUNCH_ID;
	#status = new Map<string, AuthStatus | "loading">();
	#message: { kind: "ok" | "error"; text: string } | undefined;
	#input: Input | undefined;
	#target: Account | undefined;
	#signin: SigninRun | undefined;
	#pending: Promise<void> = Promise.resolve();

	constructor(options: AccountsPanelOptions) {
		this.#o = options;
		this.#reload();
		this.#loadStatuses(this.#accounts);
	}

	/** Resolves once every action started so far has finished. */
	idle(): Promise<void> {
		return this.#pending;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this.#o;
		const body: string[] = [];
		if (this.#mode === "list") {
			this.#accounts.forEach((account, index) => body.push(this.#row(account, index)));
			const onAdd = this.#selected === this.#accounts.length;
			body.push(`${onAdd ? theme.fg("accent", "→ ") : "  "}${theme.fg(onAdd ? "accent" : "text", "+ Add account")}`);
			body.push("");
			for (const line of wrapTextWithAnsi(this.#help(), INNER).slice(0, HELP_LINES)) body.push(theme.fg("dim", line));
		} else if (this.#mode === "name" || this.#mode === "rename") {
			body.push(theme.fg("dim", this.#mode === "name" ? "Name for the new account (a-z, 0-9, -)" : `New name for ${this.#target?.name}`));
			body.push(theme.fg("accent", this.#input?.render(INNER)[0] ?? ""));
		} else if (this.#mode === "confirmRemove") {
			for (const line of wrapTextWithAnsi(this.#removePrompt(), INNER)) body.push(theme.fg("warning", line));
		} else {
			body.push(theme.fg("accent", "waiting for browser sign-in…"), "");
			for (const line of wrapTextWithAnsi(WAITING_HELP, INNER)) body.push(theme.fg("dim", line));
		}
		// One height for every mode, so the centered overlay never jumps: the
		// rows, "+ Add account", a blank, the description, a blank.
		const height = this.#accounts.length + 1 + 1 + HELP_LINES + 1;
		while (body.length < height) body.push("");
		body.length = height;
		body.push(this.#messageLine());
		return renderBox({ title: "🔑 claude · accounts", body, footer: FOOTERS[this.#mode], width, theme });
	}

	handleInput(data: string): void {
		const escape = matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
		if (this.#mode === "name" || this.#mode === "rename") {
			this.#input?.handleInput(data);
			this.#o.requestRender();
			return;
		}
		if (this.#mode === "signingIn") {
			if (escape) this.#signin?.cancel();
			return;
		}
		if (this.#mode === "confirmRemove") {
			const target = this.#target!;
			this.#mode = "list";
			if (data === "y" || data === "Y") this.#track(this.#remove(target));
			else this.#message = { kind: "ok", text: `Kept ${target.name}.` };
			this.#o.requestRender();
			return;
		}
		if (escape) {
			this.#o.onClose();
			return;
		}
		const count = this.#accounts.length + 1;
		const account = this.#accounts[this.#selected];
		if (matchesKey(data, "up") || data === "k") {
			this.#selected = (this.#selected + count - 1) % count;
			this.#message = undefined;
		} else if (matchesKey(data, "down") || data === "j") {
			this.#selected = (this.#selected + 1) % count;
			this.#message = undefined;
		} else if (matchesKey(data, "enter") || data === "\n" || data === " ") {
			if (account) this.#use(account);
			else this.#openInput("name", "");
		} else if (data === "d" && account) {
			this.#show(this.#o.service.setDefault(account.name), `New sessions start on ${account.name}.`);
		} else if (data === "r" && account) {
			this.#target = account;
			this.#openInput("rename", account.name);
		} else if (data === "x" && account) {
			if (account.id === LAUNCH_ID) this.#message = { kind: "error", text: "The login pi started with can't be removed; rename it instead." };
			else { this.#target = account; this.#mode = "confirmRemove"; }
		} else {
			return;
		}
		this.#o.requestRender();
	}

	#row(account: Account, index: number): string {
		const { theme } = this.#o;
		const selected = index === this.#selected;
		const pointer = selected ? theme.fg("accent", "→ ") : "  ";
		const name = truncateToWidth(account.name, NAME_WIDTH, "…");
		const namePadded = name + " ".repeat(Math.max(0, NAME_WIDTH - visibleWidth(name)));
		const mark = account.id === this.#o.service.active().id ? theme.fg("accent", "●  ") : "   ";
		const status = this.#status.get(account.id);
		const signedOut = status !== undefined && status !== "loading" && !status.loggedIn;
		const text = status === undefined || status === "loading"
			? "…"
			: status.loggedIn ? [status.email, plan(status.subscriptionType)].filter(Boolean).join(" · ") : "signed out";
		const detail = truncateToWidth(text, DETAIL_WIDTH, "…");
		const detailPadded = detail + " ".repeat(Math.max(0, DETAIL_WIDTH - visibleWidth(detail)));
		const isDefault = account.id === this.#defaultId ? theme.fg("muted", " default") : "";
		return `${pointer}${theme.fg(selected ? "accent" : "text", namePadded)}${mark}${theme.fg(signedOut ? "warning" : "dim", detailPadded)}${isDefault}`;
	}

	#help(): string {
		const account = this.#accounts[this.#selected];
		if (!account) return "Sign in another Claude account in your browser. The browser is signed out of claude.ai first.";
		const status = this.#status.get(account.id);
		if (status && status !== "loading" && !status.loggedIn) return "Signed out. Enter signs this account in again in your browser.";
		return `This session uses ${this.#o.service.active().name}. Enter switches this session; d sets default; r renames; x removes.`;
	}

	#removePrompt(): string {
		const target = this.#target!;
		const fallback = this.#accounts.find((a) => a.id === (this.#defaultId === target.id ? LAUNCH_ID : this.#defaultId));
		const moves = target.id === this.#o.service.active().id ? ` This session moves to ${fallback?.name ?? "default"}.` : "";
		return `Remove ${target.name}? This signs it out and deletes its folder.${moves} y/N`;
	}

	#messageLine(): string {
		const { theme } = this.#o;
		if (!this.#message) return "";
		return this.#message.kind === "ok" ? theme.fg("success", `✓ ${this.#message.text}`) : theme.fg("error", `✗ ${this.#message.text}`);
	}

	#use(account: Account): void {
		const status = this.#status.get(account.id);
		if (status && status !== "loading" && !status.loggedIn) {
			this.#track(this.#signInAgain(account));
			return;
		}
		if (account.id === this.#o.service.active().id) {
			this.#message = { kind: "ok", text: `Already using ${account.name}.` };
			return;
		}
		this.#show(this.#o.service.switchTo(account.name), `Switched to ${account.name} (next turn).`);
	}

	#openInput(mode: "name" | "rename", value: string): void {
		const input = new Input();
		input.setValue(value);
		input.onSubmit = (text) => this.#submit(text.trim());
		input.onEscape = () => {
			this.#mode = "list";
			this.#input = undefined;
			this.#o.requestRender();
		};
		this.#input = input;
		this.#mode = mode;
		this.#message = undefined;
	}

	#submit(text: string): void {
		if (this.#mode === "name") {
			this.#mode = "list";
			this.#input = undefined;
			this.#track(this.#add(text));
			return;
		}
		const result = this.#o.service.rename(this.#target!.name, text);
		if (!result.ok) {
			this.#message = { kind: "error", text: result.reason };
		} else {
			this.#mode = "list";
			this.#input = undefined;
			this.#reload();
			this.#message = { kind: "ok", text: `Renamed to ${text}.` };
		}
		this.#o.requestRender();
	}

	async #add(name: string): Promise<void> {
		const result = await this.#o.service.add(name, (run) => this.#waitOn(run));
		this.#endWait();
		this.#reload();
		if (result.ok) {
			this.#loadStatuses([result.value.account]);
			this.#selected = Math.max(0, this.#accounts.findIndex((a) => a.id === result.value.account.id));
		}
		this.#message = this.#signinMessage(name, result);
	}

	async #signInAgain(account: Account): Promise<void> {
		const result = await this.#o.service.signInAgain(account.name, (run) => this.#waitOn(run));
		this.#endWait();
		if (result.ok) this.#status.set(account.id, result.value.status);
		this.#message = this.#signinMessage(account.name, result);
	}

	#signinMessage(name: string, result: Result<SigninOutcome>): { kind: "ok" | "error"; text: string } {
		if (!result.ok) return result.reason === "cancelled" ? { kind: "ok", text: "Sign-in cancelled." } : { kind: "error", text: result.reason };
		const as = result.value.status.email ? ` as ${result.value.status.email}` : "";
		const note = result.value.rewritten ? "" : " The browser opened without the sign-out step.";
		return { kind: "ok", text: `Signed in ${name}${as}.${note}` };
	}

	async #remove(target: Account): Promise<void> {
		const result = await this.#o.service.remove(target.name);
		this.#reload();
		this.#message = result.ok
			? { kind: "ok", text: `Removed ${target.name}.${result.value.switchedTo ? ` This session now uses ${result.value.switchedTo.name}.` : ""}` }
			: { kind: "error", text: result.reason };
	}

	#waitOn(run: SigninRun): void {
		this.#signin = run;
		this.#mode = "signingIn";
		this.#message = undefined;
		this.#o.requestRender();
	}

	#endWait(): void {
		this.#signin = undefined;
		this.#mode = "list";
	}

	#show(result: Result<unknown>, text: string): void {
		this.#message = result.ok ? { kind: "ok", text } : { kind: "error", text: result.reason };
		this.#reload();
	}

	#reload(): void {
		const { registry, problem } = this.#o.service.load();
		this.#accounts = registry.accounts;
		this.#defaultId = registry.default;
		if (problem) this.#message = { kind: "error", text: problem };
		this.#selected = Math.min(this.#selected, this.#accounts.length);
	}

	#loadStatuses(accounts: Account[]): void {
		for (const account of accounts) this.#status.set(account.id, "loading");
		this.#track(Promise.all(accounts.map(async (account) => {
			this.#status.set(account.id, await this.#o.readStatus(account));
			this.#o.requestRender();
		})).then(() => {}));
	}

	#track(work: Promise<void>): void {
		const settled = work.catch(() => {
			this.#message = { kind: "error", text: "Something went wrong; nothing was changed." };
		}).finally(() => this.#o.requestRender());
		this.#pending = Promise.all([this.#pending, settled]).then(() => {});
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-accounts-panel.mjs`
Expected: PASS.
If the rename test fails because `Input` does not treat `\x15` (ctrl+u) as "clear to line start", replace `"\x15"` in the test with enough backspaces (`"\x7f"`) to clear the prefilled name. The panel code does not change.
Then: `npm run typecheck && npm run test:unit`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/panel-box.ts src/accounts-panel.ts tests/unit-accounts-panel.mjs
git commit -m "feat(accounts): /claude-account panel"
```

---

### Task 6: Command, session wiring and registration (`src/account-command.ts`, `src/index.ts`)

**Files:**
- Create: `src/account-command.ts`
- Modify: `src/index.ts` (the default export, `export default function (pi: ExtensionAPI) {` ~L2399)
- Modify: `tests/lib/setup.mjs` (point the unit suite at a throwaway pi agent dir)
- Test: `tests/unit-account-command.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4 and 5; `loadConfig` from `./config.js`.
- Produces:
  - `registerAccounts(pi: ExtensionAPI, deps?: AccountsWiringDeps): void`, with `interface AccountsWiringDeps { root?: string; startSignin?(account: Account): SigninRun; readStatus?(account: Account): Promise<AuthStatus>; signOut?(account: Account): Promise<void> }`.
  - `accountCompletions(prefix: string, accounts: Account[]): AutocompleteItem[] | null`.
  - `STATUS_KEY = "claude-account"`.

- [ ] **Step 1: Make the unit suite hermetic**

Registering accounts at activation reads `<agent dir>/claude-bridge/accounts.json`. The unit suite must never read the developer's real one. Add to `tests/lib/setup.mjs`, after the log-dir lines:

```js
// Accounts and bridge config resolve under the pi agent dir; never read the
// developer's real ~/.pi/agent from a unit test.
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
```

Run: `npm run test:unit`
Expected: PASS. If any existing test fails, stop: that test was reading the real agent dir. Report which test before changing anything.

- [ ] **Step 2: Write the failing tests**

Create `tests/unit-account-command.mjs`:

```js
/**
 * /claude-account wiring: session restore, subcommands, footer status, completions.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acc = await import("../src/accounts.js");
const { registerAccounts, accountCompletions, STATUS_KEY } = await import("../src/account-command.js");

let root;
const WORK = () => ({ id: "a1b2c3d4", name: "work", configDir: join(root, "accounts", "a1b2c3d4") });

function harness({ accounts = [WORK()], defaultId = "launch" } = {}) {
	acc.saveRegistry(root, { version: 1, default: defaultId, accounts: [{ ...acc.LAUNCH_ACCOUNT }, ...accounts] });
	const handlers = new Map(), entries = [], commands = new Map(), notes = [], statuses = [];
	const pi = {
		on: (event, h) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		registerCommand: (name, options) => commands.set(name, options),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	};
	registerAccounts(pi, {
		root,
		readStatus: async (a) => ({ loggedIn: true, email: `${a.name}@x.io`, subscriptionType: "max" }),
		startSignin: () => ({ done: Promise.resolve({ ok: true, rewritten: true }), cancel() {} }),
		signOut: async () => {},
	});
	const ui = {
		notify: (text, kind) => notes.push([kind, text]),
		setStatus: (key, text) => statuses.push([key, text]),
		confirm: async () => true,
		custom: async () => { notes.push(["custom", "panel"]); },
	};
	const ctx = (over = {}) => ({ ui, mode: "tui", hasUI: true, model: { baseUrl: "claude-bridge" }, sessionManager: { getBranch: () => entries }, ...over });
	const emit = async (event, e, c) => { for (const h of handlers.get(event) ?? []) await h(e, c); };
	const run = (args, c = ctx()) => commands.get("claude-account").handler(args, c);
	return { entries, commands, notes, statuses, ctx, emit, run };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "account-command-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); acc.resetAccountStateForTest(); });

describe("session restore", () => {
	it("a new session starts on the default account", async () => {
		const h = harness({ defaultId: "a1b2c3d4" });
		await h.emit("session_start", { reason: "startup" }, h.ctx());
		assert.equal(acc.getActiveAccount().name, "work");
	});

	it("a resumed session goes back to its account", async () => {
		const h = harness();
		h.entries.push({ type: "custom", customType: acc.ACCOUNT_ENTRY_TYPE, data: { id: "a1b2c3d4", name: "work" } });
		await h.emit("session_start", { reason: "resume" }, h.ctx());
		assert.equal(acc.getActiveAccount().name, "work");
	});

	it("warns when the session's account was removed", async () => {
		const h = harness();
		h.entries.push({ type: "custom", customType: acc.ACCOUNT_ENTRY_TYPE, data: { id: "deadbeef", name: "old" } });
		await h.emit("session_start", { reason: "resume" }, h.ctx());
		assert.deepEqual(h.notes, [["warning", 'Account "old" no longer exists; using default.']]);
	});

	it("a later startup is a subagent session and leaves the account alone", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" }, h.ctx());
		acc.setActiveAccount(acc.byName(acc.loadRegistry(root).registry, "work"));
		await h.emit("session_start", { reason: "startup" }, h.ctx({ sessionManager: { getBranch: () => [] } }));
		assert.equal(acc.getActiveAccount().name, "work");
	});

	it("survives a host context without a session manager or UI", async () => {
		const h = harness();
		await h.emit("session_start", {}, { modelRegistry: {} });
		assert.equal(acc.getActiveAccount().id, "launch");
	});
});

describe("subcommands", () => {
	it("<name> switches, records the account in the session and shows it in the footer", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" }, h.ctx());
		await h.run("work");
		assert.equal(acc.getActiveAccount().name, "work");
		assert.deepEqual(h.entries.at(-1).data, { id: "a1b2c3d4", name: "work" });
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, "claude: work"]);
		assert.deepEqual(h.notes.at(-1), ["info", "This session now uses work (from the next turn)."]);
	});

	it("use <name> switches too, and 'default' alone means the account named default", async () => {
		const h = harness();
		await h.run("use work");
		assert.equal(acc.getActiveAccount().name, "work");
		await h.run("default");
		assert.equal(acc.getActiveAccount().id, "launch");
	});

	it("default <name> sets the default", async () => {
		const h = harness();
		await h.run("default work");
		assert.equal(acc.loadRegistry(root).registry.default, "a1b2c3d4");
	});

	it("add <name> signs in and reports the email", async () => {
		const h = harness({ accounts: [] });
		await h.run("add personal");
		assert.deepEqual(h.notes.at(-1), ["info", "Signed in personal as personal@x.io."]);
	});

	it("list prints each account with the active marker, login and default", async () => {
		const h = harness({ defaultId: "a1b2c3d4" });
		await h.run("list");
		assert.deepEqual(h.notes.at(-1), ["info", "● default  default@x.io · max\n  work  work@x.io · max  (default)"]);
	});

	it("a bare command opens the panel in the TUI and lists otherwise", async () => {
		const h = harness();
		await h.run("");
		assert.deepEqual(h.notes.at(-1), ["custom", "panel"]);
		await h.run("", h.ctx({ mode: "rpc" }));
		assert.match(h.notes.at(-1)[1], /work/);
	});

	it("remove needs a UI to confirm", async () => {
		const h = harness();
		await h.run("remove work", h.ctx({ hasUI: false }));
		assert.equal(h.notes.at(-1)[0], "warning");
		assert.ok(acc.byName(acc.loadRegistry(root).registry, "work"), "not removed");
	});

	it("unknown names say so", async () => {
		const h = harness();
		await h.run("nope");
		assert.deepEqual(h.notes.at(-1), ["warning", 'No account named "nope".']);
	});
});

describe("footer status", () => {
	it("is hidden with a single account and when a non-bridge model is active", async () => {
		const single = harness({ accounts: [] });
		await single.emit("session_start", { reason: "startup" }, single.ctx());
		assert.deepEqual(single.statuses.at(-1), [STATUS_KEY, undefined]);
		acc.resetAccountStateForTest();
		const h = harness();
		await h.emit("session_start", { reason: "startup" }, h.ctx());
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, "claude: default"]);
		await h.emit("model_select", { model: { baseUrl: "https://api.openai.com" } }, h.ctx());
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
	});
});

describe("completions", () => {
	const accounts = [acc.LAUNCH_ACCOUNT, { id: "a1", name: "work", configDir: "/x" }];
	it("offers subcommands and account names for the first word", () => {
		assert.deepEqual(accountCompletions("w", accounts).map((i) => i.value), ["work"]);
		assert.ok(accountCompletions("", accounts).some((i) => i.value === "add"));
	});
	it("offers account names after default, remove and use, as the whole argument", () => {
		assert.deepEqual(accountCompletions("remove w", accounts).map((i) => i.value), ["remove work"]);
		assert.equal(accountCompletions("add x", accounts), null);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-account-command.mjs`
Expected: FAIL, `Cannot find module '../src/account-command.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/account-command.ts`:

```ts
// /claude-account: the command and its subcommands, the panel host, and the
// session wiring that restores each session's account and shows it in the footer.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	ACCOUNT_ENTRY_TYPE,
	accountState,
	accountsRoot,
	getActiveAccount,
	loadRegistry,
	restoreAccount,
	setActiveAccount,
	type Account,
	type AccountEntryData,
} from "./accounts.js";
import { AccountService, type Result } from "./account-service.js";
import { AccountsPanel } from "./accounts-panel.js";
import { loadConfig } from "./config.js";
import { BOX_WIDTH } from "./panel-box.js";
import { readAuthStatus, signOut, startSignin, type AuthStatus, type SigninRun } from "./signin.js";

export const STATUS_KEY = "claude-account";

export interface AccountsWiringDeps {
	root?: string;
	startSignin?(account: Account): SigninRun;
	readStatus?(account: Account): Promise<AuthStatus>;
	signOut?(account: Account): Promise<void>;
}

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "add", label: "add", description: "Sign in another account in your browser" },
	{ value: "list", label: "list", description: "List the accounts" },
	{ value: "default", label: "default", description: "Set the account new sessions start on" },
	{ value: "remove", label: "remove", description: "Sign out and remove an account" },
	{ value: "use", label: "use", description: "Switch this session to an account" },
];

export function accountCompletions(prefix: string, accounts: Account[]): AutocompleteItem[] | null {
	const words = prefix.split(/\s+/);
	const names = accounts.map((a) => ({ value: a.name, label: a.name, description: "Switch this session to this account" }));
	if (words.length <= 1) {
		const first = words[0] ?? "";
		const items = [...SUBCOMMANDS, ...names].filter((item) => item.value.startsWith(first));
		return items.length ? items : null;
	}
	if (words.length === 2 && ["default", "remove", "use"].includes(words[0]!)) {
		const items = names
			.filter((item) => item.value.startsWith(words[1]!))
			.map((item) => ({ ...item, value: `${words[0]} ${item.value}` }));
		return items.length ? items : null;
	}
	return null;
}

export function registerAccounts(pi: ExtensionAPI, deps: AccountsWiringDeps = {}): void {
	const root = deps.root ?? accountsRoot();
	const claudeBin = () => loadConfig(process.cwd()).provider?.pathToClaudeCodeExecutable ?? "claude";
	const readStatus = deps.readStatus ?? ((account: Account) => readAuthStatus(account, { claudeBin: claudeBin() }));
	let ui: ExtensionCommandContext["ui"] | undefined;
	let bridgeActive = false;

	// Shown only while a bridge model is active and there is more than one account.
	const refreshStatus = () => {
		const several = loadRegistry(root).registry.accounts.length > 1;
		ui?.setStatus?.(STATUS_KEY, bridgeActive && several ? `claude: ${getActiveAccount().name}` : undefined);
	};

	const service = new AccountService({
		root,
		startSignin: deps.startSignin ?? ((account) => startSignin(account, { claudeBin: claudeBin() })),
		readStatus,
		signOut: deps.signOut ?? ((account) => signOut(account, { claudeBin: claudeBin() })),
		onSwitch: (account) => {
			pi.appendEntry<AccountEntryData>(ACCOUNT_ENTRY_TYPE, { id: account.id, name: account.name });
			refreshStatus();
		},
		onChange: refreshStatus,
	});

	pi.on("session_start", (event, ctx) => {
		ui = ctx?.ui;
		bridgeActive = ctx?.model?.baseUrl === "claude-bridge";
		const state = accountState();
		// A later "startup" is an in-process subagent session: it runs on its
		// parent's account, so only a top-level start applies a session's account.
		if (event?.reason !== "startup" || !state.restored) {
			const { registry, problem } = loadRegistry(root);
			const restored = restoreAccount(ctx?.sessionManager?.getBranch?.() ?? [], registry);
			setActiveAccount(restored.account);
			state.restored = true;
			if (restored.notice) ctx?.ui?.notify?.(restored.notice, "warning");
			if (problem) ctx?.ui?.notify?.(`Claude accounts: ${problem}. Using your usual login.`, "warning");
		}
		refreshStatus();
	});

	pi.on("model_select", (event) => {
		bridgeActive = event?.model?.baseUrl === "claude-bridge";
		refreshStatus();
	});

	// Hosts and test doubles without commands still get the session wiring.
	if (typeof pi.registerCommand !== "function") return;
	pi.registerCommand("claude-account", {
		description: "Claude accounts; or <name> | add <name> | default <name> | list | remove <name>",
		getArgumentCompletions: (prefix) => accountCompletions(prefix, loadRegistry(root).registry.accounts),
		handler: (args, ctx) => handle(args, ctx),
	});

	async function handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
		ui = ctx.ui;
		bridgeActive = ctx.model?.baseUrl === "claude-bridge";
		const [sub, arg] = args.trim().split(/\s+/).filter(Boolean);
		const report = (result: Result<unknown>, text: string) => {
			if (result.ok) ctx.ui.notify(text, "info");
			else ctx.ui.notify(result.reason, "warning");
		};
		const usage = () => ctx.ui.notify("usage: /claude-account [<name> | use <name> | add <name> | default <name> | list | remove <name>]", "warning");

		if (!sub) {
			if (ctx.mode === "tui") await openPanel(ctx);
			else ctx.ui.notify(await listText(), "info");
			return;
		}
		if (sub === "list") {
			ctx.ui.notify(await listText(), "info");
			return;
		}
		if (sub === "add") {
			if (!arg) return usage();
			ctx.ui.notify(`Opening your browser to sign in ${arg}…`, "info");
			const result = await service.add(arg);
			if (!result.ok) return report(result, "");
			const as = result.value.status.email ? ` as ${result.value.status.email}` : "";
			const note = result.value.rewritten ? "" : " The browser opened without the sign-out step.";
			return report(result, `Signed in ${arg}${as}.${note}`);
		}
		if (sub === "default" && arg) return report(service.setDefault(arg), `New sessions start on ${arg}.`);
		if (sub === "remove") {
			if (!arg) return usage();
			if (!ctx.hasUI) {
				ctx.ui.notify("Removing an account needs a confirmation; run it in the interactive TUI.", "warning");
				return;
			}
			if (!(await ctx.ui.confirm("Claude accounts", `Remove ${arg}? This signs it out and deletes its folder.`))) {
				ctx.ui.notify(`Kept ${arg}.`, "info");
				return;
			}
			const result = await service.remove(arg);
			const moved = result.ok && result.value.switchedTo ? ` This session now uses ${result.value.switchedTo.name}.` : "";
			return report(result, `Removed ${arg}.${moved}`);
		}
		// `/claude-account default` alone switches to the account named default.
		const name = sub === "use" ? arg : sub;
		if (!name) return usage();
		report(service.switchTo(name), `This session now uses ${name} (from the next turn).`);
	}

	async function listText(): Promise<string> {
		const { registry, problem } = service.load();
		const statuses = await Promise.all(registry.accounts.map((account) => readStatus(account)));
		const active = getActiveAccount().id;
		const lines = registry.accounts.map((account, i) => {
			const status = statuses[i]!;
			const detail = status.loggedIn ? [status.email, status.subscriptionType].filter(Boolean).join(" · ") : "signed out";
			return `${account.id === active ? "●" : " "} ${account.name}  ${detail}${account.id === registry.default ? "  (default)" : ""}`;
		});
		return [...(problem ? [`Accounts file problem: ${problem}`] : []), ...lines].join("\n");
	}

	async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => new AccountsPanel({
				service,
				readStatus,
				theme,
				requestRender: () => tui.requestRender(),
				onClose: () => done(undefined),
			}),
			{ overlay: true, overlayOptions: { anchor: "center", width: BOX_WIDTH } },
		);
	}
}
```

In `src/index.ts`, add the import next to the Task 2 accounts import:

```ts
import { registerAccounts } from "./account-command.js";
```

and make it the first statement of the default export:

```ts
export default function (pi: ExtensionAPI) {
	// First, so the bridge's own handlers are registered after it: some unit-test
	// hosts keep only the last handler per event.
	registerAccounts(pi);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-account-command.mjs`
Expected: PASS.
Then: `npm run typecheck && npm run test:unit`
Expected: both pass, including every pre-existing activation test (`unit-provider-registration`, `unit-usage-bus`, `unit-agent-start-capture*`, `unit-branch-summary`, `unit-side-request`).

- [ ] **Step 6: Commit**

```bash
git add src/account-command.ts src/index.ts tests/lib/setup.mjs tests/unit-account-command.mjs
git commit -m "feat(accounts): /claude-account command, session restore and footer status"
```

---

### Task 7: Integration tests and docs

**Files:**
- Create: `tests/int-signin-contract.mjs`
- Create: `tests/int-account-switch.mjs`
- Modify: `README.md` (new section after the configuration section)

**Interfaces:**
- Consumes: `startSignin` (Task 3); `createRpcHarness` from `tests/lib/rpc-harness.mjs`; the `/claude-account` command (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the browser-launch contract test**

Create `tests/int-signin-contract.mjs`:

```js
/**
 * Guards the one assumption sign-in makes about Claude Code: `claude auth login`
 * opens the browser by running `open <sign-in URL>`. Runs the real `claude`; a fake
 * `open` records the URL instead of opening a browser, and the run is cancelled as
 * soon as the URL is seen, so nothing is signed in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startSignin } = await import("../src/signin.js");

test("claude auth login opens the sign-in URL through `open`, which the stand-in rewrites", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signin-contract-"));
	try {
		const recorded = join(dir, "opened");
		const openBin = join(dir, "fake-open");
		writeFileSync(openBin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${recorded}"\n`, { mode: 0o755 });
		const configDir = join(dir, "config");
		mkdirSync(configDir);
		const run = startSignin({ id: "contract", name: "contract", configDir }, { openBin });
		const end = Date.now() + 20_000;
		while (!existsSync(recorded) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
		run.cancel();
		const result = await run.done;
		assert.equal(result.cancelled, true);
		assert.ok(existsSync(recorded), "claude auth login never ran `open`: sign-in would open the page without the sign-out step");
		const url = readFileSync(recorded, "utf8").trim();
		assert.match(url, /^https:\/\/claude\.ai\/logout\?returnTo=%2Foauth%2Fauthorize%3F/);
		assert.match(decodeURIComponent(url), /redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2Fcallback/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
```

Run: `node --import tsx --test tests/int-signin-contract.mjs`
Expected: PASS within about 20 s, with no browser tab opened.

- [ ] **Step 2: Write the recall-across-a-switch test**

Create `tests/int-account-switch.mjs`:

```js
/**
 * Switching accounts mid-conversation: a codeword planted on the launch account is
 * recalled after /claude-account moves the session to a second account, which forces
 * a rebuild of the Claude Code session in the second account's folder.
 *
 * Needs CLAUDE_BRIDGE_TESTING_SECOND_ACCOUNT_DIR: a Claude Code config directory
 * signed in to a second account (for example one added with /claude-account add).
 * Skips without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const SECOND = process.env.CLAUDE_BRIDGE_TESTING_SECOND_ACCOUNT_DIR;
const CODE = `code${Math.random().toString(36).slice(2, 6)}`;

test("a session keeps its history across an account switch", { skip: !SECOND && "set CLAUDE_BRIDGE_TESTING_SECOND_ACCOUNT_DIR to a signed-in config dir", timeout: 300_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "account-switch-agent-"));
	mkdirSync(join(agentDir, "claude-bridge"), { recursive: true });
	writeFileSync(join(agentDir, "claude-bridge", "accounts.json"), JSON.stringify({
		version: 1,
		default: "launch",
		accounts: [{ id: "launch", name: "default", configDir: null }, { id: "second01", name: "second", configDir: SECOND }],
	}));
	const harness = createRpcHarness({
		name: "account-switch",
		args: ["--model", "claude-bridge/claude-haiku-4-5"],
		env: { PI_CODING_AGENT_DIR: agentDir },
		defaultTimeout: 180_000,
	});
	await harness.startAndWait();
	try {
		const first = await harness.promptAndWait(`The access code is '${CODE}'. Acknowledge in three words or fewer.`);
		assert.ok(first, "the launch account answered");
		await harness.send({ type: "prompt", message: "/claude-account second" });
		const second = await harness.promptAndWait("What was the access code? Reply with the code only.");
		assert.match(second, new RegExp(CODE), "history survived the switch");
		const debug = readFileSync(harness.DEBUG_LOG, "utf8");
		assert.match(debug, /rotated-account/, "the switch rebuilt the session");
		assert.ok(debug.includes(`claudeDir=${SECOND}`), "the rebuilt session lives in the second account's folder");
	} finally {
		harness.stop();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
```

Before running it, read `tests/lib/rpc-harness.mjs`, lines 120-200, and confirm `promptAndWait(message)` returns the turn's text and the returned object exposes `startAndWait`, `send`, `stop` and `DEBUG_LOG`. If a name differs, use the harness's name in the test; do not change the harness.

Run: `node --import tsx --test tests/int-account-switch.mjs`
Expected: SKIPPED (no second account yet). It runs for real in Task 8.

- [ ] **Step 3: Document it in the README**

Add this section to `README.md` after the configuration section:

```markdown
## Multiple Claude accounts

Type `/claude-account` to open the accounts panel. Each session uses one account; two panes can use different ones at the same time, and a resumed session goes back to the account it last used.

- **Add an account:** choose `+ Add account` and type a name. Your browser opens Claude's sign-in page (it signs the browser out of claude.ai first, so you can pick any account). Enter the account's email, click the link in the email, then Authorize.
- **Switch this session:** select an account and press Enter. It takes effect on the next turn; the first turn after a switch sends the full history once, because the prompt cache belongs to the account.
- **Other keys:** `d` makes an account the default for new sessions, `r` renames, `x` removes (signs it out and deletes its folder).
- **Without the panel:** `/claude-account <name>`, `/claude-account add <name>`, `/claude-account default <name>`, `/claude-account list`, `/claude-account remove <name>`.

Your existing login appears as `default` and is used until you add another account. Each added account is a Claude Code config directory under `~/.pi/agent/claude-bridge/accounts/`; the bridge never reads or stores credentials. Signing in is supported on macOS.
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm run test:unit && node --import tsx --test tests/int-signin-contract.mjs tests/int-account-switch.mjs`
Expected: all pass; the account-switch test is skipped.

- [ ] **Step 5: Commit**

```bash
git add tests/int-signin-contract.mjs tests/int-account-switch.mjs README.md
git commit -m "test(accounts): sign-in launch contract and account-switch recall; README"
```

---

### Task 8: Live check with Court

No code. Run pi against this branch, not the npm pin, for this check only: `pi -e ~/GitHub/schuettc/tools-workspace/pi-claude-bridge/.worktrees/claude-accounts` in a fresh tmux pane. Court does the browser steps and each step is confirmed before the next. If a step fails, stop and debug it (superpowers:systematic-debugging) before continuing.

- [ ] **Step 1: Panel opens.** `/claude-account` shows `default` with `●`, Court's usual email and `Max`, plus `+ Add account`.
- [ ] **Step 2: Add `subaud`.** `+ Add account` → `subaud`. The browser lands on Claude's login page (signed out of claude.ai). Court enters `court@subaud.io`, clicks the emailed link, clicks Authorize. The row shows `court@subaud.io · Max`.
- [ ] **Step 3: Add the other direction.** Remove nothing. With the browser now signed in as `subaud.io`, add a throwaway account `probe` and sign in as `court@workshop.institute`. It must complete with no restart and no copying. Then remove `probe` with `x`, `y`.
- [ ] **Step 4: Switch mid-conversation.** On a bridge model, plant a codeword on `default`, switch to `subaud`, ask for the codeword. The footer shows `claude: subaud`; the answer recalls it; claude.ai usage for `subaud.io` moves.
- [ ] **Step 5: Usage meter follows.** The usage meter reports the `subaud` account's windows after the switch.
- [ ] **Step 6: Per session and resume.** In a second pane on the same branch, start a new session: it uses `default`. Quit the first pane and resume its session: it comes back on `subaud`.
- [ ] **Step 7: Integration test for real.** `CLAUDE_BRIDGE_TESTING_SECOND_ACCOUNT_DIR=<subaud's configDir from accounts.json> node --import tsx --test tests/int-account-switch.mjs` passes.
- [ ] **Step 8: Record results.** Append a "Live check (date)" section to the spec with what was observed, commit it, and hand back to Court. Publishing is a separate decision.

```bash
git add docs/superpowers/specs/2026-09-25-claude-accounts-design.md
git commit -m "docs(claude-accounts): live check results"
```
