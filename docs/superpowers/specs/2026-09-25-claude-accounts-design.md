# Claude accounts (`/claude-account`)

Status: design approved by Court in chat 2026-09-25; this spec awaits review. Package: `@schuettc/pi-claude-bridge` (fork, `schuettc-publish` patch stack). Branch: `feat/claude-accounts`.

## Goal
Use more than one Claude subscription account from pi without signing in again when moving between them. Everything is managed inside pi, and the bridge is the only extension needed.

- Each account signs in once with Claude Code's normal login, into its own Claude config directory. That is Anthropic's documented way to run several accounts side by side (`CLAUDE_CONFIG_DIR`).
- The account is a setting on the pi session, not part of the model. You still pick "Opus 5"; the account is chosen separately.
- Two panes can run different accounts at the same time. A resumed session goes back to the account it last used.

Why build it here: upstream issue #57 and PR #60 (`elidickinson/pi-claude-bridge`) solve a similar problem with one provider per account in `/model`. That PR has sat unreviewed since 2026-08-10, and Court chose a session setting over extra model entries. Its verified findings are reused below and credited where they apply.

## Using it

### The panel
A bare `/claude-account` opens a centered overlay in the creel look that `/typesafe` already copies (`tools-ops/docs/superpowers/specs/2026-09-23-typesafe-settings-panel-design.md`):
- **Frame:** a rounded border 56 columns wide with 2 columns of padding, a bold title `🔑 claude · accounts`, pi theme colors, a dim description of the selected row, one message line (`✓ …` / `✗ …`), and a dim key-hint footer.
- **Fixed height:** the body keeps the same height in every mode, so the overlay never re-centers.

```
╭──────────────────────────────────────────────────────╮
│  🔑 claude · accounts                                │
│                                                      │
│  → work        ●  you@work.com · Max    default      │
│    personal       you@home.com · Pro                 │
│    + Add account                                     │
│                                                      │
│  This session uses work. Enter switches this         │
│  session; d sets default; r renames; x removes.      │
│                                                      │
│  ✓ Switched to personal (next turn).                 │
│                                                      │
│  ↑↓ select · enter use · d default · esc close       │
╰──────────────────────────────────────────────────────╯
```

**Rows**
- **One row per account:** the name, `●` if this session uses it, the email and plan from `claude auth status`, and `default` on the account new sessions start on. An account whose login is gone shows `signed out`.
- **`+ Add account`:** the last row.

**Keys**
| Key | Action |
|---|---|
| ↑↓ / j k | Move |
| Enter / Space on an account | Switch this session to it; takes effect on the next turn. On a `signed out` account, sign in again instead. |
| Enter on `+ Add account` | A name field opens inside the box, then sign-in starts (below). |
| `d` | Make the selected account the default for new sessions. |
| `r` | Rename, using a field inside the box. |
| `x` | Remove, after a `y/N` prompt inside the box. The prompt says so if this session is using that account. |
| Esc | Close. The panel stays open between actions. |

**Footer status:** pi's footer shows `claude: <name>` while a bridge model is active.

**Subcommands** (they autocomplete with descriptions; for headless sessions and scripts):

| Command | Does |
|---|---|
| `/claude-account <name>` | Switch this session |
| `/claude-account add <name>` | Sign in a new account |
| `/claude-account default <name>` | Set the default |
| `/claude-account list` | Print the accounts |
| `/claude-account remove <name>` | Remove, after confirmation |

Without the interactive TUI, a bare `/claude-account` prints the list.

### Signing in
No copying or pasting at any point.

1. Adding an account asks for a name inside the box.
2. The bridge creates `~/.pi/agent/claude-bridge/accounts/<name>/`.
3. It runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set to that directory. This is the command-line form of Claude Code's `/login`. Its stdio is piped, with no terminal attached, which the spike showed works. The browser opens Anthropic's sign-in page, and you choose the account and sign in there.
4. While it waits, the panel shows `waiting for browser sign-in… · esc cancel`. Esc kills the command and cleans up (see Errors); to try again, start the add again.
5. When the command exits 0, the bridge runs `claude auth status --json` against the directory. It then shows the email and plan and adds the row.

