// Several Claude subscription accounts in one pi install. This module owns the
// registry file, the process-wide active account, and the resolver that every
// Claude Code child environment and every session-file call goes through.
//
// Each account is a Claude Code config directory signed in with `claude auth
// login`. The launch account (id "launch") is the login pi was started with: its
// environment passes through untouched, because on macOS an unset
// CLAUDE_CONFIG_DIR and an explicit ~/.claude are different Keychain entries.
// Credentials never pass through this module.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const LAUNCH_ID = "launch";
export const ACCOUNT_ENTRY_TYPE = "claude-bridge-account";
// Subcommand words of /claude-account: an account with one of these names could
// not be switched to by name.
export const RESERVED_NAMES: readonly string[] = ["add", "list", "remove", "use"];
// An environment credential outranks a config directory's stored login, so a
// named account must not inherit one (verified in upstream PR #60).
const TOKEN_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Account {
	id: string;
	name: string;
	configDir: string | null;
}

export interface Registry {
	version: 1;
	default: string;
	accounts: Account[];
}

export interface LoadedRegistry {
	registry: Registry;
	problem?: string;
}

export interface AccountEntryData {
	id: string;
	name: string;
}

export const LAUNCH_ACCOUNT: Readonly<Account> = Object.freeze({ id: LAUNCH_ID, name: "default", configDir: null });

export function accountsRoot(agentDir = getAgentDir()): string {
	return join(agentDir, "claude-bridge");
}

export function registryPath(root: string): string {
	return join(root, "accounts.json");
}

export function defaultRegistry(): Registry {
	return { version: 1, default: LAUNCH_ID, accounts: [{ ...LAUNCH_ACCOUNT }] };
}

/** Read the registry. A missing file is the launch account alone; an unreadable
 *  one is the same, plus a problem the caller must report and must not overwrite. */
export function loadRegistry(root: string): LoadedRegistry {
	const path = registryPath(root);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { registry: defaultRegistry() };
		return { registry: defaultRegistry(), problem: `cannot read ${path}: ${(error as Error).message}` };
	}
	try {
		return { registry: parseRegistry(JSON.parse(text)) };
	} catch (error) {
		return { registry: defaultRegistry(), problem: `${path} is not a valid accounts file: ${(error as Error).message}` };
	}
}

function parseRegistry(raw: any): Registry {
	if (!raw || raw.version !== 1 || !Array.isArray(raw.accounts)) throw new Error("expected version 1 with an accounts list");
	const accounts: Account[] = [];
	for (const entry of raw.accounts) {
		if (typeof entry?.id !== "string" || typeof entry?.name !== "string") throw new Error("an account is missing its id or name");
		const launch = entry.id === LAUNCH_ID;
		if (launch ? entry.configDir !== null : typeof entry.configDir !== "string") {
			throw new Error(`account "${entry.name}": only the launch account has no configDir`);
		}
		accounts.push({ id: entry.id, name: entry.name, configDir: entry.configDir });
	}
	if (!accounts.some((a) => a.id === LAUNCH_ID)) accounts.unshift({ ...LAUNCH_ACCOUNT });
	const def = accounts.some((a) => a.id === raw.default) ? raw.default : LAUNCH_ID;
	return { version: 1, default: def, accounts };
}

/** Write atomically (temp file + rename) with mode 0600. */
export function saveRegistry(root: string, registry: Registry): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = registryPath(root);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** A reason the name is unusable, or undefined when it is fine. */
export function validateName(name: string, registry: Registry, exceptId?: string): string | undefined {
	if (!NAME_PATTERN.test(name)) return "use lowercase letters, digits and -, up to 32 characters, starting with a letter or digit";
	if (RESERVED_NAMES.includes(name)) return `"${name}" is reserved for a /claude-account subcommand`;
	if (registry.accounts.some((a) => a.name === name && a.id !== exceptId)) return `an account named "${name}" already exists`;
	return undefined;
}

export function newAccountId(registry: Registry): string {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (id !== LAUNCH_ID && !registry.accounts.some((a) => a.id === id)) return id;
	}
}

export function byId(registry: Registry, id: string): Account | undefined {
	return registry.accounts.find((a) => a.id === id);
}

export function byName(registry: Registry, name: string): Account | undefined {
	return registry.accounts.find((a) => a.name === name);
}

// One active account per pi process, on globalThis so every module copy (a
// subagent can load this module fresh) sees the same one.
const STATE_KEY = Symbol.for("pi-claude-bridge.accounts.v1");

interface AccountState {
	active: Account;
	// Whether a top-level session_start has applied a session's account yet. A
	// later "startup" is an in-process subagent session and must leave it alone.
	restored: boolean;
}

export function accountState(): AccountState {
	const g = globalThis as Record<symbol, AccountState | undefined>;
	return (g[STATE_KEY] ??= { active: LAUNCH_ACCOUNT, restored: false });
}

export function getActiveAccount(): Account {
	return accountState().active;
}

export function setActiveAccount(account: Account): void {
	accountState().active = account;
}

export function resetAccountStateForTest(): void {
	delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
}

/** The Claude Code child environment for an account. Never modifies `base`. */
export function accountEnv(base: Record<string, string | undefined>, account: Account): Record<string, string | undefined> {
	if (account.configDir === null) return base;
	const env: Record<string, string | undefined> = { ...base, CLAUDE_CONFIG_DIR: account.configDir };
	for (const key of TOKEN_VARS) delete env[key];
	return env;
}

/** The directory an account's Claude Code session files live under. */
export function accountClaudeDir(account: Account): string | undefined {
	return account.configDir ?? process.env.CLAUDE_CONFIG_DIR;
}

/** The account a session should run on: its latest account entry, else the default. */
export function restoreAccount(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
	registry: Registry,
): { account: Account; notice?: string } {
	const fallback = byId(registry, registry.default) ?? LAUNCH_ACCOUNT;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== ACCOUNT_ENTRY_TYPE) continue;
		const data = entry.data as Partial<AccountEntryData> | undefined;
		if (typeof data?.id !== "string") continue;
		const found = byId(registry, data.id);
		if (found) return { account: found };
		return { account: fallback, notice: `Account "${data.name ?? data.id}" no longer exists; using ${fallback.name}.` };
	}
	return { account: fallback };
}

/** Claude Code's not-logged-in error, restated with the account name. */
export function signedOutText(text: string, account: Account): string | undefined {
	return /^Not logged in\b/.test(text)
		? `Claude account "${account.name}" is signed out. /claude-account to sign in again.`
		: undefined;
}
