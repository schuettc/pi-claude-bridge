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
| `/claude-account <name>` or `use <name>` | Switch this session |
| `/claude-account add <name>` | Sign in a new account |
| `/claude-account default <name>` | Set the default |
| `/claude-account list` | Print the accounts |
| `/claude-account remove <name>` | Remove, after confirmation |

Without the interactive TUI, a bare `/claude-account` prints the list.

### Signing in
Only normal clicks, in your normal browser. No copying or pasting at any point.

1. Adding an account asks for a name inside the box.
2. The bridge creates `~/.pi/agent/claude-bridge/accounts/<id>/`, where `<id>` is a new random id (see State).
3. It runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set to that directory. This is the command-line form of Claude Code's `/login`. Its stdio is piped, with no terminal attached, which the spike showed works.
4. **The browser goes through claude.ai's logout first.** `claude auth login` opens its sign-in page by running `open <url>`. The bridge puts a bridge-owned directory first on the command's `PATH`, holding an `open` stand-in:
   - For the sign-in URL (`https://claude.com/cai/oauth/authorize?<query>` or `https://claude.ai/oauth/authorize?<query>`), it opens `https://claude.ai/logout?returnTo=<url-encoded /oauth/authorize?<query>>` with `/usr/bin/open`.
   - Any other arguments pass straight through to `/usr/bin/open`.

   Result: the browser is signed out of claude.ai and lands on Claude's login page, which still carries this run's sign-in request. You enter the account's email, click the link in the email, and click Authorize.

   Why: Anthropic's own "Switch account" button loses the sign-in request (see Spike results), and the browser is usually signed in to a different account than the one being added. Going through logout with the request attached avoids that button in every case, including when the browser is already on the right account.
5. While it waits, the panel shows `waiting for browser sign-in… · esc cancel`. Esc kills the command and cleans up (see Errors).
6. When the command exits 0, the bridge runs `claude auth status --json` against the directory. It then shows the email and plan and adds the row.

**Side effect:** adding or re-signing an account signs the browser out of claude.ai. Court accepted this. The browser holds only one claude.ai account at a time anyway.

**Stopping a run** (Esc, the panel closing, pi exiting) kills the `claude` process and its process group. The spike showed that killing only a parent left `claude auth login` running and still listening on its port.

Signing an account in again (a `signed out` row) runs the same flow against that account's directory.

**Not used:** the URL the command prints. It is the paste-a-code variant (`redirect_uri` = `platform.claude.com/oauth/code/callback`), and so is the command's `Paste code here if prompted` stdin. stdin stays open and unused.

**Platform:** the `open` stand-in is verified on macOS only. Linux (`xdg-open`) is out of scope until checked.

**Row details:** the panel reads each account's email and plan by running `claude auth status --json` for every account in parallel when it opens, showing `…` until each answers. They are not stored.

The bridge never reads, copies or stores a credential. Claude Code writes it where it always does (the Keychain on macOS).

### Your existing login
The login pi was launched with becomes the first account automatically, named `default` (renamable). Nothing changes until you add a second account. This account has no bridge-owned directory, so it can be renamed but not removed. Removing it would log you out of plain `claude`.

## Design

### State
- **Registry:** `<pi agent dir>/claude-bridge/accounts.json` (normally `~/.pi/agent/claude-bridge/accounts.json`), written atomically with mode 0600, and never holding credentials:
  ```json
  { "version": 1, "default": "k3v9qd",
    "accounts": [ { "id": "launch", "name": "default", "configDir": null },
                  { "id": "k3v9qd", "name": "work", "configDir": "/Users/you/.pi/agent/claude-bridge/accounts/k3v9qd" } ] }
  ```
  - `configDir: null` means "the login pi was launched with". A missing file means only that account exists.
  - `configDir` is an absolute path.
- **Ids, not names, for anything durable:** each account has a random id (`launch` for the launch login), used for its config directory, for `default`, and in session entries.
  - **A config directory never moves.** macOS keys a Claude Code login's Keychain entry by the config directory's path, so moving or renaming the directory would sign the account out.
  - **Renaming changes only `name`.** Sessions and the default keep pointing at the same account.
