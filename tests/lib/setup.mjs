/**
 * Unit-suite preload: redirect the bridge's debug log to a throwaway directory.
 *
 * src/index.ts resolves DEBUG_LOG_PATH into a module-level const at import time
 * (and mkdirs it when CLAUDE_BRIDGE_DEBUG=1), so the override has to be in place
 * before any test imports the module. Doing that per test file is easy to forget,
 * and forgetting is invisible: the suite still passes everywhere except on a
 * developer machine with CLAUDE_BRIDGE_DEBUG=1, where the tests instead append
 * fixture data to the real bridge log in pi's agent dir.
 *
 * Wiring this as `node --import ./tests/lib/setup.mjs` guarantees it runs first
 * in every test child process. tests/unit-debug-path.mjs asserts it took effect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(logDir, "claude-bridge.log");
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));
// Accounts and bridge config resolve under the pi agent dir; never read the
// developer's real ~/.pi/agent from a unit test.
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

// accountUsageIdentity's default (no injected readers) resolves the launch
// account's label from `<CLAUDE_CONFIG_DIR ?? HOME>/.claude.json`. A test that
// drives refreshClaudeUsage/consumeQuery on the launch account without
// injecting readers would otherwise read the developer's real ~/.claude.json
// (or $CLAUDE_CONFIG_DIR/.claude.json) — a real-filesystem, real-credentials
// side effect no unit test should have. Point both at an empty temp dir so
// every current and future test gets the name-fallback label instead.
const fakeHome = mkdtempSync(join(tmpdir(), "claude-bridge-test-home-"));
process.env.HOME = fakeHome;
delete process.env.CLAUDE_CONFIG_DIR;
process.on("exit", () => rmSync(fakeHome, { recursive: true, force: true }));
