# Textbutler runtime

This source package contains the macOS message-butler daemon. The owner
selects contacts and an explicit agent account. Trusted runtime code admits
replies, isolates contact memory, adds disclosure, and journals outward intent.

The automation connection polls Ghostget's durable incoming-message feed and
uses recipient-bound grants for enabled contacts. New installations start paused.
Only configured, ready messaging connections and admitted agent accounts can
run replies. Subscription inference requires a verified Textbutler bundle with
reviewed source composition admission; source daemon startup remains unadmitted.
Claude Code and Codex subscription inference uses an explicitly
configured [xcb](https://github.com/hraness/xcb) native `generate` process.
xcb keeps credentials and provider custody; Textbutler interprets structured
proposals through its contact broker. This MIT-licensed package is a reference
application for that API. Claude API is a separate billed choice; source-mode
startup and the local installer do not supply its trusted runtime attestation.
See [provider setup](PROVIDERS.md) before enabling a contact. Source and synthetic
tests do not attest live delivery on a particular account. CLI and menu-bar use
do not require a signed Mac release; windowed desktop app packaging has been removed.

## First use

Start with the [guided setup](../../docs/textbutler/getting-started.md) and
[messaging app support](../../docs/textbutler/messaging-apps.md). Run
`bun run textbutler tui` for setup, connections, contact selection and inbox review.
The menu companion uses the shared Rust runner; no local Rust build is needed.

## Modules

- `config.ts`: strict contact settings, smart-mode defaults, activation limits,
  and the `🤖{ … }` disclosure formatter.
- `decision.ts`: keyword matching, debounce, owner cooldown, stale-state
  rejection, rate limits, and classifier admission.
- `workspace.ts`: private bounded contact files, exact edits, conditional
  atomic writes, and attributed context-only history bootstrap.
- `hooks.ts` and `plugins.ts`: versioned owner-installed lifecycle hooks with
  veto and timeout, loaded from an explicit private owner manifest.
- `journal.ts`: persisted run claims and send states. An uncertain dispatch is
  quarantined, never retried automatically.
- `runtime.ts`: compose, validate, recheck, prepare, journal, and submit through
  qualified injected ports. No model-facing tool dispatches during composition.
- `routed-agent.ts`: the compatibility routing consumer, with separate tool-free
  classification and contact-bound composition. Provider qualification still
  applies at the router's execution boundary.
- `contact-capabilities.ts`: separate managed classifier and reply profiles that
  reuse the contact file, public web and message-proposal handlers. Closing a
  profile revokes and joins its admitted handlers. Memory writes recheck contact
  activity immediately before atomic publication.
- `enrollment.ts` and `ghostget-owner-read.ts`: explicit owner conversation
  selection, account/participant binding, and bounded context-only history.
- `host-config.ts`: private owner configuration of the installed Ghostget CLI;
  no account or message reads occur just by loading configuration.
- `xcb-host.ts`: pinned external xcb execution, account/model binding, bounded
  zero-tool generation and settlement validation. Provider credentials stay in
  xcb's private state; Textbutler handles the contact's operation proposals.
- `provider-host.ts`: explicit account selection, current model availability,
  credential generation fencing, shared account leases, and optional trusted
  [managed Codex account controls](https://github.com/hraness/xcb/blob/main/MANAGED-CODEX.md). Its managed
  task entry joins the exact account controller before the runtime acquires one
  task lease; owner operations remain busy through task cleanup. Pending sign-in
  cannot be canceled by a reply, and uncertain cleanup retains recovery state.
- `automation-owner.ts`: owner-only network setup, exact enrollment identity,
  scoped grants and current provider capabilities.
- `reply-loop.ts`: incoming-event polling, debounce, takeover cancellation and
  qualified runtime dispatch. History imported during setup is context only.
- `control-service.ts`, `daemon.ts`, and `cli.ts`: owner-only versioned Mac
  control and foreground daemon service, including bounded asynchronous read jobs.
- `launch-agent.ts`: explicit per-user background-service install, status and
  uninstall, with exact artifact and loaded-service identity checks.

The external xcb connection supplies the subscription execution path. The
builder checks a reviewed composition receipt against its source inventory and
both contact profiles before embedding application admission. Missing or stale
evidence rejects the build; xcb sign-in and source hashes cannot manufacture it. Its setup
pins an executable and account/model binding; it does not manufacture provider
qualification or activate contacts. Both classifier and reply behavior must
pass the connection's checks before smart-mode activation. The older managed
task seam remains separately gated. Native subscription routing never
substitutes a separately billed API account.

## Run from source

From the repository root, install the pinned dependencies and inspect status:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run textbutler doctor
```

Use `bun run textbutler --help` for the current command syntax. For foreground
development, run `bun run textbutler daemon run`; closing that terminal stops
the process. The source daemon supports the manual pilot but cannot perform
subscription inference. For AI replies, install the verified bundle with
`bun run textbutler:install` and use `~/.local/bin/textbutler daemon run` or
`~/.local/bin/textbutler daemon install`. The menu companion is the shared desktop-foundation runner,
fetched and verified as a pinned release binary on first start:

```sh
bun run textbutler menubar
bun run textbutler menubar status
bun run textbutler menubar stop
```

The command never compiles source and enforces one running companion per
user. Register login startup only when it is wanted:

```sh
bun run textbutler menubar install
bun run textbutler menubar uninstall
```

For an explicitly installed background service:

```sh
bun run textbutler daemon install
bun run textbutler daemon status
bun run textbutler daemon uninstall
```

Installation registers `app.textbutler.daemon` in the current Mac user's
graphical login session. It records the exact Bun executable, source entrypoint
and data directory. Keep that source checkout in place while installed; uninstall
before moving it or changing its launch identity. Uninstall retains contact
memory, settings and activity. New settings start paused; existing settings
are preserved. `daemon status` reports installation and control-socket health
separately. An unknown or changed service is never removed by name alone.

## Select a conversation

Initialize the data directory with `bun run textbutler init`. Configure an
existing Ghostget installation and its explicitly selected iMessage account in
the mode-`0600` file `state/host.json` under the Textbutler data directory:

```json
{
  "schemaVersion": 1,
  "ghostget": {
    "executable": "/opt/ghostget/src/cli.ts",
    "runtimeExecutable": "/opt/bin/bun",
    "authId": "your-imessage-account-id"
  }
}
```

Replace the example paths with the actual physical installed paths. Omit
`runtimeExecutable` when `executable` is the standalone Ghostget executable.
An optional absolute `stateHome` selects Ghostget's configured state directory.
No shell command, arbitrary arguments or environment fields are accepted.
This configuration does not create an account or grant Messages permissions;
complete that setup in Ghostget. Restart Textbutler after editing host settings.

The owner control protocol supports listing up to 200 recent Messages
conversations and enrolling one direct contact, optionally importing at most 200
recent text messages. Enrollment rechecks account incarnation and participant
identity and creates a disabled contact. Attachments are not imported. Use the terminal or menu to select a conversation, or run
`conversations list` followed by `contacts add CANDIDATE [--history]`. The native Contacts directory remains unavailable
through the current Ghostget contract.

Long reads use bounded owner jobs; the global Pause button remains available.
Bun source launches disable automatic `.env` loading. A cancelled Ghostget CLI
receives 36 seconds for its documented cleanup and persistence envelope before
forced termination. Each invocation first claims the private
`state/ghostget-read-custody.json` marker. Uncertain, signalled, failed or malformed
outcomes preserve it; restarting the daemon does not clear the fence. Recovery
requires owner inspection of the exact configuration digest and operation record,
plus reconciliation of Ghostget's corresponding cleanup state. Do not delete the
marker or run broad provider recovery merely to unblock a retry. The daemon
does not automatically invoke Ghostget recovery or infer descendant cleanup from
the immediate parent process exiting.
The configuration above selects the legacy read-only conversation path. For
automation, add `ghostget.automationAccounts`, an explicit list of at most one account each for `imessage`, `whatsapp` and
`beeper`, with `{ "provider": "beeper", "authId": "beeper-main" }` as an example. Automation
account IDs use lowercase letters, digits and hyphens, start with a letter, and
have at most 48 characters. Keep the legacy `authId` for compatibility.

Provider configuration alone does not start WhatsApp synchronization. The owner
control protocol has separate connection, enrollment and activation operations.
Use `messaging start PROVIDER`, the guided terminal, or the menu. New contacts
remain disabled until a ready agent account and messaging grant have been
selected. Connection checks alone do not enable replies.

Enabling revalidates the messaging identity and grants only currently available
actions, for at most 30 days and 100,000 actions. While the contact remains enabled,
the daemon can renew that bounded grant after checking current provider state,
recipient identity, settings revision and remaining capacity. Textbutler also
enforces its per-contact reply rate limit. Textbutler shows grant expiry, recovery
requirements and last-confirmed rich-message capabilities. Pausing stops new
dispatches; disabling also revokes the grant. An uncertain revocation retains
private recovery state and blocks dispatch until reconciliation succeeds.
Before requesting a grant, the daemon durably records its intent. A lost creation
response is recovered through a read-only lookup of that exact intent; recovery
never creates a replacement grant. Returned grants are persisted before contact
activation, and failed cleanup retains them until revocation is confirmed.

See [the architecture](../../docs/textbutler/architecture.md) for the complete
folder contract, background lifecycle, rich action rules, provider seam,
and remaining live acceptance criteria.

## Write a hook

Extensions are trusted owner-installed application code. The daemon loads only
files listed in `plugins/extensions.json` under its private data directory.
The directory must have mode `0700`, and the manifest and entry files must have
mode `0600`, with no symlinks or hardlinks. Creating a contact or editing its
memory never installs a plugin. For example:

```json
{
  "schemaVersion": 1,
  "extensions": [
    { "id": "quiet-hours", "version": "1.0.0", "entry": "quiet-hours.ts" }
  ]
}
```

Copy `examples/quiet-hours.ts` into that plugin directory, adjust its fixed UTC
hours, and restart the daemon process. Its default export supplies the matching
ID, version and hooks. The manifest order determines execution order. Unlisted
files are never imported. Changes require a full process restart, preserving
the active run's hook collection. An invalid manifest or module stops startup.

Code integrations can register extensions directly instead. Pass the same
`Hooks` instance to the runtime and routed agent to observe committed memory
edits as well as response lifecycle events:

```ts
import { Hooks } from "./packages/textbutler/src/index.ts";

const hooks = new Hooks();
hooks.register({
  id: "quiet-hours",
  version: "1.0.0",
  hooks: {
    "reply.before-send": async ({ signal }) => {
      signal.throwIfAborted();
      const hour = new Date().getUTCHours();
      if (hour < 8 || hour >= 22) return { veto: true, note: "Quiet hours" };
    },
  },
});
```

The API offers lifecycle observation and vetoes. `memory.updated` includes the
changed file path and committed revision; notification failure cannot undo a
committed write. Modules and their imports run with the daemon's full authority;
this is not an untrusted plugin sandbox. Keep executable extensions outside
contact folders. An agent can evolve `AGENTS.md`, `MEMORY.md`,
and the other workspace context files; those edits never install executable
hooks or change activation, account, recipient, or send authority.

## Verify

```sh
bun test packages/textbutler
bun x --no-install tsc --noEmit -p packages/textbutler/tsconfig.json
```

Tests use synthetic contacts and injected transport/provider implementations.
They exercise human takeover, duplicate events, disclosure, conflicting memory
edits, links, admission failures, and uncertain sends without contacting people.
