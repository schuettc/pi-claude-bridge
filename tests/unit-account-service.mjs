/**
 * Account operations over the registry file, with sign-in and status stubbed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

describe("remove never deletes a folder the bridge did not create", () => {
	it("keeps a hand-added folder outside accounts/ and says so", async () => {
		const outside = mkdtempSync(join(tmpdir(), "hand-added-config-"));
		try {
			writeFileSync(join(outside, "keep.txt"), "user data");
			acc.saveRegistry(root, { version: 1, default: "launch", accounts: [{ ...acc.LAUNCH_ACCOUNT }, { id: "h1", name: "hand", configDir: outside }] });
			const r = await makeService().remove("hand");
			assert.equal(r.ok, true);
			assert.equal(r.value.keptFolder, outside);
			assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "user data");
			assert.equal(acc.byName(acc.loadRegistry(root).registry, "hand"), undefined);
		} finally { rmSync(outside, { recursive: true, force: true }); }
	});

	it("keeps a sibling folder whose name only starts with accounts", async () => {
		const sibling = join(root, "accounts-evil");
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "keep.txt"), "user data");
		acc.saveRegistry(root, { version: 1, default: "launch", accounts: [{ ...acc.LAUNCH_ACCOUNT }, { id: "h2", name: "sneaky", configDir: sibling }] });
		const r = await makeService().remove("sneaky");
		assert.equal(r.ok, true);
		assert.equal(readFileSync(join(sibling, "keep.txt"), "utf8"), "user data");
	});

	it("still deletes the folder of an account it added", async () => {
		const service = makeService();
		const { value } = await service.add("work");
		const r = await service.remove("work");
		assert.equal(r.value.keptFolder, undefined);
		assert.equal(existsSync(value.account.configDir), false);
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
