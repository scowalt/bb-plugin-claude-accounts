Run your Pi threads on several Claude subscriptions without a proxy.

## What you get

- **An account per thread.** Each Pi + claude-bridge thread is pinned to one
  of your Claude accounts. New threads go to the largest plan with headroom.
- **Moves between turns.** When a thread's account is nearly full, or a turn
  fails on a Claude limit, the thread moves to another account at its next
  turn. A retry is queued for you.
- **Usage for every account** in bb's usage card, and in
  `bb claude-accounts status`.
- **`bb claude-accounts explain`** tells you which account a thread uses and
  why.

## How it works

Each account is a Claude Code config directory signed in through Claude Code's
own `/login`. For each turn the plugin sets `CLAUDE_CONFIG_DIR` on the `pi`
provider. The default `~/.claude` login gets no variable and runs as before.
Tokens stay on their machine and are never refreshed or rewritten by the
plugin.

## Requirements

bb 0.46 or newer, Pi with pi-claude-bridge, and a Claude Code login for each
account on each machine where it should be used.
