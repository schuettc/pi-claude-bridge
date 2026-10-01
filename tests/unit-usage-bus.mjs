#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const usageBus = await import("../src/usage-bus.js");
const warningState = await import("../src/usage-warning-state.js");
const acc = await import("../src/accounts.js");
const { default: activate, __test } = await import("../src/index.js");

const ACCOUNT_USAGE = {
	session: {
		total_cost_usd: 0,
		total_api_duration_ms: 0,
		total_duration_ms: 0,
		total_lines_added: 0,
		total_lines_removed: 0,
		model_usage: {},
	},
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 23.5, resets_at: "2026-09-13T05:00:00.000Z" },
		seven_day: { utilization: 41, resets_at: "2026-09-19T00:00:00.000Z" },
		model_scoped: [
			{ display_name: "Fable", utilization: 67, resets_at: "2026-09-20T00:00:00.000Z" },
		],
	},
	behaviors: null,
};

async function consume(messages) {
	const { QueryContext } = await import("../src/query-state.js");
	const c = new QueryContext();
	c.currentPiStream = { push() {}, end() {} };
	c.resetTurnState({ api: "claude-bridge", provider: "claude-bridge", id: "claude-fable-5-1" });
	async function* sdkMessages() {
		for (const message of messages) yield message;
	}
	await __test.consumeQuery(
		sdkMessages(),
		new Map(),
		{ api: "claude-bridge", provider: "claude-bridge", id: "claude-fable-5-1" },
		() => false,
		c,
	);
	return c;
}

function clearBus() {
	delete globalThis[BUS_SYMBOL];
}

function activateHarness() {
	const handlers = new Map();
	activate({
		on(event, handler) { handlers.set(event, handler); },
		registerProvider() {},
		registerTool() {},
		appendEntry() {},
	});
	return handlers;
}

function sessionContext(cwd, sessionId) {
	return {
		cwd,
		mode: "rpc",
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
		ui: { notify() {} },
		// pi 0.8.0's later-instance provider registration consults the session's
		// model registry on session_start; a stub keeps that path from throwing.
		modelRegistry: { getProvider: () => undefined },
	};
}

