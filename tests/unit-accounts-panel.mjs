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
	// The panel's text with the frame removed, lines joined: messages wrap onto two lines.
	const flat = () => panel.render(100).map((l) => l.replace(/^│\s*|\s*│$/g, "")).join(" ").replace(/\s+/g, " ");
	const press = async (...keys) => { for (const k of keys) { panel.handleInput(k); await panel.idle(); } };
	return { panel, screen, flat, press, isClosed: () => closed };
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
		const { flat, press } = await open(state);
		await press("x");
		assert.match(flat(), /can't be removed; rename it instead/);
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
		const { panel, flat, press } = await open(state);
		await press(DOWN, DOWN, ENTER);
		for (const k of "p2") panel.handleInput(k);
		panel.handleInput(ENTER);
		await panel.idle();
		assert.match(flat(), /browser opened without the sign-out step/);
	});
});
