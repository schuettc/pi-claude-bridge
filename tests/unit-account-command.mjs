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