describe("Claude provider usage protocol", () => {
	it("normalizes SDK account and Fable model-scoped windows", () => {
		const capturedAt = Date.parse("2026-09-13T01:00:00.000Z");
		const snapshot = usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE, capturedAt);

		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.provider, "claude");
		assert.equal(snapshot.capturedAt, capturedAt);
		assert.deepEqual(snapshot.windows.slice(0, 2), [
			{
				id: "five_hour",
				label: "5h",
				usedPercent: 23.5,
				resetsAt: Date.parse("2026-09-13T05:00:00.000Z") / 1000,
				windowMinutes: 300,
				scope: { kind: "account" },
			},
			{
				id: "seven_day",
				label: "7d",
				usedPercent: 41,
				resetsAt: Date.parse("2026-09-19T00:00:00.000Z") / 1000,
				windowMinutes: 10_080,
				scope: { kind: "account" },
			},
		]);
		const fable = snapshot.windows.find((window) => window.scope.kind === "model");
		assert.ok(fable);
		assert.equal(fable.id, "model_scoped:fable");
		assert.equal(fable.label, "7d");
		assert.equal(fable.usedPercent, 67);
		assert.deepEqual(fable.scope, {
			kind: "model",
			modelIds: ["claude-fable-5-1", "claude-fable-5"],
			label: "Fable",
		});
	});

	it("emits the complete canonical Claude fixture including Fable and overage values", () => {
		const snapshot = usageBus.snapshotFromClaudeUsage({
			...ACCOUNT_USAGE,
			rate_limits: {
				...ACCOUNT_USAGE.rate_limits,
				extra_usage: {
					is_enabled: true,
					used_credits: 800,
					monthly_limit: 10_000,
					utilization: 8,
					currency: "USD",
				},
			},
		}, Date.parse("2026-09-13T01:00:00.000Z"));

		assert.equal(snapshot.provider, "claude");
		assert.equal(snapshot.providerLabel, "Claude");
		assert.equal(snapshot.source, "claude-code-sdk");
		assert.equal(snapshot.complete, true);
		assert.equal(snapshot.adapterId, "schuettc.pi-claude-bridge");
		assert.deepEqual(snapshot.windows.find((window) => window.scope.kind === "overage"), {
			id: "extra_usage",
			label: "overage",
			usedPercent: 8,
			state: "available",
			usedAmount: 8,
			limitAmount: 100,
			currency: "USD",
			scope: { kind: "overage" },
		});
	});

	it("suppresses overage on a subscription account with credits off", () => {
		usageBus.__resetOverageActivityForTest();
		const snapshot = usageBus.snapshotFromClaudeUsage({
			...ACCOUNT_USAGE,
			rate_limits: {
				...ACCOUNT_USAGE.rate_limits,
				extra_usage: { is_enabled: false, used_credits: 0, monthly_limit: 0, utilization: 90, currency: "USD" },
			},
		}, Date.parse("2026-09-13T01:00:00.000Z"));
		assert.equal(snapshot.windows.find((window) => window.scope.kind === "overage"), undefined);
	});

	it("shows overage from real spend even when is_enabled is absent", () => {
		usageBus.__resetOverageActivityForTest();
		const snapshot = usageBus.snapshotFromClaudeUsage({
			...ACCOUNT_USAGE,
			rate_limits: {
				...ACCOUNT_USAGE.rate_limits,
				extra_usage: { used_credits: 4_500, monthly_limit: 5_000, utilization: 90, currency: "USD" },
			},
		}, Date.parse("2026-09-13T01:00:00.000Z"));
		const overage = snapshot.windows.find((window) => window.scope.kind === "overage");
		assert.ok(overage);
		assert.equal(overage.usedPercent, 90);
		assert.equal(overage.usedAmount, 45);
	});

	it("defaults to hiding a partial overage event before any complete snapshot", () => {
		usageBus.__resetOverageActivityForTest();
		assert.equal(
			usageBus.snapshotFromClaudeRateLimitInfo({ status: "allowed_warning", rateLimitType: "overage", utilization: 0.9 }),
			undefined,
		);
	});

	it("drops a partial overage event when a complete snapshot reports credits off", () => {
		usageBus.__resetOverageActivityForTest();
		usageBus.snapshotFromClaudeUsage({
			...ACCOUNT_USAGE,
			rate_limits: { ...ACCOUNT_USAGE.rate_limits, extra_usage: { is_enabled: false, used_credits: 0 } },
		});
		const snapshot = usageBus.snapshotFromClaudeRateLimitInfo({
			status: "allowed_warning",
			rateLimitType: "overage",
			utilization: 0.9,
			resetsAt: 1_790_812_800,
		});
		assert.equal(snapshot, undefined);
	});

	it("surfaces a partial overage event once a complete snapshot confirms credits are active", () => {
		usageBus.__resetOverageActivityForTest();
		usageBus.snapshotFromClaudeUsage({
			...ACCOUNT_USAGE,
			rate_limits: {
				...ACCOUNT_USAGE.rate_limits,
				extra_usage: { is_enabled: true, used_credits: 800, monthly_limit: 10_000, utilization: 8, currency: "USD" },
			},
		});
		const snapshot = usageBus.snapshotFromClaudeRateLimitInfo({
			status: "allowed_warning",
			rateLimitType: "overage",
			utilization: 0.9,
			resetsAt: 1_790_812_800,
		});
		assert.ok(snapshot);
		assert.equal(snapshot.complete, false);
		assert.deepEqual(snapshot.windows[0], {
			id: "overage",
			label: "overage",
			usedPercent: 90,
			resetsAt: 1_790_812_800,
			state: "warning",
			scope: { kind: "overage" },
		});
		usageBus.__resetOverageActivityForTest();
	});

	it("partial passive snapshots carry adapter identity and only supplied fields", () => {
		const withoutUtilization = usageBus.snapshotFromClaudeRateLimitInfo({
			status: "allowed_warning",
			rateLimitType: "five_hour",
			resetsAt: 1_800_000_000,
		});
		assert.deepEqual(withoutUtilization, {
			version: 1,
			provider: "claude",
			providerLabel: "Claude",
			source: "claude-code-sdk-rate-limit-event",
			capturedAt: withoutUtilization.capturedAt,
			complete: false,
			adapterId: "schuettc.pi-claude-bridge",
			windows: [{
				id: "five_hour",
				label: "5h",
				resetsAt: 1_800_000_000,
				windowMinutes: 300,
				state: "warning",
				scope: { kind: "account" },
			}],
		});
	});

	it("builds a complete snapshot from unifiedWindows (5h + 7d) with no overage when isUsingOverage is false", () => {
		const snapshot = usageBus.snapshotFromClaudeRateLimitInfo({
			status: "allowed",
			rateLimitType: "five_hour",
			overageStatus: "rejected",
			overageDisabledReason: "org_level_disabled",
			isUsingOverage: false,
			unifiedWindows: {
				five_hour: { utilization: 0.47, resetsAt: 1_789_584_000 },
				seven_day: { utilization: 0.11, resetsAt: 1_790_118_000 },
			},
		});
		assert.ok(snapshot);
		assert.equal(snapshot.complete, true);
		assert.equal(snapshot.source, "claude-code-sdk-rate-limit-event");
		assert.equal(snapshot.adapterId, "schuettc.pi-claude-bridge");
		// No overage window when isUsingOverage is false.
		assert.equal(snapshot.windows.find((window) => window.scope.kind === "overage"), undefined);
		const fiveHour = snapshot.windows.find((window) => window.id === "five_hour");
		const sevenDay = snapshot.windows.find((window) => window.id === "seven_day");
		assert.deepEqual(fiveHour, {
			id: "five_hour",
			label: "5h",
			usedPercent: 47,
			resetsAt: 1_789_584_000,
			windowMinutes: 300,
			state: "available",
			scope: { kind: "account" },
		});
		assert.deepEqual(sevenDay, {
			id: "seven_day",
			label: "7d",
			usedPercent: 11,
			resetsAt: 1_790_118_000,
			windowMinutes: 10_080,
			state: "available",
			scope: { kind: "account" },
		});
	});

	it("falls back to the legacy single-window partial snapshot when unifiedWindows is absent", () => {
		const snapshot = usageBus.snapshotFromClaudeRateLimitInfo({
			status: "allowed",
			rateLimitType: "five_hour",
			utilization: 0.42,
			resetsAt: 1_800_000_000,
		});
		assert.ok(snapshot);
		assert.equal(snapshot.complete, false);
		assert.equal(snapshot.windows.length, 1);
		assert.deepEqual(snapshot.windows[0], {
			id: "five_hour",
			label: "5h",
			usedPercent: 42,
			resetsAt: 1_800_000_000,
			windowMinutes: 300,
			state: "available",
			scope: { kind: "account" },
		});
	});

	it("registers the structural adapter when the bridge creates the bus", () => {
		clearBus();
		const refresh = async () => usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE);
		const unregister = usageBus.registerClaudeUsageAdapter(refresh);
		const bus = globalThis[BUS_SYMBOL];

		assert.equal(bus.version, 1);
		assert.deepEqual(bus.adapters().map(({ id, usageProvider, modelProviders }) => ({ id, usageProvider, modelProviders })), [
			{
				id: "schuettc.pi-claude-bridge",
				usageProvider: "claude",
				modelProviders: ["claude-bridge"],
			},
		]);
		assert.strictEqual(bus.adapters()[0].refresh, refresh);
		unregister();
		assert.deepEqual(bus.adapters(), []);
	});

	it("extension activation publishes its adapter and unregisters it on shutdown", () => {
		clearBus();
		const handlers = activateHarness();
		const bus = globalThis[BUS_SYMBOL];
		assert.equal(bus.adapters().length, 1);
		assert.equal(bus.adapters()[0].id, "schuettc.pi-claude-bridge");
		handlers.get("session_shutdown")();
		assert.deepEqual(bus.adapters(), []);
	});

	it("the registered adapter's currentAccount follows an account switch", () => {
		clearBus();
		acc.resetAccountStateForTest();
		const handlers = activateHarness();
		try {
			const adapter = globalThis[BUS_SYMBOL].adapters()[0];
			assert.equal(typeof adapter.currentAccount, "function");
			assert.equal(adapter.currentAccount().id, "launch");
			acc.setActiveAccount({ id: "w1", name: "work", configDir: "/tmp/accounts/w1" });
			assert.equal(adapter.currentAccount().id, "w1");
		} finally {
			handlers.get("session_shutdown")();
			acc.resetAccountStateForTest();
		}
	});

	it("waits for the owning session_start when pi-usage refreshes first", async () => {
		clearBus();
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-usage-owner-"));
		const agentDir = join(root, "agent");
		const ownerCwd = join(root, "owner");
		mkdirSync(join(ownerCwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(ownerCwd, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: {
				autoMemoryEnabled: true,
				strictMcpConfig: false,
				pathToClaudeCodeExecutable: "/owner/claude",
			},
		}));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let queryInput;
		let usageCalls = 0;
		let handlers;
		try {
			__test.setUsageControlQuery((input) => {
				queryInput = input;
				return {
					async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
						usageCalls++;
						return ACCOUNT_USAGE;
					},
					close() {},
				};
			});
			handlers = activateHarness();
			const adapter = globalThis[BUS_SYMBOL].adapters()[0];
			await assert.rejects(adapter.refresh({ timeoutMs: 5 }), /timeout/i);
			const caller = new AbortController();
			const aborted = adapter.refresh({ timeoutMs: 1_000, signal: caller.signal });
			caller.abort(new Error("caller stopped before start"));
			await assert.rejects(aborted, /caller stopped before start/);

			const refreshing = adapter.refresh({ timeoutMs: 1_000 });
			await Promise.resolve();
			assert.equal(usageCalls, 0, "refresh must wait until the owner is ready");

			handlers.get("session_start")({ reason: "startup" }, sessionContext(ownerCwd, "owner-session"));
			const snapshot = await refreshing;
			assert.equal(snapshot.version, 1);
			assert.equal(queryInput.options.cwd, ownerCwd);
			assert.equal(queryInput.options.env.AGENT_SESSION_ID, "owner-session");
			assert.equal(queryInput.options.settings.autoMemoryEnabled, true);
			assert.equal(queryInput.options.pathToClaudeCodeExecutable, "/owner/claude");
			assert.equal(queryInput.options.strictMcpConfig, false);
			assert.equal("extraArgs" in queryInput.options, false);
		} finally {
			handlers?.get("session_shutdown")();
			__test.setUsageControlQuery();
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps refresh bound to the owner after a child factory activates", async () => {
		clearBus();
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-usage-child-"));
		const agentDir = join(root, "agent");
		const ownerCwd = join(root, "owner");
		const childCwd = join(root, "child");
		for (const cwd of [ownerCwd, childCwd]) mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(ownerCwd, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: { strictMcpConfig: false, pathToClaudeCodeExecutable: "/owner/claude" },
		}));
		writeFileSync(join(childCwd, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: { strictMcpConfig: true, pathToClaudeCodeExecutable: "/child/claude" },
		}));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldCwd = process.cwd();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let ownerHandlers;
		try {
			let queryInput;
			__test.setUsageControlQuery((input) => {
				queryInput = input;
				return {
					async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return ACCOUNT_USAGE; },
					close() {},
				};
			});
			process.chdir(ownerCwd);
			ownerHandlers = activateHarness();
			ownerHandlers.get("session_start")({ reason: "startup" }, sessionContext(ownerCwd, "owner-session"));

			process.chdir(childCwd);
			const childHandlers = activateHarness();
			childHandlers.get("session_start")({ reason: "startup" }, sessionContext(childCwd, "child-session"));
			assert.equal(globalThis[BUS_SYMBOL].adapters().length, 1);
			await globalThis[BUS_SYMBOL].adapters()[0].refresh({ timeoutMs: 1_000 });

			assert.equal(queryInput.options.cwd, ownerCwd);
			assert.equal(queryInput.options.env.AGENT_SESSION_ID, "owner-session");
			assert.equal(queryInput.options.pathToClaudeCodeExecutable, "/owner/claude");
			assert.equal(queryInput.options.strictMcpConfig, false);
		} finally {
			ownerHandlers?.get("session_shutdown")();
			__test.setUsageControlQuery();
			process.chdir(oldCwd);
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers into a compatible bus that existed before the bridge import", async () => {
		let adapter;
		let removed = false;
		const existing = {
			version: 1,
			register(value) { adapter = value; return () => { removed = true; }; },
			adapters() { return adapter ? [adapter] : []; },
			subscribe() { return () => {}; },
			publish() { return 0; },
		};
		globalThis[BUS_SYMBOL] = existing;
		const loadedAfterBus = await import(`../src/usage-bus.ts?existing-bus=${Date.now()}`);
		const refresh = async () => loadedAfterBus.snapshotFromClaudeUsage(ACCOUNT_USAGE);
		const unregister = loadedAfterBus.registerClaudeUsageAdapter(refresh);

		assert.strictEqual(globalThis[BUS_SYMBOL], existing);
		assert.equal(adapter.id, "schuettc.pi-claude-bridge");
		assert.equal(adapter.usageProvider, "claude");
		assert.deepEqual(adapter.modelProviders, ["claude-bridge"]);
		unregister();
		assert.equal(removed, true);
	});

	it("fails open when an optional registry is incompatible or throws", () => {
		clearBus();
		globalThis[BUS_SYMBOL] = { version: 2 };
		assert.doesNotThrow(() => usageBus.registerClaudeUsageAdapter(async () => ({})));
		assert.equal(usageBus.publishProviderUsage({ version: 1, type: "snapshot", snapshot: {} }), 0);

		globalThis[BUS_SYMBOL] = {
			version: 1,
			register() { throw new Error("register failed"); },
			adapters() { return []; },
			subscribe() { return () => {}; },
			publish() { throw new Error("publish failed"); },
		};
		assert.doesNotThrow(() => usageBus.registerClaudeUsageAdapter(async () => ({})));
		assert.equal(usageBus.publishProviderUsage({ version: 1, type: "snapshot", snapshot: {} }), 0);
	});

	it("runtime validation drops malformed adapters and events", () => {
		clearBus();
		const bus = usageBus.getUsageBusV1();
		let calls = 0;
		bus.subscribe(() => calls++);
		bus.register({ id: "", usageProvider: "claude", modelProviders: ["claude-bridge"], refresh: async () => ({}) });
		assert.deepEqual(bus.adapters(), []);
		assert.equal(bus.publish({ version: 1, type: "soft-warning", provider: "anthropic", message: "bad" }), 0);
		assert.equal(bus.publish({ version: 1, type: "snapshot", snapshot: { version: 1 } }), 0);
		assert.equal(calls, 0);
	});

	it("validates a snapshot's account field and an adapter's currentAccount field", () => {
		clearBus();
		const bus = usageBus.getUsageBusV1();
		const baseSnapshot = { version: 1, provider: "claude", source: "s", capturedAt: 0, complete: true, windows: [] };

		// Snapshot.account: undefined, or { id: non-empty, label?: non-empty }.
		assert.equal(bus.publish({ version: 1, type: "snapshot", snapshot: baseSnapshot }), 0, "no listeners yet, but must not throw");
		let events = [];
		const unsubscribe = bus.subscribe((event) => events.push(event));
		bus.publish({ version: 1, type: "snapshot", snapshot: { ...baseSnapshot, account: { id: "a1", label: "a@example.com" } } });
		bus.publish({ version: 1, type: "snapshot", snapshot: { ...baseSnapshot, account: { id: "a1" } } });
		assert.equal(events.length, 2, "a well-formed account, with or without a label, is accepted");
		events = [];
		bus.publish({ version: 1, type: "snapshot", snapshot: { ...baseSnapshot, account: { id: "" } } });
		bus.publish({ version: 1, type: "snapshot", snapshot: { ...baseSnapshot, account: { id: "a1", label: "" } } });
		bus.publish({ version: 1, type: "snapshot", snapshot: { ...baseSnapshot, account: "a1" } });
		assert.equal(events.length, 0, "an empty id, empty label, or non-object account is rejected");
		unsubscribe();

		// Adapter.currentAccount: undefined, or a function.
		const baseAdapter = { id: "x", usageProvider: "claude", modelProviders: ["claude-bridge"], refresh: async () => baseSnapshot };
		const unregister1 = bus.register({ ...baseAdapter, currentAccount: () => ({ id: "a1" }) });
		assert.equal(bus.adapters().length, 1, "a function currentAccount is accepted");
		unregister1();
		const unregister2 = bus.register({ ...baseAdapter, currentAccount: "not a function" });
		assert.deepEqual(bus.adapters(), [], "a non-function currentAccount is rejected");
		unregister2();
	});

	it("registerClaudeUsageAdapter carries currentAccount only when given one", () => {
		clearBus();
		const refresh = async () => usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE);
		const withoutUnregister = usageBus.registerClaudeUsageAdapter(refresh);
		assert.equal("currentAccount" in globalThis[BUS_SYMBOL].adapters()[0], false);
		withoutUnregister();

		const currentAccount = () => ({ id: "a1", label: "a@example.com" });
		const withUnregister = usageBus.registerClaudeUsageAdapter(refresh, currentAccount);
		assert.strictEqual(globalThis[BUS_SYMBOL].adapters()[0].currentAccount, currentAccount);
		withUnregister();
	});

	it("refresh invokes only the SDK usage control with an empty prompt and closes", async () => {
		let queryInput;
		let usageCalls = 0;
		let closeCalls = 0;
		let streamReads = 0;
		const sdkQuery = {
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
				usageCalls++;
				assert.deepEqual(options, { skipBehaviors: true });
				return ACCOUNT_USAGE;
			},
			close() { closeCalls++; },
			async interrupt() { throw new Error("refresh must not interrupt a successful request"); },
			async *[Symbol.asyncIterator]() {
				streamReads++;
				throw new Error("refresh must not consume an assistant stream");
			},
		};
		const queryFactory = (input) => { queryInput = input; return sdkQuery; };

		const snapshot = await __test.refreshClaudeUsage(
			{ timeoutMs: 1_000 },
			{
				query: queryFactory,
				cwd: "/tmp/usage-project",
				env: { HOME: "/tmp/home", AGENT_SESSION_ID: "session-1" },
				provider: { strictMcpConfig: true, pathToClaudeCodeExecutable: "/mock/claude" },
			},
		);

		const prompts = [];
		for await (const prompt of queryInput.prompt) prompts.push(prompt);
		assert.deepEqual(prompts, [], "account refresh must not yield a completion prompt");
		assert.equal(queryInput.options.cwd, "/tmp/usage-project");
		assert.deepEqual(queryInput.options.env, { HOME: "/tmp/home", AGENT_SESSION_ID: "session-1" });
		assert.equal(queryInput.options.pathToClaudeCodeExecutable, "/mock/claude");
		assert.equal(queryInput.options.strictMcpConfig, true);
		assert.deepEqual(queryInput.options.extraArgs, { "strict-mcp-config": null });
		assert.deepEqual(queryInput.options.tools, []);
		assert.equal("settingSources" in queryInput.options, false, "refresh keeps normal provider settings sources");
		assert.equal(usageCalls, 1);
		assert.equal(streamReads, 0);
		assert.equal(closeCalls, 1);
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.provider, "claude");
	});

	it("keeps claude.ai usage traffic enabled on the usage-refresh child, and still scopes it to the active account", async () => {
		acc.resetAccountStateForTest();
		const work = { id: "w1", name: "work", configDir: "/tmp/accounts/w1" };
		acc.setActiveAccount(work);
		let queryInput;
		const sdkQuery = {
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return ACCOUNT_USAGE; },
			close() {},
		};
		try {
			await __test.refreshClaudeUsage(
				{ timeoutMs: 1_000 },
				{
					query: (input) => { queryInput = input; return sdkQuery; },
					cwd: "/tmp/usage-project",
					env: { HOME: "/tmp/home", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
					provider: {},
				},
			);
		} finally {
			acc.resetAccountStateForTest();
		}
		assert.equal("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" in queryInput.options.env, false);
		assert.equal(queryInput.options.env.CLAUDE_CONFIG_DIR, work.configDir);
		assert.equal(queryInput.options.env.HOME, "/tmp/home");
	});

	it("a model-turn child env is unaffected: stampedChildEnv never touches the usage-traffic variable", () => {
		const env = __test.stampedChildEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, "session");
		assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
	});

	it("names a null rate_limits response caused by disabled usage traffic", () => {
		assert.throws(
			() => usageBus.snapshotFromClaudeUsage({ subscription_type: "enterprise", rate_limits_available: true, rate_limits: null, behaviors: null }),
			/Claude Code returned no plan usage \(rate_limits null\)/,
		);
	});

	it("refresh aborts on timeout and still closes the SDK query", async () => {
		let closeCalls = 0;
		let querySignal;
		const never = new Promise(() => {});
		const sdkQuery = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return never; },
			close() { closeCalls++; },
		};

		await assert.rejects(
			__test.refreshClaudeUsage(
				{ timeoutMs: 5 },
				{
					query(input) { querySignal = input.options.abortController.signal; return sdkQuery; },
					cwd: "/tmp/usage-project",
					env: {},
					provider: {},
				},
			),
			/timeout/i,
		);
		assert.equal(querySignal.aborted, true);
		assert.equal(closeCalls, 1);
	});

	it("refresh forwards caller aborts and still closes the SDK query", async () => {
		let closeCalls = 0;
		let querySignal;
		const caller = new AbortController();
		const sdkQuery = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return new Promise(() => {}); },
			close() { closeCalls++; },
		};
		const refreshing = __test.refreshClaudeUsage(
			{ timeoutMs: 1_000, signal: caller.signal },
			{
				query(input) { querySignal = input.options.abortController.signal; return sdkQuery; },
				cwd: "/tmp/usage-project",
				env: {},
				provider: {},
			},
		);
		caller.abort(new Error("caller cancelled"));
		await assert.rejects(refreshing, /caller cancelled/);
		assert.equal(querySignal.aborted, true);
		assert.equal(closeCalls, 1);
	});

	it("an allowed warning without utilization never invents zero percent", async () => {
		clearBus();
		const events = [];
		const unsubscribe = usageBus.getUsageBusV1().subscribe((event) => events.push(event));
		try {
			await consume([{
				type: "rate_limit_event",
				rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" },
			}]);
		} finally {
			unsubscribe();
		}
		assert.equal(events.length, 1);
		assert.equal(events[0].message, "Claude rate limit warning (five_hour)");
		assert.equal(events[0].message.includes("0%"), false);
	});

	it("maps SDK statuses directly to complete snapshot, soft-warning, and hard-limit events", async () => {
		clearBus();
		const events = [];
		const unregister = usageBus.registerClaudeUsageAdapter(async () => usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE));
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		const unified = { five_hour: { utilization: 0.73, resetsAt: 1_789_584_000 }, seven_day: { utilization: 0.11, resetsAt: 1_790_118_000 } };
		try {
			await consume([
				{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", isUsingOverage: false, utilization: 0.73, rateLimitType: "five_hour", unifiedWindows: unified } },
				{ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1_789_584_000 }, seven_day: { utilization: 0.05, resetsAt: 1_790_118_000 } } } },
				{ type: "rate_limit_event", rate_limit_info: { status: "rejected", utilization: 1, resetsAt: 1_800_002_000, rateLimitType: "five_hour" } },
			]);
		} finally {
			unsubscribe();
			unregister();
		}

		assert.deepEqual(events.map((event) => event.type), ["soft-warning", "snapshot", "hard-limit"]);
		assert.match(events[0].message, /73% used/);
		// The soft-warning carries a complete snapshot built from unifiedWindows (5h + 7d).
		assert.equal(events[0].snapshot.complete, true);
		assert.deepEqual(events[0].snapshot.windows.map((window) => window.id), ["five_hour", "seven_day"]);
		assert.equal(events[0].snapshot.windows.find((window) => window.id === "five_hour").usedPercent, 73);
		assert.equal(events[0].snapshot.windows.find((window) => window.id === "seven_day").usedPercent, 11);
		// The allowed status publishes a complete snapshot from unifiedWindows.
		assert.equal(events[1].snapshot.complete, true);
		assert.deepEqual(events[1].snapshot.windows.map((window) => window.id), ["five_hour", "seven_day"]);
		assert.equal(events[1].snapshot.windows.find((window) => window.id === "five_hour").usedPercent, 12);
		assert.match(events[2].message, /rate limited \(five_hour\)/);
		assert.equal(events[2].snapshot.windows[0].usedPercent, 100);
	});
});

