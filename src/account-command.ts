// /claude-account: the command and its subcommands, the panel host, and the
// session wiring that restores each session's account and shows it in the footer.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	ACCOUNT_ENTRY_TYPE,
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

export interface AccountsWiringDeps {
	root?: string;
	startSignin?(account: Account): SigninRun;
	readStatus?(account: Account): Promise<AuthStatus>;
	signOut?(account: Account): Promise<void>;
}

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "add", label: "add", description: "Sign in another account in your browser" },
	{ value: "list", label: "list", description: "List the accounts" },
	{ value: "default", label: "default", description: "Set the account new sessions start on" },
	{ value: "remove", label: "remove", description: "Sign out and remove an account" },
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
	if (words.length === 2 && ["default", "remove", "use"].includes(words[0]!)) {
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
		}
		refreshStatus();
	});

	pi.on("model_select", (event) => {
		bridgeActive = event?.model?.baseUrl === "claude-bridge";
		refreshStatus();
	});

	// Hosts and test doubles without commands still get the session wiring.
	if (typeof pi.registerCommand !== "function") return;
	pi.registerCommand("claude-account", {
		description: "Claude accounts; or <name> | add <name> | default <name> | list | remove <name>",
		getArgumentCompletions: (prefix) => accountCompletions(prefix, loadRegistry(root).registry.accounts),
		handler: (args, ctx) => handle(args, ctx),
	});

	async function handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
		ui = ctx.ui;
		bridgeActive = ctx.model?.baseUrl === "claude-bridge";
		const [sub, arg] = args.trim().split(/\s+/).filter(Boolean);
		const report = (result: Result<unknown>, text: string) => {
			if (result.ok) ctx.ui.notify(text, "info");
			else ctx.ui.notify(result.reason, "warning");
		};
		const usage = () => ctx.ui.notify("usage: /claude-account [<name> | use <name> | add <name> | default <name> | list | remove <name>]", "warning");

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
