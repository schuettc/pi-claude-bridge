// "Use in all sessions": one pane writes <accounts root>/switch-all.json, and
// every other running pi process switches its session to that account once.
//
// A notice is applied only if it appeared after the listener started. The file
// stays behind after a switch, so a session started (or resumed) later must read
// it as history, not as a request; otherwise every restart would replay it.
// A process ignores its own notices: the pane that switched everyone has
// already switched itself.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Account } from "./accounts.js";

export interface SwitchAllNotice {
	/** Unique per write; how a listener tells a new notice from one it has seen. */
	stamp: string;
	id: string;
	name: string;
	/** The pi process that sent it. */
	pid: number;
	at: number;
}

export function noticePath(root: string): string {
	return join(root, "switch-all.json");
}

/** Write atomically (temp file + rename), so a reader never sees half a notice. */
export function writeSwitchAll(root: string, account: Account, pid = process.pid): SwitchAllNotice {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const notice: SwitchAllNotice = { stamp: randomBytes(8).toString("hex"), id: account.id, name: account.name, pid, at: Date.now() };
	const path = noticePath(root);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(notice)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return notice;
}

export function readSwitchAll(root: string): SwitchAllNotice | undefined {
	try {
		const raw = JSON.parse(readFileSync(noticePath(root), "utf8"));
		if (typeof raw?.stamp !== "string" || typeof raw?.id !== "string" || typeof raw?.name !== "string" || typeof raw?.pid !== "number") return undefined;
		return { stamp: raw.stamp, id: raw.id, name: raw.name, pid: raw.pid, at: typeof raw.at === "number" ? raw.at : 0 };
	} catch {
		return undefined;
	}
}

export class SwitchAllListener {
	#root: string;
	#onNotice: (notice: SwitchAllNotice) => void;
	#seen: string | undefined;
	#watcher: FSWatcher | undefined;

	constructor(root: string, onNotice: (notice: SwitchAllNotice) => void) {
		this.#root = root;
		this.#onNotice = onNotice;
		this.#seen = readSwitchAll(root)?.stamp;
	}

	/** Apply the notice if it is new and from another process. Cheap: one small read. */
	check(): void {
		const notice = readSwitchAll(this.#root);
		if (!notice || notice.stamp === this.#seen) return;
		this.#seen = notice.stamp;
		if (notice.pid === process.pid) return;
		this.#onNotice(notice);
	}

	/** Watch the accounts root so an idle session switches without waiting for a turn. */
	start(): void {
		if (this.#watcher) return;
		try {
			mkdirSync(this.#root, { recursive: true, mode: 0o700 });
			// The directory, not the file: the atomic rename replaces the file's inode.
			this.#watcher = watch(this.#root, () => this.check());
			this.#watcher.on("error", () => this.stop());
			this.#watcher.unref();
		} catch {
			// No watcher (e.g. an unwatchable filesystem): turn-start checks still apply notices.
			this.#watcher = undefined;
		}
	}

	stop(): void {
		this.#watcher?.close();
		this.#watcher = undefined;
	}
}