Signing an account in again (a `signed out` row) runs the same flow against that account's directory.

The URL the command prints is not used. It is the paste-a-code variant (`redirect_uri` = `platform.claude.com/oauth/code/callback`). Each run's automatically opened tab is the one that completes it: every run listens on its own random localhost port, so a tab left over from an earlier run cannot finish a new one.

**Row details:** the panel reads each account's email and plan by running `claude auth status --json` for every account in parallel when it opens, showing `…` until each answers. They are not stored.

The command also reads a pasted code from stdin (`Paste code here if prompted`). The bridge never uses that path; stdin stays open and unused.

The bridge never reads, copies or stores a credential. Claude Code writes it where it always does (the Keychain on macOS).

### Your existing login
The login pi was launched with becomes the first account automatically, named `default` (renamable). Nothing changes until you add a second account. This account has no bridge-owned directory, so it can be renamed but not removed. Removing it would log you out of plain `claude`.

## Design

### State
- **Registry:** `~/.pi/agent/claude-bridge/accounts.json`, written atomically with mode 0600, and never holding credentials:
  ```json
  { "version": 1, "default": "work",
    "accounts": [ { "name": "default", "configDir": null },
                  { "name": "work", "configDir": "~/.pi/agent/claude-bridge/accounts/work" } ] }
  ```
  `configDir: null` means "the login pi was launched with". A missing file means only that account exists.
- **Names:** `^[a-z0-9][a-z0-9-]{0,31}$`, unique.
- **Active account:** one per pi process, held in a new module `src/accounts.ts` on a versioned `globalThis` symbol. A subagent that loads a separate copy of the bridge module therefore sees its parent's account. One pi process has one top-level session open at a time, which matches the bridge's existing process-wide model (one `sharedSession`).
- **Per session:** switching appends a `claude-bridge-account` custom entry, `{ name }`, with `pi.appendEntry`. On `session_start` (new, resume, fork, reload) the bridge applies the session's latest entry, or the default if there is none.

### One resolver
`src/accounts.ts` exports `accountEnv(base)` and `accountClaudeDir()`. Every account-scoped place in `src/index.ts` goes through them:
- **Child environment:** `stampedChildEnv` (every Claude Code child: provider turns, AskClaude, compaction summary, side requests, the usage refresh) takes the child's environment from `accountEnv`.
  - **Launch-login account:** the environment is exactly as today.
  - **Named account:** sets `CLAUDE_CONFIG_DIR` and removes inherited `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. PR #60 verified that an environment token outranks a config directory's stored login, so leaving one in place would put every account on one login.
- **Session files:** `openSession`, `createSession` and `deleteSession` (today `process.env.CLAUDE_CONFIG_DIR` at `src/index.ts` 283, 781, 785, 824, 2131, 2186) take `accountClaudeDir()`. The debug and diagnostic lines (655, 660, 684) report the resolved directory and account name.
- **`process.env` is never changed.** Tools such as pi's bash still see the launch login.
- **No unset-vs-`~/.claude` conversion.** The launch-login account passes the launch environment through untouched. PR #60 found that an unset `CLAUDE_CONFIG_DIR` and an explicit `~/.claude` are different Keychain entries on macOS.

### Switching
1. Set the active account and append the session entry.
2. Mark the shared session for a rotated rebuild (`needsRebuild` + `forceRotate`). The next turn then writes a fresh Claude Code session from pi's history into the new account's directory, through the existing rebuild path. The old account's file is left alone; another pane may own it.
3. Re-bind the usage adapter (`bindClaudeUsageAdapterOwner`), whose environment is otherwise captured once at session start (`src/index.ts:1131`). The meter then reports the new account.
4. Update the footer status.

A switch requested during a turn applies from the next turn. The turn in progress finishes on its account.

### Errors
| Situation | Behavior |
|---|---|
| The active account's login expired or was revoked | The turn fails with `Claude account "<name>" is signed out. /claude-account to sign in again.` The row shows `signed out`. Never fall back to another account silently. |
| A session names an account that no longer exists | Apply the default and notify: `Account "<old>" no longer exists; using <default>.` |
| Sign-in cancelled or failed | No row is added, the new directory is deleted, and the panel shows `✗ Sign-in didn't finish: <reason>`. |
| Invalid or duplicate name | Rejected in the box with the reason. |
| Removing the active account | The confirmation names it; the session moves to the default. |
| Removing the launch-login account | Refused, with the reason; renaming is allowed. |
| `accounts.json` missing or unreadable | Behave exactly as today on the launch login. The panel reports the file problem. |