- **Names:** `^[a-z0-9][a-z0-9-]{0,31}$`, unique; they are labels only. `add`, `list`, `remove` and `use` are reserved, because they are subcommands. `/claude-account default` with no further argument switches to the account named `default`; `/claude-account use <name>` always switches.
- **Active account:** one per pi process, held in a new module `src/accounts.ts` on a versioned `globalThis` symbol. A subagent that loads a separate copy of the bridge module therefore sees its parent's account. One pi process has one top-level session open at a time, which matches the bridge's existing process-wide model (one `sharedSession`).
- **Per session:** switching appends a `claude-bridge-account` custom entry, `{ id, name }`, with `pi.appendEntry`. The id is what is resolved; the name is only for the notice when the account is gone. On a top-level `session_start` (`new`, `resume`, `fork`, `reload`, and the first `startup`) the bridge applies the session's latest entry, or the default if there is none. A later `startup` is an in-process subagent session and leaves the active account alone, the same rule the bridge already uses for `AGENT_SESSION_ID`.
- **Which directory a Claude Code session lives in:** the bridge's session state records the config directory its session file was written under. When a turn starts under a different account, the directories differ, and that turn rebuilds the session from pi's history in the new directory. No separate "mark for rebuild" signal is needed, and it works in every module copy. A turn captures the account once at its start and uses it throughout, so a switch mid-turn applies from the next turn.

### One resolver
`src/accounts.ts` exports `accountEnv(base)` and `accountClaudeDir()`. Every account-scoped place in `src/index.ts` goes through them:
- **Child environment:** every Claude Code child (provider turns, AskClaude, compaction summary, side requests, the usage refresh) gets `accountEnv(stampedChildEnv(process.env, …), account)`. `stampedChildEnv` itself stays account-agnostic.
  - **Launch-login account:** the environment is exactly as today.
  - **Named account:** sets `CLAUDE_CONFIG_DIR` and removes inherited `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. PR #60 verified that an environment token outranks a config directory's stored login, so leaving one in place would put every account on one login.
- **Session files:** `openSession`, `createSession` and `deleteSession` (today `process.env.CLAUDE_CONFIG_DIR` at `src/index.ts` 283, 781, 785, 824, 2131, 2186) take `accountClaudeDir()`. The debug and diagnostic lines (655, 660, 684) report the resolved directory and account name.
- **`process.env` is never changed.** Tools such as pi's bash still see the launch login.
- **No unset-vs-`~/.claude` conversion.** The launch-login account passes the launch environment through untouched. PR #60 found that an unset `CLAUDE_CONFIG_DIR` and an explicit `~/.claude` are different Keychain entries on macOS.

### Switching
1. Set the active account and append the session entry.
2. The next turn sees that the shared session's recorded directory differs from the active account's and rebuilds a fresh Claude Code session (new id) from pi's history in the new directory, through the existing rebuild path. The old account's file is left alone; another pane may own it.
3. The usage refresh applies the active account to its environment at each refresh, instead of relying only on the environment captured once at session start (`src/index.ts:1131`). The meter then reports the new account with no re-binding.
4. Update the footer status.

A switch requested during a turn applies from the next turn. The turn in progress finishes on its account.

### Errors
| Situation | Behavior |
|---|---|
| The active account's login expired or was revoked | The turn fails with `Claude account "<name>" is signed out. /claude-account to sign in again.` The row shows `signed out`. Never fall back to another account silently. |
| A session names an account that no longer exists | Apply the default and notify: `Account "<old>" no longer exists; using <default>.` |
| Sign-in cancelled or failed | No row is added, the new directory is deleted, and the panel shows `✗ Sign-in didn't finish: <reason>`. |
| The `open` stand-in never sees a sign-in URL (a future Claude Code opens the browser another way, or changes the URL) | The URL passes through unchanged, so sign-in still works when the browser is already on the right account. The panel notes `browser opened without the sign-out step` so a wrong-account page is explainable. The integration check below catches this on upgrades. |
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

### Why switching accounts failed, and the fix
Found by recording every page and redirect in a separate, clean Chrome profile (a diagnostic tool only; the feature uses the normal browser).

