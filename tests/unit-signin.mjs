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

describe("stand-in interpreter", () => {
	it("runs the stand-in with the node running pi", () => {
		assert.equal(signin.standInShebang("/Users/me/.nvm/versions/node/v24/bin/node", {}), "#!/Users/me/.nvm/versions/node/v24/bin/node");
	});
	it("falls back to node on PATH when pi is a compiled binary", () => {
		assert.equal(signin.standInShebang("/usr/local/bin/pi", { bun: "1.2.0" }), "#!/usr/bin/env node");
		assert.equal(signin.standInShebang("/usr/local/bin/pi", {}), "#!/usr/bin/env node");
	});
	it("falls back when the node path has a space, which a shebang cannot hold", () => {
		assert.equal(signin.standInShebang("/Applications/My Tools/node", {}), "#!/usr/bin/env node");
	});
});
