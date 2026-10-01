// /claude-account: the command and its subcommands, the panel host, and the
// session wiring that restores each session's account and shows it in the footer.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { SwitchAllListener, type SwitchAllNotice } from "./account-broadcast.js";
import {
	ACCOUNT_ENTRY_TYPE,
	byId,
	accountState,
	accountsRoot,
	getActiveAccount,
	loadRegistry,
	restoreAccount,
	setActiveAccount,
	type Account,
	type AccountEntryData,
} from "./accounts.js";
import { AccountService, type Result } from "./account-service.js";
import { AccountsPanel } from "./accounts-panel.js";
import { loadConfig } from "./config.js";
import { BOX_WIDTH } from "./panel-box.js";
import { readAuthStatus, signOut, startSignin, type AuthStatus, type SigninRun } from "./signin.js";

export const STATUS_KEY = "claude-account";

// The one listener per process that applies "use in all sessions" notices. It
// belongs to the top-level session; an in-process subagent session never claims
// it, so a switch is recorded in the session the user is looking at.
const LISTENER_KEY = Symbol.for("pi-claude-bridge.switch-all-listener.v1");
type Owned = { listener: SwitchAllListener };
const owned = () => (globalThis as Record<symbol, Owned | undefined>)[LISTENER_KEY];
const setOwned = (value: Owned | undefined) => { (globalThis as Record<symbol, Owned | undefined>)[LISTENER_KEY] = value; };

export function resetSwitchAllForTest(): void {
	owned()?.listener.stop();
	setOwned(undefined);
}

export interface AccountsWiringDeps {
	root?: string;
	startSignin?(account: Account): SigninRun;
	readStatus?(account: Account): Promise<AuthStatus>;
	signOut?(account: Account): Promise<void>;
}

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "add", label: "add", description: "Sign in another account in your browser" },
	{ value: "all", label: "all", description: "Switch this and every open session to an account" },
	{ value: "list", label: "list", description: "List the accounts" },
	{ value: "default", label: "default", description: "Set the account new sessions start on" },
	{ value: "remove", label: "remove", description: "Sign out and remove an account" },
	{ value: "rename", label: "rename", description: "Rename an account: rename <old> <new>" },
	{ value: "use", label: "use", description: "Switch this session to an account" },
];

export function accountCompletions(prefix: string, accounts: Account[]): AutocompleteItem[] | null {
	const words = prefix.split(/\s+/);
	const names = accounts.map((a) => ({ value: a.name, label: a.name, description: "Switch this session to this account" }));
	if (words.length <= 1) {
		const first = words[0] ?? "";
		const items = [...SUBCOMMANDS, ...names].filter((item) => item.value.startsWith(first));
		return items.length ? items : null;
	}
	if (words.length === 2 && ["all", "default", "remove", "rename", "use"].includes(words[0]!)) {
		const items = names
			.filter((item) => item.value.startsWith(words[1]!))
			.map((item) => ({ ...item, value: `${words[0]} ${item.value}` }));
		return items.length ? items : null;
	}
	return null;
}

