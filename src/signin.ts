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
import { basename, join } from "node:path";
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

/** The stand-in's interpreter: the node running pi, unless pi is a compiled
 *  binary (its execPath is pi itself) or the path cannot sit in a shebang. */
export function standInShebang(execPath: string, versions: { bun?: string }): string {
	const isNode = /^node(\.exe)?$/.test(basename(execPath));
	return isNode && !versions.bun && !/\s/.test(execPath) ? `#!${execPath}` : "#!/usr/bin/env node";
}

function standInSource(openBin: string): string {
	return [
		standInShebang(process.execPath, process.versions as { bun?: string }),
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