describe("consumption accounts and overage (fixtures.json)", () => {
	// Real Claude Code usage-control responses, captured live 2026-09-30 (see
	// .superpowers/sdd/2026-09-30-usage-per-account/fixtures.json).
	const MAX_WORKSHOP = {
		subscription_type: "max",
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 0, resets_at: "2026-10-01T07:39:59.928507+00:00" },
			seven_day: { utilization: 2, resets_at: "2026-10-07T06:59:59.928531+00:00" },
			extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, decimal_places: null },
			model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-07T06:59:59.928730+00:00" }],
		},
		behaviors: null,
	};
	const MAX_SUBAUD = {
		subscription_type: "max",
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 14, resets_at: "2026-10-01T05:09:59.968462+00:00" },
			seven_day: { utilization: 46, resets_at: "2026-10-06T22:59:59.968482+00:00" },
			extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, decimal_places: null },
		},
		behaviors: null,
	};
	const ENTERPRISE_FUNDAMENTAL = {
		subscription_type: "enterprise",
		rate_limits_available: true,
		rate_limits: {
			five_hour: null,
			seven_day: null,
			extra_usage: { is_enabled: true, monthly_limit: 500000, used_credits: 6944, utilization: 1.3888, currency: "USD", decimal_places: 2 },
		},
		behaviors: null,
	};
	const OVERAGE_EVENT_ENTERPRISE = {
		status: "allowed",
		resetsAt: 1793491200,
		rateLimitType: "overage",
		overageStatus: "allowed",
		overageResetsAt: 1793491200,
		isUsingOverage: false,
		overageInUse: true,
	};

	afterEach(() => usageBus.__resetOverageActivityForTest());

	it("a max account with credits off reports 5h/7d (+ Fable) and no spend window", () => {
		const snapshot = usageBus.snapshotFromClaudeUsage(MAX_WORKSHOP, Date.now(), "workshop");
		assert.deepEqual(snapshot.windows.map((w) => w.id), ["five_hour", "seven_day", "model_scoped:fable"]);
		assert.equal(snapshot.windows.find((w) => w.scope.kind === "overage"), undefined);
	});

	it("a consumption (enterprise) account reports exactly one spend window in major currency units", () => {
		const snapshot = usageBus.snapshotFromClaudeUsage(ENTERPRISE_FUNDAMENTAL, Date.now(), "fundamental");
		const overageWindows = snapshot.windows.filter((w) => w.scope.kind === "overage");
		assert.equal(overageWindows.length, 1, "exactly one window");
		const window = overageWindows[0];
		assert.equal(window.id, "extra_usage");
		assert.equal(window.label, "spend");
		assert.equal(window.usedAmount, 69.44);
		assert.equal(window.limitAmount, 5000);
		assert.equal(window.currency, "USD");
		assert.ok(Math.abs(window.usedPercent - 1.3888) < 1e-9);
	});

	it("a plan (max) account with credits enabled reports the bucket as overage, not spend", () => {
		const withCredits = {
			...MAX_SUBAUD,
			rate_limits: { ...MAX_SUBAUD.rate_limits, extra_usage: { ...MAX_SUBAUD.rate_limits.extra_usage, is_enabled: true } },
		};
		const snapshot = usageBus.snapshotFromClaudeUsage(withCredits, Date.now(), "subaud");
		const window = snapshot.windows.find((w) => w.scope.kind === "overage");
		assert.ok(window, "credits enabled: the bucket is shown");
		assert.equal(window.label, "overage");
	});

	it("per-account overage activity: account A's active bucket does not leak into account B's", () => {
		usageBus.snapshotFromClaudeUsage(ENTERPRISE_FUNDAMENTAL, Date.now(), "accountA");
		// account B has never had a complete snapshot confirm its bucket is active, so a partial
		// overage event for B is still suppressed even though A's bucket is active.
		const suppressed = usageBus.snapshotFromClaudeRateLimitInfo(
			{ status: "allowed_warning", rateLimitType: "overage", utilization: 0.9, resetsAt: 1_790_812_800 },
			Date.now(),
			"accountB",
		);
		assert.equal(suppressed, undefined);
		const shown = usageBus.snapshotFromClaudeRateLimitInfo(
			{ status: "allowed_warning", rateLimitType: "overage", utilization: 0.9, resetsAt: 1_790_812_800 },
			Date.now(),
			"accountA",
		);
		assert.ok(shown, "account A's bucket is active");
	});

	it("isOverageEventMissingUtilization: true for the enterprise overage fixture, false once unifiedWindows or utilization is present", () => {
		assert.equal(usageBus.isOverageEventMissingUtilization(OVERAGE_EVENT_ENTERPRISE), true);
		assert.equal(usageBus.isOverageEventMissingUtilization({ ...OVERAGE_EVENT_ENTERPRISE, utilization: 0.1 }), false);
		assert.equal(usageBus.isOverageEventMissingUtilization({ ...OVERAGE_EVENT_ENTERPRISE, unifiedWindows: {} }), false);
		assert.equal(usageBus.isOverageEventMissingUtilization({ rateLimitType: "five_hour" }), false, "not an overage type");
		assert.equal(usageBus.isOverageEventMissingUtilization(undefined), false);
	});

	it("snapshotFromClaudeRateLimitInfo never builds a window for an overage event with no utilization", () => {
		assert.equal(usageBus.snapshotFromClaudeRateLimitInfo(OVERAGE_EVENT_ENTERPRISE, Date.now(), "fundamental"), undefined);
	});

	it("an enterprise turn's overage event requests exactly one debounced refresh and never publishes an empty window; the refresh carries the remembered resetsAt", async () => {
		clearBus();
		__test.setUsageControlQuery((input) => ({
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return ENTERPRISE_FUNDAMENTAL; },
			close() {},
		}));
		acc.resetAccountStateForTest();
		const fundamental = { id: "c33cb52c", name: "fundamental", configDir: "/tmp/accounts/c33cb52c" };
		acc.setActiveAccount(fundamental);
		const handlers = activateHarness();
		handlers.get("session_start")({ reason: "startup" }, sessionContext(process.cwd(), "enterprise-session"));
		const events = [];
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		try {
			const overageEvent = { type: "rate_limit_event", rate_limit_info: OVERAGE_EVENT_ENTERPRISE };
			await consume([overageEvent]);
			await consume([overageEvent]);
			await consume([overageEvent]);
			await __test.waitForOverageRefresh(fundamental.id);
			// Exactly one refresh was requested (debounced) across all three events, so exactly one
			// snapshot was published — never an empty placeholder window for the event itself.
			assert.equal(events.length, 1, "exactly one refresh was requested and published");
			const published = events[0];
			assert.equal(published.type, "snapshot");
			const window = published.snapshot.windows.find((w) => w.scope.kind === "overage");
			assert.ok(window, "the published snapshot carries real spend data, not an empty window");
			assert.equal(window.usedAmount, 69.44);
			assert.equal(window.resetsAt, 1793491200);
		} finally {
			unsubscribe();
			handlers.get("session_shutdown")();
			__test.setUsageControlQuery();
			__test.resetOverageRefreshDebounceForTest();
			acc.resetAccountStateForTest();
		}
	});
});

