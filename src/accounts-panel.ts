// The panel a bare /claude-account opens: one row per account, "+ Add account",
// the selected row's description, one message line, and a key-hint footer.
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { LAUNCH_ID, type Account } from "./accounts.js";
import type { AccountService, Result, SigninOutcome } from "./account-service.js";
import { BOX_WIDTH, PADDING, renderBox, type PanelTheme } from "./panel-box.js";
import type { AuthStatus, SigninRun } from "./signin.js";

type PanelService = Pick<AccountService, "load" | "active" | "switchTo" | "setDefault" | "rename" | "remove" | "add" | "signInAgain">;

export interface AccountsPanelOptions {
	service: PanelService;
	readStatus(account: Account): Promise<AuthStatus>;
	theme: PanelTheme;
	requestRender(): void;
	onClose(): void;
}

type Mode = "list" | "name" | "rename" | "confirmRemove" | "signingIn";

const INNER = BOX_WIDTH - 2 - PADDING * 2;
const NAME_WIDTH = 11;
const DEFAULT_TAG = " default";
const HELP_LINES = 3;
const FOOTERS: Record<Mode, string> = {
	list: "↑↓ select · enter use · d default · esc close",
	name: "enter save · esc back",
	rename: "enter save · esc back",
	confirmRemove: "y remove · any other key keeps it",
	signingIn: "esc cancel",
};
const WAITING_HELP = "On Claude's page, enter the account's email, click the link in the email, then Authorize.";

const plan = (type?: string) => (type ? type[0]!.toUpperCase() + type.slice(1) : undefined);

export class AccountsPanel implements Component {
	#o: AccountsPanelOptions;
	#mode: Mode = "list";
	#selected = 0;
	#accounts: Account[] = [];
	#defaultId = LAUNCH_ID;
	#status = new Map<string, AuthStatus | "loading">();
	#message: { kind: "ok" | "error"; text: string } | undefined;
	#input: Input | undefined;
	#target: Account | undefined;
	#signin: SigninRun | undefined;
	#pending: Promise<void> = Promise.resolve();

	constructor(options: AccountsPanelOptions) {
		this.#o = options;
		this.#reload();
		this.#loadStatuses(this.#accounts);
	}

