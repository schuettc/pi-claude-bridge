import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// The frame of the /claude-account panel, copied from pi-typesafe-ai's panel,
// which copies creel's popup (tackle/internal/creel/tui.go): a rounded border
// 56 columns wide with two columns of padding, a bold title and a dim footer.
// Copied rather than shared so the bridge stays self-contained.

export const BOX_WIDTH = 56;
export const PADDING = 2;

/** The subset of pi's Theme the panel uses. */
export interface PanelTheme {
	fg(color: "accent" | "border" | "dim" | "muted" | "success" | "error" | "warning" | "text", text: string): string;
	bold(text: string): string;
}

export function renderBox(opts: { title: string; body: string[]; footer: string; width: number; theme: PanelTheme }): string[] {
	const { theme } = opts;
	const outer = Math.max(PADDING * 2 + 4, Math.min(BOX_WIDTH, opts.width));
	const inner = outer - 2 - PADDING * 2;
	const border = (text: string) => theme.fg("border", text);
	const row = (content: string) => {
		const fitted = truncateToWidth(content, inner, "…");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
		return `${border("│")}${" ".repeat(PADDING)}${fitted}${pad}${" ".repeat(PADDING)}${border("│")}`;
	};
	const body = [theme.bold(opts.title), "", ...opts.body, "", theme.fg("dim", opts.footer)];
	return [
		border(`╭${"─".repeat(outer - 2)}╮`),
		...body.map(row),
		border(`╰${"─".repeat(outer - 2)}╯`),
	];
}