describe("standalone provider warning policy", () => {
	it("persists before the first soft notification and suppresses later queries", () => {
		const order = [];
		const entries = [];
		const notifications = [];
		warningState.restoreStandaloneWarningState({ sessionManager: { getEntries: () => [] } });
		const context = {
			appendEntry(customType, data) { order.push("append"); entries.push({ customType, data }); },
			ui: { notify(message, level) { order.push("notify"); notifications.push({ message, level }); } },
		};
		const first = { version: 1, type: "soft-warning", provider: "claude", message: "first" };
		const second = { version: 1, type: "soft-warning", provider: "claude", message: "second" };

		warningState.notifyWithStandaloneSessionPolicy(first, context);
		warningState.notifyWithStandaloneSessionPolicy(second, context);

		assert.deepEqual(order, ["append", "notify"]);
		assert.deepEqual(notifications, [{ message: "first", level: "warning" }]);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].customType, "provider-usage:warning-v1");
		assert.equal(entries[0].data.provider, "claude");
		assert.equal(typeof entries[0].data.shownAt, "number");
	});

	it("routes query, reentrant, and subagent warnings through one session allowance", async () => {
		clearBus();
		const notifications = [];
		const markers = [];
		__test.beginStandaloneWarningSession(
			{ appendEntry(customType, data) { markers.push({ customType, data }); } },
			{
				sessionManager: { getEntries: () => [] },
				ui: { notify(message) { notifications.push(message); } },
			},
			true,
		);
		const soft = (utilization) => ({
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		});

		await consume([soft(0.51)]); // top-level query
		await consume([soft(0.62)]); // reentrant query
		await consume([soft(0.78)]); // simulated subagent query
		assert.equal(markers.length, 1);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /51% used/);
	});

	it("suppresses fallback when pi-usage left a valid handled marker", async () => {
		clearBus();
		const notifications = [];
		const markers = [];
		const sessionEntries = [
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "claude", shownAt: 1 } },
		];
		__test.beginStandaloneWarningSession(
			{ appendEntry(customType, data) { markers.push({ customType, data }); } },
			{
				sessionManager: { getEntries: () => sessionEntries },
				ui: { notify(message) { notifications.push(message); } },
			},
			false,
		);

		await consume([{
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization: 0.8, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		}]);
		assert.deepEqual(markers, []);
		assert.deepEqual(notifications, []);
	});

	it("falls back after a listener without a marker disappears", async () => {
		clearBus();
		const notifications = [];
		const sessionEntries = [];
		const markers = [];
		__test.beginStandaloneWarningSession(
			{
				appendEntry(customType, data) {
					markers.push({ customType, data });
					sessionEntries.push({ type: "custom", customType, data });
				},
			},
			{
				sessionManager: { getEntries: () => sessionEntries },
				ui: { notify(message) { notifications.push(message); } },
			},
			false,
		);
		const soft = (utilization) => ({
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		});
		const unsubscribe = usageBus.getUsageBusV1().subscribe(() => { throw new Error("listener failed before persisting"); });
		await consume([soft(0.81)]);
		unsubscribe();
		await consume([soft(0.82)]);

		assert.equal(markers.length, 1);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /82% used/);
	});

	it("does not duplicate the normal listener path once its marker is durable", async () => {
		clearBus();
		const notifications = [];
		const sessionEntries = [];
		const bridgeMarkers = [];
		__test.beginStandaloneWarningSession(
			{ appendEntry(customType, data) { bridgeMarkers.push({ customType, data }); } },
			{
				sessionManager: { getEntries: () => sessionEntries },
				ui: { notify(message) { notifications.push(message); } },
			},
			false,
		);
		const soft = (utilization) => ({
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		});
		let listenerEvents = 0;
		const unsubscribe = usageBus.getUsageBusV1().subscribe((event) => {
			if (event.type !== "soft-warning") return;
			listenerEvents++;
			sessionEntries.push({
				type: "custom",
				customType: "provider-usage:warning-v1",
				data: { provider: event.provider, shownAt: Date.now() },
			});
		});
		await consume([soft(0.83)]);
		unsubscribe();
		await consume([soft(0.91)]);

		assert.equal(listenerEvents, 1);
		assert.deepEqual(bridgeMarkers, []);
		assert.deepEqual(notifications, []);
	});

	it("keeps every rejected notice and its following failed result visible", async () => {
		clearBus();
		const notifications = [];
		__test.beginStandaloneWarningSession(
			{ appendEntry() {} },
			{
				sessionManager: { getEntries: () => [] },
				ui: { notify(message) { notifications.push(message); } },
			},
			true,
		);
		const rejection = {
			type: "rate_limit_event",
			rate_limit_info: { status: "rejected", utilization: 1, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		};
		const failure = { type: "result", subtype: "success", is_error: true, result: "out of usage" };
		const first = await consume([rejection, failure]);
		const second = await consume([rejection, failure]);

		assert.equal(notifications.length, 2);
		assert.match(first.turnOutput.errorMessage, /Claude rate limit.*out of usage/);
		assert.match(second.turnOutput.errorMessage, /Claude rate limit.*out of usage/);
	});

	it("validates restored markers, resets forks, and always shows hard limits", () => {
		const inherited = [
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "claude", shownAt: 1 } },
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "codex", shownAt: "bad" } },
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "other", shownAt: 1 } },
		];
		const notifications = [];
		const entries = [];
		const context = {
			appendEntry(customType, data) { entries.push({ customType, data }); },
			ui: { notify(message) { notifications.push(message); } },
		};
		warningState.restoreStandaloneWarningState({ sessionManager: { getEntries: () => inherited } });
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "soft-warning", provider: "claude", message: "restored" }, context,
		);
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "hard-limit", provider: "claude", message: "hard one" }, context,
		);
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "hard-limit", provider: "claude", message: "hard two" }, context,
		);
		assert.deepEqual(notifications, ["hard one", "hard two"]);
		assert.deepEqual(entries, []);

		warningState.resetStandaloneWarningState();
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "soft-warning", provider: "claude", message: "fork allowance" }, context,
		);
		assert.deepEqual(notifications, ["hard one", "hard two", "fork allowance"]);
		assert.equal(entries.length, 1);
	});
});

