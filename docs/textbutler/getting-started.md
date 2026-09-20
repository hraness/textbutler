# Start using Textbutler

Textbutler is a local Mac assistant for selected conversations. Start with its
inbox and replies you write yourself. Automatic replies stay paused until you
choose a ready agent and explicitly enable a contact.

AI replies require a verified Textbutler bundle with reviewed composition
admission and use a separately installed [xcb](https://github.com/hraness/xcb)
native runtime and an explicitly connected subscription account. This local
pilot requires current xcb admission and a successful account check. Installation
does not enable replies, and live messaging still needs verification with your
chosen recipient. Claude API retains a separate trusted runtime admission gate.

## Open the guided terminal

From your Textbutler checkout, with Bun 1.3.14:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run textbutler tui
```

For daily use, you can install a local command that works outside the checkout:

```sh
bun run textbutler:install
~/.local/bin/textbutler
```

The installer builds a self-contained local pilot, checks the reviewed
composition receipt against current source and contact profiles, and verifies
its contents and exact Bun runtime before use. Missing or stale composition
evidence blocks the build. Source daemon startup carries no such admission and
keeps subscription inference unavailable. It starts no services and connects no accounts.
An existing, different `textbutler` command is preserved. This is a local build,
not a signed public release. Connect xcb separately for AI replies. Keep the same
Bun runtime installed. To upgrade a verified existing installation, stop its
services and run `bun run textbutler:install --upgrade`. The installer checks
the existing launcher and complete installed version, preserves them for
rollback, and atomically switches the command. It never replaces an unrelated
command or changes your settings. Restart the installed daemon afterward.

The terminal has numbered actions for setup, app connections, conversations,
replies, contacts, pause and the menu bar. Enter goes back from a selection;
`q` or Ctrl-C closes the terminal. It does not stop an installed background
service. Commands below use `bun run textbutler`; the help abbreviates that
prefix to `textbutler`. You can use `~/.local/bin/textbutler` for these commands.
Use the installed terminal when setting up daemon startup for AI replies.

Choose **Setup & readiness** first. It creates private settings and points you
to messaging setup. After saving your connections, return to **Setup & readiness**
to start the service at login. Repeating setup preserves existing settings and
contact activation. Use `doctor` at any time to see connection status, remaining
setup steps and whether reply generation is actually available.

## Connect your messaging apps

Textbutler uses an existing Ghostget installation for account sign-in, permissions
and messaging access. You need its physical executable path and the exact account
ID; Textbutler does not guess an identity. Native iMessage can use the app setup
flow below. Set up other messaging accounts in Ghostget first.

Choose **Connect messaging apps** in the terminal:

- **iMessage:** the native Mac Messages connection.
- **WhatsApp:** a native linked device; connecting explicitly starts sync.
- **Beeper:** linked apps such as Signal, Telegram, Instagram, WhatsApp and
  iMessage. Keep Beeper Desktop open with its local API enabled. The current
  Ghostget automation adapter supports direct conversations and text replies.

Beeper automation requires Ghostget 0.18.14 or later with the
`ghostget.messaging-automation/1` protocol. A connection being configured does
not prove that it is connected. Check it before selecting conversations.

Initial setup can also be scripted. Replace the paths and IDs with your own:

```sh
bun run textbutler setup \
  --ghostget /absolute/path/to/ghostget \
  --account imessage:messages \
  --account beeper:beeper-main
```

If Ghostget's entrypoint is a TypeScript file, also pass
`--runtime /absolute/path/to/bun`. An optional `--state-home` selects its existing
state directory. Configuration is additive: this command preserves existing accounts and agent
settings and refuses to replace an account identity. Stop the service before
adding a connection, then run setup with the same connector paths and the new
account ID. To change existing bindings, stop the
foreground service or uninstall its login entry, review private
`state/host.json`, then restart or reinstall the service. Uninstall retains your
settings, contact memory and activity.

For foreground use with AI, run `~/.local/bin/textbutler daemon run` in another
terminal. For login startup, use `~/.local/bin/textbutler daemon install`. Use
your chosen installation prefix if different. Source daemon commands remain
available for the manual pilot; keep that checkout at its current path while a
source service is installed.

See [messaging app support](messaging-apps.md) for Beeper limitations and native
alternatives, including requirements that affect Telegram AI processing.

## Give TextButler access to iMessage

Use the native app when you want macOS Full Disk Access to belong to TextButler.
The app supervises its pinned runtime and background service. Build it from an
already installed, verified payload on your Mac:

```sh
bun run textbutler:app build \
  --from /absolute/installed/textbutler/version \
  --output /absolute/new/app-build-directory
bun run textbutler:app install --from /absolute/new/app-build-directory
```

The default destination is `~/Applications/TextButler.app`. Building and
installing the app does not start replies or change macOS permissions. In
**System Settings → Privacy & Security → Full Disk Access**, click **+**, press
**Command-Shift-G**, enter `~/Applications/TextButler.app`, and choose **Open**.
Enable its switch. macOS may require your password in its own dialog.

Configure the exact Ghostget `src/cli.ts`, Bun runtime, private state directory
and `imessage:ACCOUNT` binding using `setup` above. The native setup role supports
Ghostget 0.18.19. It links only that account to this Mac's Messages store and
enables Ghostget's account-specific automation read, text and attachment-send capabilities.
Contact selection and automatic replies remain separate choices.

With the background service stopped, run the setup role through its verified
app launch:

```sh
bun run textbutler:app imessage-setup \
  --data-dir "$HOME/Library/Application Support/Textbutler"
```

After app setup completes, use the installed `daemon install` command to
register its background service. If an older service is installed, first use
`daemon uninstall`; this preserves your settings and contacts. Startup verifies
the native app receipt and all pinned artifacts. A changed app or runtime
requires a verified rebuild and reinstall. Local apps use ad-hoc signatures,
so macOS may require permission again after a rebuild. Check `doctor` and the
messaging connection before enabling a contact.

To upgrade an installed app, stop the service and finish or reconcile any
pending setup attempt, then build from the new installed payload. Install it
with the following command:

```sh
bun run textbutler:app install --from /absolute/new/app-build-directory --upgrade
```

The upgrade verifies both versions and retains the previous signed
app and receipt. If it reports an uncertain transition, preserve its records
and reconcile that transition before retrying. Recheck Full Disk Access and
Messages Automation after the upgrade.

See [local data](local-data.md) for retained setup records and installation data
removal. Repeating setup preserves an already linked account and its identity.

For JSON commands to read, summarize, compose and send messages from another
agent, see the [agent CLI guide](agent-cli.md).

## Connect your AI subscription

Install an xcb native build with `generate` support and follow its
[account setup](https://github.com/hraness/xcb#native-xcb). Sign in through xcb,
then use `xcb accounts` and `xcb models` to obtain the exact account ID and full
model key. Credentials remain in xcb's private state.

With the Textbutler daemon stopped, connect that installation:

```sh
bun run textbutler setup \
  --xcb /absolute/path/to/xcb \
  --xcb-state /absolute/path/to/xcb-state \
  --xcb-account claude:ACCOUNT_ID \
  --xcb-model FULL_MODEL_KEY
```

For Codex, use `--xcb-account codex:ACCOUNT_ID` and a matching observed model.
Repeat setup to add a second account. The command pins the executable bytes and
explicit routing; it does not activate a contact. Setup refuses changes to an
existing binary or account/model binding. After an xcb upgrade, stop the daemon
and review its private `state/host.json` binding before updating the executable
digest. Retain account and custody state.

Start or restart the installed daemon, then check the account:

```sh
bun run textbutler providers list
bun run textbutler providers check TEXTBUTLER_ACCOUNT_ID
bun run textbutler doctor
```

Use the account ID returned by `providers list`. This checks xcb's current
capabilities and admission without making a model turn. Resolve any unavailable
or recovery status before asking for an unsent suggestion. See the
[subscription connection](native-subscription.md) for the execution and custody
contract. Source and bundle integrity checks alone do not qualify an AI provider.

## Add one conversation and try the inbox

Choose **Add a conversation**, select the exact person and app, and choose
whether to import recent text history. Importing history never sends anything.
The new contact has automatic replies off.

Choose **Inbox & replies**. Textbutler lists unanswered incoming messages in your
selected conversations. Choose **Type a reply**, review the recipient and the
complete disclosed text, then type `send` if you want to send it. This path does
not require an AI account. Leaving the review sends nothing.

After the connected agent passes its readiness check, choose it under **Manage a contact**.
A suggestion is an unsent draft. Review every action before sending. The CLI
supports the same review:

```sh
bun run textbutler inbox
bun run textbutler replies suggest CONTACT
bun run textbutler replies show DRAFT
bun run textbutler replies send DRAFT DIGEST
```

Use the exact digest shown by `replies show`. Changes to a draft or its attachment
bytes invalidate that review. A result of `submitted` means the transport
accepted the action; it is not proof that the recipient received or read it.

A pending command prints a job ID. Use `jobs show JOB_ID` with the same data
directory. Do not repeat an uncertain send or grant operation. Recovery fences
remain until the operation can be reconciled; restarting does not erase them.

## Use the menu bar

Choose **Menu bar companion** in the terminal, or run:

```sh
bun run textbutler menubar start
bun run textbutler menubar install
```

`start` opens it now; `install` registers login startup. The first start retrieves
and verifies the pinned shared native companion. No local Rust build is needed.

The menu gives you pause, connection checks, conversation selection, per-contact
activation, agent selection, the reply inbox and recent activity. Draft previews
are intentionally labeled: use the terminal to review complete outgoing actions
before sending. The menu cannot send hidden or truncated draft content.

Menu startup and daemon startup are separate. Quitting the menu leaves the
installed daemon running. `menubar stop` closes the menu; `daemon uninstall`
unregisters the background service and retains your data.

## Turn on automatic replies only when ready

Once a qualified agent and messaging connection are ready, select the agent,
choose the contact's response mode, enable that contact, then resume. These are
separate choices. The readiness view must show actual engine and transport
availability; successful setup alone is insufficient.

```sh
bun run textbutler contacts account CONTACT ACCOUNT
bun run textbutler contacts mode CONTACT keyword --keyword butler
bun run textbutler contacts enable CONTACT
bun run textbutler resume
```

`pause` stops automatic replies globally. `contacts disable CONTACT` also revokes
that contact's grant. Owner-confirmed replies remain a separate explicit action
while automatic replies are paused.

Your Mac must be awake and signed in. Begin with one conversation and confirm
behavior on an agreed test recipient before relying on automation. See
[agent setup](../../packages/textbutler/PROVIDERS.md) for the current engine
qualification requirements.