## Non-goals
- Automatic rotation or failover when an account hits a limit.
- A different account for a subagent than its parent.
- Offering this upstream. The fork may separate from upstream entirely; that is a separate decision.
- A shared panel helper across extensions. The ~30-line box renderer is copied from `pi-typesafe-ai` so the bridge stays self-contained; extracting it is recorded as a separate finding.

## Spike results (2026-09-25, Claude Code 2.1.282, Agent SDK 0.3.280)
Run with throwaway scripts against a scratch config directory; nothing from the spike is kept.

1. **Sign-in without a terminal: yes.** `claude auth login --claudeai`, spawned with piped stdio and `CLAUDE_CONFIG_DIR` set, opened the browser. It exited 0 with `Login successful.` once Court signed in (43 s and 120 s). No tmux fallback is needed, and none is built.
2. **Same as `/login`: yes.** `claude auth status --json` on the new directory reports `authMethod: claude.ai`, `apiProvider: firstParty`, `subscriptionType: max`, the same as the existing login.
3. **Separate accounts: yes.** With a second account signed in, the two directories report different emails and orgs. `claude auth logout` on the scratch directory left the launch login signed in.
4. **Usage follows the directory: yes.** The bridge's usage-refresh shape (a no-prompt SDK query with `accountInfo()` and the usage control call) reports the right account and plan for each directory. `rate_limits` is `null` for both, including the launch login, before any turn. That is existing behavior, and the live check covers the per-turn rate-limit snapshots.

**Note from the spike:** the one failure was self-inflicted. The session told Court to move sign-in to a private window, and the URL copied there was an earlier run's. That run had already exited, so the browser's redirect to its localhost port got `ERR_CONNECTION_REFUSED`. Using the tab each run opens avoids it.

**Open point for the live check:** confirm that Anthropic's sign-in page lets you choose a different account when the browser is already signed in to claude.ai. In the spike it asked for an email, but the already-signed-in case was not tested cleanly. If it only offers the current session, the fix is to sign out on that page, not to add anything to the panel.

## Verification
**Unit tests**
- **Resolver:** the launch-login account passes the environment through unchanged. A named account sets `CLAUDE_CONFIG_DIR` and removes the three token variables. Every session-file call site receives the resolved directory.
- **Registry:** round trip, corrupt-file fallback, name validation, and the rule protecting the launch-login account.
- **Per-session state:** a switch appends the entry. `session_start` restores it, or falls back with a notice. A switch forces a rotated rebuild in the new directory and re-binds the usage adapter.
- **Panel**, following the `pi-typesafe-ai` panel tests: every line exactly the box width at several widths, a constant body height, navigation, and the add/switch/default/rename/remove flows with an injected sign-in runner and status reader. Subcommands work, and a bare command without a UI prints the list.

**Integration tests**, in the `tests/int-*.mjs` harness against a real Claude Code:
- **Recall across a switch:** plant a codeword on account A, switch to B, and confirm recall after a rebuild. This runs with one real login by pointing two accounts at the same directory, as PR #60's `int-profile-switch` does.
- **File placement:** session files land in the active account's directory.

**Live check** with two real logins: switch personal → work → personal in one session. History should survive, `claude auth status` should confirm each account, and the usage meter should follow.
