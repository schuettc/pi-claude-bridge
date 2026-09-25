// Account operations shared by the /claude-account panel and its subcommands.
// Every change reloads accounts.json just before writing it, so two panes
// editing accounts do not overwrite each other's additions.
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import {
	byId,
	byName,
	getActiveAccount,
	LAUNCH_ACCOUNT,
	LAUNCH_ID,
	loadRegistry,
	newAccountId,
	saveRegistry,
	setActiveAccount,
	validateName,
	type Account,
	type LoadedRegistry,
	type Registry,
} from "./accounts.js";
import type { AuthStatus, SigninRun } from "./signin.js";

// Both branches name both fields: the repo compiles without strictNullChecks,
// where `!result.ok` does not narrow the union, so `.reason` must be readable on it.
export type Result<T> = { ok: true; value: T; reason?: undefined } | { ok: false; value?: undefined; reason: string };

export interface SigninOutcome {
	status: AuthStatus;
	rewritten: boolean;
}

export interface AccountServiceDeps {
	root: string;
	startSignin(account: Account): SigninRun;
	readStatus(account: Account): Promise<AuthStatus>;
	signOut(account: Account): Promise<void>;
	/** This session now uses `account`: record it and refresh the footer. */
	onSwitch(account: Account): void;
	/** The accounts changed in a way the footer may show. */
	onChange(): void;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });
// The failure reason of a result known to have failed. The repo compiles without
// strictNullChecks, so `!result.ok` does not narrow the union by itself.
const reasonOf = (result: Result<unknown> | { ok: boolean; reason?: string }): string => (result as { reason: string }).reason;

export class AccountService {
	#deps: AccountServiceDeps;

	constructor(deps: AccountServiceDeps) {
		this.#deps = deps;
	}

	load(): LoadedRegistry {
		return loadRegistry(this.#deps.root);
	}

	active(): Account {
		return getActiveAccount();
	}

	switchTo(name: string): Result<Account> {
		const account = byName(this.load().registry, name);
		if (!account) return fail(`No account named "${name}".`);
		setActiveAccount(account);
		this.#deps.onSwitch(account);
		return ok(account);
	}

	setDefault(name: string): Result<Account> {
		return this.#mutate<Account>((registry) => {
			const account = byName(registry, name);
			if (!account) return fail<Account>(`No account named "${name}".`);
			registry.default = account.id;
			return ok(account);
		});
	}

	rename(name: string, next: string): Result<Account> {
		const result = this.#mutate((registry) => {
			const account = byName(registry, name);
			if (!account) return fail<Account>(`No account named "${name}".`);
			const problem = validateName(next, registry, account.id);
			if (problem) return fail<Account>(`Not renamed: ${problem}.`);
			account.name = next;
			return ok(account);
		});
		if (result.ok) {
			if (getActiveAccount().id === result.value.id) setActiveAccount(result.value);
			this.#deps.onChange();
		}
		return result;
	}

	async remove(name: string): Promise<Result<{ switchedTo?: Account; keptFolder?: string }>> {
		const { registry, problem } = this.load();
		if (problem) return fail(`The accounts file has a problem, so nothing was changed: ${problem}`);
		const account = byName(registry, name);
		if (!account) return fail(`No account named "${name}".`);
		if (account.id === LAUNCH_ID) return fail("The login pi started with can't be removed; rename it instead.");
		await this.#deps.signOut(account);
		const saved = this.#mutate<Registry>((current) => {
			current.accounts = current.accounts.filter((a) => a.id !== account.id);
			if (current.default === account.id) current.default = LAUNCH_ID;
			return ok(current);
		});
		if (!saved.ok) return fail(reasonOf(saved));
		// Only a folder the bridge created is deleted. accounts.json can be edited by
		// hand, and a recursive delete of someone's real config folder is not undoable.
		const keptFolder = this.#owns(account.configDir!) ? undefined : account.configDir!;
		if (!keptFolder) rmSync(account.configDir!, { recursive: true, force: true });
		let switchedTo: Account | undefined;
		if (getActiveAccount().id === account.id) {
			switchedTo = byId(saved.value, saved.value.default) ?? { ...LAUNCH_ACCOUNT };
			setActiveAccount(switchedTo);
			this.#deps.onSwitch(switchedTo);
		} else {
			this.#deps.onChange();
		}
		return ok({ switchedTo, keptFolder });
	}

	async add(name: string, onStart?: (run: SigninRun) => void): Promise<Result<{ account: Account } & SigninOutcome>> {
		const { registry, problem } = this.load();
		if (problem) return fail(`The accounts file has a problem, so nothing was changed: ${problem}`);
		const invalid = validateName(name, registry);
		if (invalid) return fail(`Not added: ${invalid}.`);
		const id = newAccountId(registry);
		const configDir = join(this.#deps.root, "accounts", id);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const account: Account = { id, name, configDir };
		const signedIn = await this.#signIn(account, onStart);
		if (!signedIn.ok) {
			rmSync(configDir, { recursive: true, force: true });
			return fail(reasonOf(signedIn));
		}
		const saved = this.#mutate<undefined>((current) => {
			const again = validateName(name, current);
			if (again) return fail<undefined>(`Not added: ${again}.`);
			current.accounts.push(account);
			return ok(undefined);
		});
		if (!saved.ok) {
			await this.#deps.signOut(account);
			rmSync(configDir, { recursive: true, force: true });
			return fail(reasonOf(saved));
		}
		this.#deps.onChange();
		return ok({ account, ...signedIn.value });
	}

	async signInAgain(name: string, onStart?: (run: SigninRun) => void): Promise<Result<SigninOutcome>> {
		const account = byName(this.load().registry, name);
		if (!account) return fail(`No account named "${name}".`);
		return this.#signIn(account, onStart);
	}

	async #signIn(account: Account, onStart?: (run: SigninRun) => void): Promise<Result<SigninOutcome>> {
		const run = this.#deps.startSignin(account);
		onStart?.(run);
		const result = await run.done;
		if (!result.ok) return fail((result as { cancelled: boolean }).cancelled ? "cancelled" : `Sign-in didn't finish: ${reasonOf(result)}`);
		const status = await this.#deps.readStatus(account);
		if (!status.loggedIn) return fail(`Sign-in didn't finish: ${status.problem ?? "Claude Code reports no login for this account"}`);
		return ok({ status, rewritten: result.rewritten });
	}

	/** Whether `dir` really lies inside <root>/accounts/ (symlinks and .. resolved). */
	#owns(dir: string): boolean {
		const real = (path: string) => {
			try { return realpathSync(path); } catch { return undefined; }
		};
		const base = real(join(this.#deps.root, "accounts"));
		const target = real(dir);
		if (!base || !target) return false;
		const rel = relative(base, target);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	}

	#mutate<T>(change: (registry: Registry) => Result<T>): Result<T> {
		const { registry, problem } = this.load();
		if (problem) return fail(`The accounts file has a problem, so nothing was changed: ${problem}`);
		const result = change(registry);
		if (result.ok) saveRegistry(this.#deps.root, registry);
		return result;
	}
}
