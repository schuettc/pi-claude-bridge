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
1. Adding an account creates `~/.pi/agent/claude-bridge/accounts/<name>/`.
2. The bridge runs `claude auth login` with `CLAUDE_CONFIG_DIR` set to that directory. This is the command-line form of Claude Code's `/login`: the browser opens and you sign in as usual.
3. While it waits, the panel shows `waiting for browser sign-in… (esc cancels)`.
4. When the command finishes, the bridge runs `claude auth status --json` against the directory. It then shows the email and plan and adds the row.
5. **If `claude auth login` needs a real terminal** (spike question 1), the same command runs in a `tmux display-popup` instead, the way creel captures secrets. Outside tmux, the panel says to run pi inside tmux for sign-in.

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

## Spike (before implementation)
1. Does `claude auth login` complete when started by the bridge without a real terminal? If not, confirm the tmux-popup fallback works.
2. Does `claude auth login` produce the same login as interactive `/login`? `claude auth status --json` should report `authMethod: claude.ai` and the right `subscriptionType`.
3. With two directories signed in, does `claude auth status --json` report each account separately?
4. Does the bridge's usage meter report each account correctly under its `CLAUDE_CONFIG_DIR`?

Results are recorded in this spec before the plan is written. A "no" on question 1 changes only the sign-in section; a "no" on 3 or 4 is a blocker to raise with Court.

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