**Normal flow, browser signed out (works):**
1. Claude Code opens `claude.com/cai/oauth/authorize?…redirect_uri=http://localhost:<port>/callback…&state=<s>`, which redirects (307) to `claude.ai/oauth/authorize?<same query>`.
2. Not signed in, so it goes to `claude.ai/login?selectAccount=true&returnTo=/oauth/authorize?<same query>`. The request travels in `returnTo`.
3. The emailed link is `claude.ai/magic-link#<token>:<email in base64>`. It carries no request. Opened in the same browser, it signs you in and the original tab continues. Opened in a different browser, it shows a code to type "where you first tried to sign in".
4. Authorize → `localhost:<port>/callback?code=…&state=<s>` → `Login successful.`

**Root cause: Anthropic's "Switch account" button drops the request.** It navigates to `claude.ai/logout?returnTo=/login?from=logout&selectAccount=true&returnTo=<request>`, but the logout page then goes to plain `claude.ai/login?from=logout`, dropping `selectAccount` and the nested `returnTo`. After signing in, nothing leads back to the waiting run. In the clean profile it landed on `claude.ai/new`. In Court's normal Chrome it landed on `localhost:64817/callback` with `state=5xMRO1…`, a request from earlier in the day whose run had exited (`ERR_CONNECTION_REFUSED`). That happened three times, the same state and port each time. Where that old request is kept was not established (not in claude.ai's localStorage, sessionStorage or readable cookies); the fix removes the dependence on it.

**Checked and ruled out:** going straight to `claude.ai/login?selectAccount=true&returnTo=<request>` while signed in bounces directly to Authorize for the current account, with no chance to choose.

**Fix, verified:** `claude.ai/logout?returnTo=/oauth/authorize?<query>` (a single level) is honored. Logout → `oauth/authorize` → signed out → `login?selectAccount=true&returnTo=<request>`, intact. Verified twice:
- In the clean profile, with the browser on `workshop.institute` while adding `subaud.io`.
- In Court's normal Chrome through the `open` stand-in, clicking the emailed link from the mail app. Run on port 54704: `Login successful.` in 33 s, directory reports `subaud.io` · Max · `claude.ai`, launch login untouched.

**Also observed:** a run left waiting keeps its port. Killing only the parent of `claude auth login` left it running and listening.

## Verification
**Unit tests**
- **`open` stand-in:** both sign-in URL shapes become `claude.ai/logout?returnTo=<encoded /oauth/authorize?query>`, with the query preserved byte for byte (state, code_challenge, redirect_uri port). Anything else passes through unchanged.
- **Resolver:** the launch-login account passes the environment through unchanged. A named account sets `CLAUDE_CONFIG_DIR` and removes the three token variables. Every session-file call site receives the resolved directory.
- **Registry:** round trip, corrupt-file fallback, name validation, and the rule protecting the launch-login account.
- **Per-session state:** a switch appends the entry. `session_start` restores it, or falls back with a notice. A switch forces a rotated rebuild in the new directory and re-binds the usage adapter.
- **Panel**, following the `pi-typesafe-ai` panel tests: every line exactly the box width at several widths, a constant body height, navigation, and the add/switch/default/rename/remove flows with an injected sign-in runner and status reader. Subcommands work, and a bare command without a UI prints the list.

**Integration tests**, in the `tests/int-*.mjs` harness against a real Claude Code:
- **Recall across a switch:** plant a codeword on the launch account, switch to a second account, and confirm recall after a rebuild. It needs a second signed-in config directory (`CLAUDE_BRIDGE_TESTING_SECOND_ACCOUNT_DIR`) and skips without one. Pointing a named account at `~/.claude` would not work: an explicit `~/.claude` is a different macOS Keychain entry from the unset default, so it reads as signed out.
- **File placement:** session files land in the active account's directory.
- **Browser launch contract:** `claude auth login`, run with the stand-in on `PATH`, calls it with a sign-in URL within a few seconds. This is killed before any browser opens. It guards the one assumption about how Claude Code opens the browser.

**Live check** with two real logins: switch personal → work → personal in one session. History should survive, `claude auth status` should confirm each account, and the usage meter should follow.
