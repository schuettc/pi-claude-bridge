/**
 * "Use in all sessions": one pane writes a notice under the accounts root, and every
 * other running pi process applies it once. A notice that was already there when a
 * session started is history, not a request, so it is never applied.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bc = await import("../src/account-broadcast.js");

const WORK = { id: "a1b2c3d4", name: "work", configDir: "/tmp/accounts/a1b2c3d4" };
const OTHER_PID = 1;
let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "account-broadcast-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const listen = () => {
	const seen = [];
	const listener = new bc.SwitchAllListener(root, (notice) => seen.push(notice));
	return { listener, seen };
};

describe("the notice file", () => {
	it("round-trips the account and who sent it", () => {
		const written = bc.writeSwitchAll(root, WORK, OTHER_PID);
		const read = bc.readSwitchAll(root);
		assert.deepEqual(read, written);
		assert.equal(read.id, WORK.id);
		assert.equal(read.name, "work");
		assert.equal(read.pid, OTHER_PID);
		assert.ok(read.stamp);
	});

	it("is absent until someone switches everyone", () => {
		assert.equal(bc.readSwitchAll(root), undefined);
	});

	it("ignores an unreadable notice", () => {
		writeFileSync(bc.noticePath(root), "{ nope");
		assert.equal(bc.readSwitchAll(root), undefined);
	});

	it("gives each write a new stamp", () => {
		assert.notEqual(bc.writeSwitchAll(root, WORK, OTHER_PID).stamp, bc.writeSwitchAll(root, WORK, OTHER_PID).stamp);
	});
});

describe("SwitchAllListener", () => {
	it("applies a notice written after it started, exactly once", () => {
		const { listener, seen } = listen();
		bc.writeSwitchAll(root, WORK, OTHER_PID);
		listener.check();
		listener.check();
		assert.equal(seen.length, 1);
		assert.equal(seen[0].id, WORK.id);
	});

	it("never applies a notice that was already there when it started", () => {
		bc.writeSwitchAll(root, WORK, OTHER_PID);
		const { listener, seen } = listen();
		listener.check();
		assert.deepEqual(seen, [], "a restart must not replay an old switch");
	});

	it("ignores its own process's notice", () => {
		const { listener, seen } = listen();
		bc.writeSwitchAll(root, WORK, process.pid);
		listener.check();
		assert.deepEqual(seen, []);
	});

	it("applies each new notice in turn", () => {
		const { listener, seen } = listen();
		bc.writeSwitchAll(root, WORK, OTHER_PID);
		listener.check();
		bc.writeSwitchAll(root, { ...WORK, id: "launch", name: "default" }, OTHER_PID);
		listener.check();
		assert.deepEqual(seen.map((n) => n.name), ["work", "default"]);
	});

	it("hears a notice through the file watcher without a check", async () => {
		const { listener, seen } = listen();
		listener.start();
		try {
			bc.writeSwitchAll(root, WORK, OTHER_PID);
			const end = Date.now() + 3000;
			while (seen.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
			assert.equal(seen.length, 1);
		} finally {
			listener.stop();
		}
	});

	it("starts on a root that does not exist yet", () => {
		const missing = join(root, "not-yet");
		const listener = new bc.SwitchAllListener(missing, () => {});
		listener.start();
		listener.stop();
	});
});

describe("between real processes", () => {
	it("a notice written by another pi process reaches this one's watcher", async () => {
		const { execFileSync } = await import("node:child_process");
		const { pathToFileURL } = await import("node:url");
		const { listener, seen } = listen();
		listener.start();
		try {
			const mod = pathToFileURL(join(process.cwd(), "src/account-broadcast.ts")).href;
			execFileSync(process.execPath, ["--import", "tsx", "-e",
				`const bc = await import(${JSON.stringify(mod)}); bc.writeSwitchAll(${JSON.stringify(root)}, ${JSON.stringify(WORK)});`]);
			const end = Date.now() + 3000;
			while (seen.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
			assert.equal(seen.length, 1);
			assert.notEqual(seen[0].pid, process.pid);
			assert.equal(seen[0].name, "work");
		} finally {
			listener.stop();
		}
	});
});