	/** Resolves once every action started so far has finished. */
	idle(): Promise<void> {
		return this.#pending;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this.#o;
		const body: string[] = [];
		if (this.#mode === "list") {
			this.#accounts.forEach((account, index) => body.push(this.#row(account, index)));
			const onAdd = this.#selected === this.#accounts.length;
			body.push(`${onAdd ? theme.fg("accent", "→ ") : "  "}${theme.fg(onAdd ? "accent" : "text", "+ Add account")}`);
			body.push("");
			for (const line of wrapTextWithAnsi(this.#help(), INNER).slice(0, HELP_LINES)) body.push(theme.fg("dim", line));
		} else if (this.#mode === "name" || this.#mode === "rename") {
			body.push(theme.fg("dim", this.#mode === "name" ? "Name for the new account (a-z, 0-9, -)" : `New name for ${this.#target?.name}`));
			body.push(theme.fg("accent", this.#input?.render(INNER)[0] ?? ""));
		} else if (this.#mode === "confirmRemove") {
			for (const line of wrapTextWithAnsi(this.#removePrompt(), INNER)) body.push(theme.fg("warning", line));
		} else {
			body.push(theme.fg("accent", "waiting for browser sign-in…"), "");
			for (const line of wrapTextWithAnsi(WAITING_HELP, INNER)) body.push(theme.fg("dim", line));
		}
		// One height for every mode, so the centered overlay never jumps: the
		// rows, "+ Add account", a blank, the description, a blank.
		const height = this.#accounts.length + 1 + 1 + HELP_LINES + 1;
		while (body.length < height) body.push("");
		body.length = height;
		body.push(...this.#messageLines());
		return renderBox({ title: "🔑 claude · accounts", body, footer: FOOTERS[this.#mode], width, theme });
	}

	handleInput(data: string): void {
		const escape = matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
		if (this.#mode === "name" || this.#mode === "rename") {
			this.#input?.handleInput(data);
			this.#o.requestRender();
			return;
		}
		if (this.#mode === "signingIn") {
			if (escape) this.#signin?.cancel();
			return;
		}
		if (this.#mode === "confirmRemove") {
			const target = this.#target!;
			this.#mode = "list";
			if (data === "y" || data === "Y") this.#track(this.#remove(target));
			else this.#message = { kind: "ok", text: `Kept ${target.name}.` };
			this.#o.requestRender();
			return;
		}
		if (escape) {
			this.#o.onClose();
			return;
		}
		const count = this.#accounts.length + 1;
		const account = this.#accounts[this.#selected];
		if (matchesKey(data, "up") || data === "k") {
			this.#selected = (this.#selected + count - 1) % count;
			this.#message = undefined;
		} else if (matchesKey(data, "down") || data === "j") {
			this.#selected = (this.#selected + 1) % count;
			this.#message = undefined;
		} else if (matchesKey(data, "enter") || data === "\n" || data === " ") {
			if (account) this.#use(account);
			else this.#openInput("name", "");
		} else if (data === "d" && account) {
			this.#show(this.#o.service.setDefault(account.name), `New sessions start on ${account.name}.`);
		} else if (data === "r" && account) {
			this.#target = account;
			this.#openInput("rename", account.name);
		} else if (data === "x" && account) {
			if (account.id === LAUNCH_ID) this.#message = { kind: "error", text: "The login pi started with can't be removed; rename it instead." };
			else { this.#target = account; this.#mode = "confirmRemove"; }
		} else {
			return;
		}
		this.#o.requestRender();
	}

	#row(account: Account, index: number): string {
		const { theme } = this.#o;
		const selected = index === this.#selected;
		const pointer = selected ? theme.fg("accent", "→ ") : "  ";
		const name = truncateToWidth(account.name, NAME_WIDTH, "…");
		const namePadded = name + " ".repeat(Math.max(0, NAME_WIDTH - visibleWidth(name)));
		const mark = account.id === this.#o.service.active().id ? theme.fg("accent", "●  ") : "   ";
		const status = this.#status.get(account.id);
		const signedOut = status !== undefined && status !== "loading" && !status.loggedIn;
		const text = status === undefined || status === "loading"
			? "…"
			: status.loggedIn ? [status.email, plan(status.subscriptionType)].filter(Boolean).join(" · ") : "signed out";
		// The detail takes what the row has left, so a long email only gives way
		// to the default tag on the one row that carries it.
		const isDefault = account.id === this.#defaultId;
		const detailWidth = INNER - 2 - NAME_WIDTH - 3 - (isDefault ? DEFAULT_TAG.length : 0);
		const detail = truncateToWidth(text, detailWidth, "…");
		const detailPadded = isDefault ? detail + " ".repeat(Math.max(0, detailWidth - visibleWidth(detail))) : detail;
		const tag = isDefault ? theme.fg("muted", DEFAULT_TAG) : "";
		return `${pointer}${theme.fg(selected ? "accent" : "text", namePadded)}${mark}${theme.fg(signedOut ? "warning" : "dim", detailPadded)}${tag}`;
	}

	#help(): string {
		const account = this.#accounts[this.#selected];
		if (!account) return "Sign in another Claude account in your browser. The browser is signed out of claude.ai first.";
		const status = this.#status.get(account.id);
		if (status && status !== "loading" && !status.loggedIn) return "Signed out. Enter signs this account in again in your browser.";
		return `This session uses ${this.#o.service.active().name}. Enter switches this session; d sets default; r renames; x removes.`;
	}

	#removePrompt(): string {
		const target = this.#target!;
		const fallback = this.#accounts.find((a) => a.id === (this.#defaultId === target.id ? LAUNCH_ID : this.#defaultId));
		const moves = target.id === this.#o.service.active().id ? ` This session moves to ${fallback?.name ?? "default"}.` : "";
		return `Remove ${target.name}? This signs it out and deletes its folder.${moves} y/N`;
	}

	// Always two lines, so the box height never changes; a longer message is cut.
	#messageLines(): string[] {
		const { theme } = this.#o;
		if (!this.#message) return ["", ""];
		const { kind, text } = this.#message;
		const lines = wrapTextWithAnsi(`${kind === "ok" ? "✓" : "✗"} ${text}`, INNER).slice(0, 2);
		while (lines.length < 2) lines.push("");
		return lines.map((line) => (line ? theme.fg(kind === "ok" ? "success" : "error", line) : ""));
	}

	#use(account: Account): void {
		const status = this.#status.get(account.id);
		if (status && status !== "loading" && !status.loggedIn) {
			this.#track(this.#signInAgain(account));
			return;
		}
		if (account.id === this.#o.service.active().id) {
			this.#message = { kind: "ok", text: `Already using ${account.name}.` };
			return;
		}
		this.#show(this.#o.service.switchTo(account.name), `Switched to ${account.name} (next turn).`);
	}

	#openInput(mode: "name" | "rename", value: string): void {
		const input = new Input();
		input.setValue(value);
		// setValue leaves the cursor at the start; editing a name starts at its end.
		input.handleInput("\x05");
		input.onSubmit = (text) => this.#submit(text.trim());
		input.onEscape = () => {
			this.#mode = "list";
			this.#input = undefined;
			this.#o.requestRender();
		};
		this.#input = input;
		this.#mode = mode;
		this.#message = undefined;
	}

	#submit(text: string): void {
		if (this.#mode === "name") {
			this.#mode = "list";
			this.#input = undefined;
			this.#track(this.#add(text));
			return;
		}
		const result = this.#o.service.rename(this.#target!.name, text);
		if (!result.ok) {
			this.#message = { kind: "error", text: result.reason };
		} else {
			this.#mode = "list";
			this.#input = undefined;
			this.#reload();
			this.#message = { kind: "ok", text: `Renamed to ${text}.` };
		}
		this.#o.requestRender();
	}

	async #add(name: string): Promise<void> {
		const result = await this.#o.service.add(name, (run) => this.#waitOn(run));
		this.#endWait();
		this.#reload();
		if (result.ok) {
			this.#loadStatuses([result.value.account]);
			this.#selected = Math.max(0, this.#accounts.findIndex((a) => a.id === result.value.account.id));
		}
		this.#message = this.#signinMessage(name, result);
	}

	async #signInAgain(account: Account): Promise<void> {
		const result = await this.#o.service.signInAgain(account.name, (run) => this.#waitOn(run));
		this.#endWait();
		if (result.ok) this.#status.set(account.id, result.value.status);
		this.#message = this.#signinMessage(account.name, result);
	}

	#signinMessage(name: string, result: Result<SigninOutcome>): { kind: "ok" | "error"; text: string } {
		if (!result.ok) return result.reason === "cancelled" ? { kind: "ok", text: "Sign-in cancelled." } : { kind: "error", text: result.reason };
		const as = result.value.status.email ? ` as ${result.value.status.email}` : "";
		const note = result.value.rewritten ? "" : " The browser opened without the sign-out step.";
		return { kind: "ok", text: `Signed in ${name}${as}.${note}` };
	}

	async #remove(target: Account): Promise<void> {
		const result = await this.#o.service.remove(target.name);
		this.#reload();
		this.#message = result.ok
			? { kind: "ok", text: `Removed ${target.name}.${result.value.switchedTo ? ` This session now uses ${result.value.switchedTo.name}.` : ""}` }
			: { kind: "error", text: result.reason };
	}

	#waitOn(run: SigninRun): void {
		this.#signin = run;
		this.#mode = "signingIn";
		this.#message = undefined;
		this.#o.requestRender();
	}

	#endWait(): void {
		this.#signin = undefined;
		this.#mode = "list";
	}

	#show(result: Result<unknown>, text: string): void {
		this.#message = result.ok ? { kind: "ok", text } : { kind: "error", text: result.reason };
		this.#reload();
	}

	#reload(): void {
		const { registry, problem } = this.#o.service.load();
		this.#accounts = registry.accounts;
		this.#defaultId = registry.default;
		if (problem) this.#message = { kind: "error", text: problem };
		this.#selected = Math.min(this.#selected, this.#accounts.length);
	}

	#loadStatuses(accounts: Account[]): void {
		for (const account of accounts) this.#status.set(account.id, "loading");
		this.#track(Promise.all(accounts.map(async (account) => {
			this.#status.set(account.id, await this.#o.readStatus(account));
			this.#o.requestRender();
		})).then(() => {}));
	}

	#track(work: Promise<void>): void {
		const settled = work.catch(() => {
			this.#message = { kind: "error", text: "Something went wrong; nothing was changed." };
		}).finally(() => this.#o.requestRender());
		this.#pending = Promise.all([this.#pending, settled]).then(() => {});
	}
}
