---
name: claude-accounts
description: Inspect or steer which Claude subscription each Pi thread uses with `bb claude-accounts`. Use when asked which Claude account a thread runs on, why a thread switched accounts, how much quota each account has left, or to pin a thread to an account.
---

# Claude Accounts

Claude Accounts spreads Pi threads that run Claude through claude-bridge across
several Claude subscriptions. Each account is a Claude Code config directory,
such as `~/.claude` or `~/.claude-b`, signed in with
`CLAUDE_CONFIG_DIR=<directory> claude` and `/login`. On every turn the plugin
sets `CLAUDE_CONFIG_DIR` for the thread's account. The machine's default
`~/.claude` gets no variable.

## Commands

- `bb claude-accounts [status] [--json]` — every account with its plan, the
  machines it is signed in on, its usage windows, how many threads are pinned
  to it, any block from a recent limit failure, and warnings (logins about to
  expire, accounts that share an organization and therefore a quota).
- `bb claude-accounts explain [thread-id] [--json]` — the thread's pin, the
  last decision with its reason and any queued retry, and what the thread's
  next turn would pick. Without an id it uses the current thread.
- `bb claude-accounts pin <thread-id> <account>` — pin a thread by hand. It
  takes effect on the thread's next turn and holds even when the account is
  over its limits.
- `bb claude-accounts unpin <thread-id>` — let the rules pick again.
- `bb claude-accounts refresh [--json]` — re-check every machine's logins and
  read every account's usage now, then print the status.

## Rules

- A new thread starts on the largest plan whose session use is under 85 % and
  whose weekly use is under 90 %, including the weekly allowance for the
  thread's model family (for example Fable). Among equal plans, the account
  whose weekly window resets soonest goes first.
- A pinned thread stays until its account reaches 97 % of its session or
  weekly limit, or until a turn fails on a Claude limit. Then it moves at its
  next turn. The move re-sends the thread's context to the new account
  uncached, because prompt caches do not carry across accounts.
- A Claude limit failure blocks that account for the affected window until it
  resets. A retry is queued 15–45 seconds later on the next account. If no
  account has headroom, the retry waits for the first reset within six hours.
  A turn gets at most four attempts. Provider Retry handles failures that bb
  itself classified as rate limits. A queued retry is dropped when the thread
  starts another turn first, such as when the user continues it by hand.
- Only accounts signed in on the thread's machine are used.
- Threads on other models or other providers are left alone.

## Settings

Change them with `bb plugin config claude-accounts set <key> <value>`:
`accounts` (`Name=directory` pairs, comma-separated), `mode` (`route` or
`observe`), `newThreadSessionPercent`, `newThreadWeeklyPercent`,
`moveSessionPercent`, `moveWeeklyPercent`, `pollMinutes`, and
`smallAccountModels` (patterns of models that should prefer the smallest
account).

## Constraints

- Do not pin a long thread to a small account. The switch re-sends its whole
  context, which can use up a Pro session window at once.
- Never sign accounts in or out, and never read or edit credential files.
  Signing in is the user's step.
