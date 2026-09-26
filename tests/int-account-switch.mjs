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