export function registerAccounts(pi: ExtensionAPI, deps: AccountsWiringDeps = {}): void {
	const root = deps.root ?? accountsRoot();
	const claudeBin = () => loadConfig(process.cwd()).provider?.pathToClaudeCodeExecutable ?? "claude";
	const readStatus = deps.readStatus ?? ((account: Account) => readAuthStatus(account, { claudeBin: claudeBin() }));
	let ui: ExtensionCommandContext["ui"] | undefined;
	let bridgeActive = false;

	// Shown only while a bridge model is active and there is more than one account.
	const refreshStatus = () => {
		const several = loadRegistry(root).registry.accounts.length > 1;
		ui?.setStatus?.(STATUS_KEY, bridgeActive && several ? `claude: ${getActiveAccount().name}` : undefined);
	};

	const service = new AccountService({
		root,
		startSignin: deps.startSignin ?? ((account) => startSignin(account, { claudeBin: claudeBin() })),
		readStatus,
		signOut: deps.signOut ?? ((account) => signOut(account, { claudeBin: claudeBin() })),
		onSwitch: (account) => {
			pi.appendEntry<AccountEntryData>(ACCOUNT_ENTRY_TYPE, { id: account.id, name: account.name });
			refreshStatus();
		},
		onChange: refreshStatus,
	});

	let mine: Owned | undefined;
	const applyNotice = (notice: SwitchAllNotice) => {
		const account = byId(loadRegistry(root).registry, notice.id);
		if (!account || account.id === getActiveAccount().id) return;
		setActiveAccount(account);
		pi.appendEntry<AccountEntryData>(ACCOUNT_ENTRY_TYPE, { id: account.id, name: account.name });
		refreshStatus();
		ui?.notify?.(`Switched to ${account.name} from another pane (from the next turn).`, "info");
	};
	// Claimed at each top-level session start, so a notice already on disk then
	// counts as history, and released when the session shuts down.
	const claimListener = () => {
		owned()?.listener.stop();
		mine = { listener: new SwitchAllListener(root, applyNotice) };
		mine.listener.start();
		setOwned(mine);
	};
	const ownsListener = () => mine !== undefined && owned() === mine;

	pi.on("session_start", (event, ctx) => {
		ui = ctx?.ui;
		bridgeActive = ctx?.model?.baseUrl === "claude-bridge";
		const state = accountState();
		// A later "startup" is an in-process subagent session: it runs on its
		// parent's account, so only a top-level start applies a session's account.
		if (event?.reason !== "startup" || !state.restored) {
			const { registry, problem } = loadRegistry(root);
			const restored = restoreAccount(ctx?.sessionManager?.getBranch?.() ?? [], registry);
			setActiveAccount(restored.account);
			state.restored = true;
			if (restored.notice) ctx?.ui?.notify?.(restored.notice, "warning");
			if (problem) ctx?.ui?.notify?.(`Claude accounts: ${problem}. Using your usual login.`, "warning");
			claimListener();
		}
		refreshStatus();
	});

	// A turn picks up a notice the file watcher missed, before the bridge captures
	// the turn's account.
	pi.on("turn_start", () => {
		if (ownsListener()) mine!.listener.check();
	});

	pi.on("session_shutdown", () => {
		if (!ownsListener()) return;
		mine!.listener.stop();
		setOwned(undefined);
		mine = undefined;
	});

	pi.on("model_select", (event) => {
		bridgeActive = event?.model?.baseUrl === "claude-bridge";
		refreshStatus();
	});

	// Hosts and test doubles without commands still get the session wiring.
	if (typeof pi.registerCommand !== "function") return;
	pi.registerCommand("claude-account", {
		description: "Claude accounts; or <name> | all <name> | add <name> | default <name> | rename <old> <new> | list | remove <name>",
		getArgumentCompletions: (prefix) => accountCompletions(prefix, loadRegistry(root).registry.accounts),
		handler: (args, ctx) => handle(args, ctx),
	});

	async function handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
		ui = ctx.ui;
		bridgeActive = ctx.model?.baseUrl === "claude-bridge";
		const [sub, arg, arg2] = args.trim().split(/\s+/).filter(Boolean);
		const report = (result: Result<unknown>, text: string) => {
			if (result.ok) ctx.ui.notify(text, "info");
			else ctx.ui.notify(result.reason, "warning");
		};
		const usage = () => ctx.ui.notify("usage: /claude-account [<name> | use <name> | all <name> | add <name> | default <name> | rename <old> <new> | list | remove <name>]", "warning");

		if (!sub) {
			if (ctx.mode === "tui") await openPanel(ctx);
			else ctx.ui.notify(await listText(), "info");
			return;
		}
		if (sub === "list") {
			ctx.ui.notify(await listText(), "info");
			return;
		}
		if (sub === "add") {
			if (!arg) return usage();
			ctx.ui.notify(`Opening your browser to sign in ${arg}…`, "info");
			const result = await service.add(arg);
			if (!result.ok) return report(result, "");
			const as = result.value.status.email ? ` as ${result.value.status.email}` : "";
			const note = result.value.rewritten ? "" : " The browser opened without the sign-out step.";
			return report(result, `Signed in ${arg}${as}.${note}`);
		}
		if (sub === "default" && arg) return report(service.setDefault(arg), `New sessions start on ${arg}.`);
		if (sub === "all") {
			if (!arg) return usage();
			return report(service.switchAll(arg), `This session and every open session now use ${arg} (from the next turn).`);
		}
		if (sub === "rename") {
			if (!arg || !arg2) return usage();
			return report(service.rename(arg, arg2), `Renamed ${arg} to ${arg2}.`);
		}
		if (sub === "remove") {
			if (!arg) return usage();
			if (!ctx.hasUI) {
				ctx.ui.notify("Removing an account needs a confirmation; run it in the interactive TUI.", "warning");
				return;
			}
			if (!(await ctx.ui.confirm("Claude accounts", `Remove ${arg}? This signs it out and deletes its folder.`))) {
				ctx.ui.notify(`Kept ${arg}.`, "info");
				return;
			}
			const result = await service.remove(arg);
			const moved = result.ok && result.value.switchedTo ? ` This session now uses ${result.value.switchedTo.name}.` : "";
			const kept = result.ok && result.value.keptFolder ? ` Its folder was kept: ${result.value.keptFolder}` : "";
			return report(result, `Removed ${arg}.${moved}${kept}`);
		}
		// `/claude-account default` alone switches to the account named default.
		const name = sub === "use" ? arg : sub;
		if (!name) return usage();
		report(service.switchTo(name), `This session now uses ${name} (from the next turn).`);
	}

	async function listText(): Promise<string> {
		const { registry, problem } = service.load();
		const statuses = await Promise.all(registry.accounts.map((account) => readStatus(account)));
		const active = getActiveAccount().id;
		const lines = registry.accounts.map((account, i) => {
			const status = statuses[i]!;
			const detail = status.loggedIn ? [status.email, status.subscriptionType].filter(Boolean).join(" · ") : "signed out";
			return `${account.id === active ? "●" : " "} ${account.name}  ${detail}${account.id === registry.default ? "  (default)" : ""}`;
		});
		return [...(problem ? [`Accounts file problem: ${problem}`] : []), ...lines].join("\n");
	}

	async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => new AccountsPanel({
				service,
				readStatus,
				theme,
				requestRender: () => tui.requestRender(),
				onClose: () => done(undefined),
			}),
			{ overlay: true, overlayOptions: { anchor: "center", width: BOX_WIDTH } },
		);
	}
}
