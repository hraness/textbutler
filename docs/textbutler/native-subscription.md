# Native subscription agent route

Textbutler can be pointed at the Codex and Claude Code applications an owner
already runs on their Mac, so replies are drafted through an existing
subscription instead of a separately billed API key. This page describes the
boundary that route runs inside, what the current source implements, and the
evidence still required before the route can be enabled.

**The route is not enabled.** The source ships the boundary, the two provider
protocols and the admission checks. It ships no process launcher and no
qualification evidence, so every native account reports unavailable.

## Why the boundary exists

A coding agent is built to read files, run commands and reach the network. A
message butler must do none of those things on a contact's behalf. The route
therefore treats the native application as an inference component with no tools
of its own:

- The agent receives the task, the list of operations Textbutler is willing to
  perform for this contact, and previous operation results.
- It answers with exactly one JSON object per step: either a final result, or a
  proposal naming one advertised operation and its input.
- Textbutler's existing contact-scoped broker decides whether that proposal is
  valid, performs it and returns the result. The agent never performs it.

Each step is one bounded run of the provider: Textbutler supplies the prompt,
the provider returns one JSON object, and the step ends. Nothing carries over
except the operation history Textbutler chooses to include in the next prompt.

A proposal is never delivery. Disclosure, human takeover and send journalling
stay in trusted code, unchanged by which agent produced the text.

Each run is bounded before it starts: at most 16 steps, 12 brokered operations,
512 KiB of prompt, 256 KiB per step and 1 MiB of transcript. Exceeding any bound
stops the run. An operation error is never retried, because its effect may
already have committed.

## Custody

The task runtime acquires one account lease per run and releases it only against
a stop receipt from the component that owns the process. Textbutler's adapter
registers its supervisor handle before a process can start, so a launch that
throws leaves custody unresolved rather than silently free.

When a run fails inside the boundary — a malformed step, a denied operation, a
budget overrun — the adapter joins the native process first and then reports a
stopped failure. The account is released and the reply simply does not complete.
When the stop receipt is missing or invalid, the account stays held and reports
that it needs recovery. Neither an expired deadline, a cancelled signal nor a
root process exit is accepted as proof that a process stopped.

## Codex

Codex is driven over its app-server protocol on stdio. Textbutler starts the
thread itself and admits nothing it did not ask for:

- The model catalog is extracted from the exact admitted executable's bytes and
  rewritten to disable shell, patch, search and multi-agent tool modes. An
  owner's mutable catalog cache is not a source.
- Configuration is read back and compared field by field: ChatGPT login,
  read-only sandbox, `never` approvals, no web search, no MCP servers, no
  plugins, no skills, no analytics, no history and an empty environment policy.
  Every account feature must read back `false`.
- Remote control must be observed disabled before the thread starts.
- The thread runs ephemerally, with instruction sources empty and the reply
  bound to a supplied output schema.
- Only assistant, reasoning and user message items are accepted. Any command
  execution, patch, approval request or unknown notification fails the run.

## Claude Code

Claude Code is driven as a single non-interactive prompt with a streamed JSON
transcript. The launch plan is pure data — it reads no environment and starts no
process — and pins the exact verified build, an empty tool set, no MCP servers,
no slash commands, no session persistence and an environment containing only the
native authentication roots the trusted host supplies.

The route deliberately keeps native sign-in in charge of authentication. Modes
that disable subscription login are not used, and no API key is collected,
injected or fallen back to.

The transcript is validated only after the process has exited: the initialization
frame must report the pinned version, `dontAsk` permissions, no API key source
and empty tool, skill, plugin and MCP inventories; the assistant turn must
contain text only; and the result frame must reconcile with that text exactly.
Duplicate JSON keys, replayed frames and mixed sessions are rejected before the
value is parsed.

## What qualification still requires

Neither a matching build hash, a passing test suite nor a signed-in account
qualifies this route. Enabling it requires, for each provider:

- A trusted supervisor that launches the verified executable under operating
  system confinement, enforces the run deadline outside the JavaScript event
  loop, and returns a physical stop receipt it can prove.
- Evidence for the exact installed runtime, recorded against that build and
  expiring on its own schedule.
- Separate classification and reply profile evidence. One qualified purpose does
  not qualify the other.
- Live verification on the owner's real account with one agreed recipient,
  covering delivery, takeover, pause, cancellation before dispatch, transport
  loss, restart and grant expiry.

Until all of that exists for a provider, its account stays unavailable, and the
reason is shown in the terminal and the menu rather than hidden behind a retry.
See [readiness](readiness.md) for the remaining acceptance work across the
product, and [PROVIDERS.md](../../packages/textbutler/PROVIDERS.md) for the
separately billed Claude API route.