describe("refresh on every account switch", () => {
	const accountA = { id: "a1", name: "a", configDir: "/tmp/accounts/a1" };
	const accountB = { id: "b1", name: "b", configDir: "/tmp/accounts/b1" };

	afterEach(() => {
		acc.resetAccountStateForTest();
	});

	it("a switch to a different account refreshes and publishes a snapshot stamped with the new account, in its own env", async () => {
		clearBus();
		let queryInput;
		let usageCalls = 0;
		__test.setUsageControlQuery((input) => {
			queryInput = input;
			return {
				async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { usageCalls++; return ACCOUNT_USAGE; },
				close() {},
			};
		});
		acc.setActiveAccount(accountA);
		const handlers = activateHarness();
		handlers.get("session_start")({ reason: "startup" }, sessionContext(process.cwd(), "switch-session"));
		const events = [];
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		try {
			acc.setActiveAccount(accountB);
			await __test.waitForOverageRefresh(accountB.id);
			assert.equal(usageCalls, 1, "exactly one refresh");
			assert.equal(queryInput.options.env.CLAUDE_CONFIG_DIR, accountB.configDir, "refreshed in the new account's env");
			assert.equal(events.length, 1, "one published snapshot");
			assert.equal(events[0].type, "snapshot");
			assert.equal(events[0].snapshot.account.id, accountB.id);
		} finally {
			unsubscribe();
			handlers.get("session_shutdown")();
			__test.setUsageControlQuery();
		}
	});

	it("switching to the already-active account is a no-op: no refresh", async () => {
		clearBus();
		let usageCalls = 0;
		__test.setUsageControlQuery(() => ({
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { usageCalls++; return ACCOUNT_USAGE; },
			close() {},
		}));
		acc.setActiveAccount(accountB);
		const handlers = activateHarness();
		handlers.get("session_start")({ reason: "startup" }, sessionContext(process.cwd(), "switch-session"));
		const events = [];
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		try {
			acc.setActiveAccount({ ...accountB }); // a different object, same id: not a real switch
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(usageCalls, 0);
			assert.equal(events.length, 0);
		} finally {
			unsubscribe();
			handlers.get("session_shutdown")();
			__test.setUsageControlQuery();
		}
	});

	it("only the adapter owner refreshes on a switch: a second in-process activate() never duplicates it", async () => {
		clearBus();
		let usageCalls = 0;
		__test.setUsageControlQuery(() => ({
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { usageCalls++; return ACCOUNT_USAGE; },
			close() {},
		}));
		acc.setActiveAccount(accountA);
		const ownerHandlers = activateHarness();
		ownerHandlers.get("session_start")({ reason: "startup" }, sessionContext(process.cwd(), "owner-session"));
		// A second in-process activate() call, as pi's subagent/child-session factory
		// path does: shares this module instance but must not own the usage adapter.
		const childHandlers = activateHarness();
		childHandlers.get("session_start")({ reason: "startup" }, sessionContext(process.cwd(), "child-session"));
		const events = [];
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		try {
			acc.setActiveAccount(accountB);
			await __test.waitForOverageRefresh(accountB.id);
			assert.equal(usageCalls, 1, "exactly one refresh across owner + child");
			assert.equal(events.length, 1, "exactly one published snapshot");
			assert.equal(events[0].snapshot.account.id, accountB.id);

			// Shut the owner down; the child is still subscribed but must stay a no-op.
			ownerHandlers.get("session_shutdown")();
			acc.setActiveAccount(accountA);
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(usageCalls, 1, "no refresh from the child after the owner shut down");
			assert.equal(events.length, 1, "no further published snapshot");
		} finally {
			unsubscribe();
			childHandlers.get("session_shutdown")();
			__test.setUsageControlQuery();
		}
	});

	it("a switch-all notice refreshes exactly like a direct switch", async () => {
		clearBus();
		let queryInput;
		__test.setUsageControlQuery((input) => {
			queryInput = input;
			return {
				async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return ACCOUNT_USAGE; },
				close() {},
			};
		});
		acc.setActiveAccount(accountA);
		const handlers = activateHarness();
		handlers.get("session_start")({ reason: "startup" }, sessionContext(process.cwd(), "switch-session"));
		const events = [];
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		try {
			// account-command.ts's applyNotice calls the same acc.setActiveAccount this hook listens on.
			acc.setActiveAccount(accountB);
			await __test.waitForOverageRefresh(accountB.id);
			assert.equal(events.length, 1);
			assert.equal(events[0].snapshot.account.id, accountB.id);
			assert.equal(queryInput.options.env.CLAUDE_CONFIG_DIR, accountB.configDir);
		} finally {
			unsubscribe();
			handlers.get("session_shutdown")();
			__test.setUsageControlQuery();
		}
	});
});
