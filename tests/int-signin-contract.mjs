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
