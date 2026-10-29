# Claude Accounts

Spread your Pi threads across several Claude subscriptions.

As of bb 0.46, bb's built-in Account Pooler routes only threads on the
`claude-code` and `codex` providers. This plugin covers threads on the `pi` provider that run
Claude through [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge).
It gives each thread one account and switches between turns. There is no proxy:
the unmodified Claude Code binary talks to Anthropic with a login made through
Claude Code's own `/login`.

## How it works

- **One config directory per account.** `~/.claude` is your default login.
  Every other account gets its own directory, such as `~/.claude-b`, signed in
  with `CLAUDE_CONFIG_DIR=~/.claude-b claude`.
- **Each turn gets its account.** The plugin adds `CLAUDE_CONFIG_DIR` to the
  `pi` provider's environment for the thread. bb resolves that environment on
  every turn, and Pi rebuilds its session when it changes, keeping the
  conversation. The default account gets no variable at all, so threads on it
  run exactly as before. bb resolves the environment before it records the
  turn, so the plugin learns each turn's model from bb's `message.dispatch`
  hook. The hook only listens: it never holds or rejects a message.
- **New threads go to the largest plan with headroom.** That means session use
  under 85 % and weekly use under 90 %, counting the weekly allowance for the
  thread's model family (Fable, for example). Among accounts on the same plan,
  the one whose weekly window resets soonest goes first.
- **Threads stay put until their account is nearly full.** A thread moves at
  its next turn once its account reaches 97 % of its session or weekly limit.
  Staying put keeps the prompt cache: a move re-sends the thread's context to
  the new account uncached.
- **Limit failures move the thread and queue a retry.** When claude-bridge
  reports a Claude limit, the plugin blocks that account for the affected
  window until it resets, or until a usage reading at least 15 minutes later
  covers that window. From then on the reading decides, so a brief rejection
  does not keep an account with room out of use. It then queues a retry
  15–45 seconds later on the
  next account. If every account is out of quota, the retry waits for the
  first reset within six hours. If the thread starts another turn first, for
  example because you continued it yourself, the queued retry is dropped.
- **Machines are separate.** A thread only uses accounts signed in on its own
  machine.
- **Usage everywhere.** Each machine's host entry reads its config directories
  and calls Anthropic's usage endpoint with that directory's token. Tokens
  never leave the machine, and the plugin never refreshes or rewrites them.
  Every account appears as a "Claude Accounts" group in bb's usage card,
  through the `provider-usage.v1` contract.
- **Plans come from Anthropic.** A login's files keep the plan it signed in on,
  so after an upgrade they still name the old plan. The plugin reads each
  account's plan from Anthropic's profile endpoint, as Claude Code does, at
  most once an hour and on every `bb claude-accounts refresh`. Until the first
  reading succeeds, the login files decide.

## Set up

Requires bb 0.46 or newer and Pi with pi-claude-bridge. Tested with bb 0.46.1
and pi-claude-bridge 0.9.3.

1. Sign in each extra account on each machine where its threads should run:

   ```sh
   mkdir -p ~/.claude-b
   CLAUDE_CONFIG_DIR=~/.claude-b claude   # /login with the other account, then /exit
   ```

   Use the exact path, with no trailing slash. On macOS the login goes to the
   Keychain, in an entry tied to that path.
2. Install the plugin and list the accounts:

   ```sh
   bb plugin install https://github.com/scowalt/bb-plugin-claude-accounts.git
   bb plugin config claude-accounts set accounts "A=~/.claude, B=~/.claude-b"
   bb claude-accounts refresh
   ```

   From a local checkout, run `bb plugin install .` instead.

3. Check that `bb claude-accounts` shows each account signed in, with its plan
   and usage, and no warnings.

## Commands

| Command | What it does |
| --- | --- |
| `bb claude-accounts [status] [--json]` | Accounts, plans, machines, usage, pinned thread counts, blocks, and warnings |
| `bb claude-accounts explain [thread] [--json]` | A thread's pin, last decision, queued retry, and next pick |
| `bb claude-accounts pin <thread> <account>` | Pin a thread by hand, from its next turn |
| `bb claude-accounts unpin <thread>` | Let the rules pick again |
| `bb claude-accounts refresh [--json]` | Re-check logins and read usage and plans now |

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `accounts` | `A=~/.claude` | `Name=directory` pairs. The order breaks ties. |
| `mode` | `route` | `observe` records decisions but changes no environment |
| `newThreadSessionPercent` | 85 | A thread starts on or moves to an account only while its session use is below this |
| `newThreadWeeklyPercent` | 90 | The same for weekly use |
| `moveSessionPercent` | 97 | A pinned thread leaves its account at this session use |
| `moveWeeklyPercent` | 97 | The same for weekly use |
| `pollMinutes` | 5 | How often usage is read |
| `smallAccountModels` | *(empty)* | Model patterns that should prefer the smallest account, such as `claude-bridge/claude-haiku-*` |

## Limits

- **Switches happen between turns, not inside one.** When an account runs out
  mid-turn, the turn fails once and is retried on the next account. A message
  that joins a running turn, such as a steer or a delivered tool result, stays
  on the turn's account.
- **Idle accounts show their last reading.** An account no thread has used for
  about 8 hours has an expired access token. It shows its last usage reading
  until a thread uses it again; the plugin never refreshes the token itself.
- **Experimental API.** `bb.providers.experimental_contributeEnv` may change in
  a bb update. After updating bb, check `bb claude-accounts explain` on a
  thread that moved.
- **Your call on the terms.** Anthropic's Claude Code terms say Pro and Max
  usage limits "assume ordinary, individual usage". Whether this setup fits
  your accounts is yours to judge.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build
bb plugin reload claude-accounts
```

[MIT](LICENSE)
