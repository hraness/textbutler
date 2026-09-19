# Start using Textbutler

Textbutler is a local Mac assistant for selected conversations. Start with its
inbox and replies you write yourself. Automatic replies stay paused until you
choose a ready agent and explicitly enable a contact.

**Current limit:** the source CLI supports messaging setup, conversation
selection, inbox review and explicit typed replies. It does not include a
qualified AI reply engine. Codex and Claude Code are unavailable; Claude API
requires a reviewed compiled runtime supplied by a trusted host. A signed-in
coding agent alone does not make suggestions or automatic replies available.

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

The installer builds a self-contained local pilot and verifies its contents
and exact Bun runtime before use. It starts no services and connects no accounts.
An existing, different `textbutler` command is preserved. This is a local build,
not a signed public release; its AI engine remains unavailable. Keep the same
Bun runtime installed. For a later build, use a separate `--prefix` and stop the
old services before switching; automatic upgrades are not supported yet.

The terminal has numbered actions for setup, app connections, conversations,
replies, contacts, pause and the menu bar. Enter goes back from a selection;
`q` or Ctrl-C closes the terminal. It does not stop an installed background
service. Commands below use `bun run textbutler`; the help abbreviates that
prefix to `textbutler`.

Choose **Setup & readiness** first. It creates private settings and points you
to messaging setup. After saving your connections, return to **Setup & readiness**
to start the service at login. Repeating setup preserves existing settings and
contact activation. Use `doctor` at any time to see connection status, remaining
setup steps and whether reply generation is actually available.

## Connect your messaging apps

Textbutler uses an existing Ghostget installation for account sign-in, permissions
and messaging access. Set up the account there first. You will need its physical
executable path and the exact account ID; Textbutler does not guess an identity.

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

For foreground use, run `bun run textbutler daemon run` in another terminal.
For login startup, use `bun run textbutler daemon install`. Keep the checkout at
its current path while the source service is installed.

See [messaging app support](messaging-apps.md) for Beeper limitations and native
alternatives, including requirements that affect Telegram AI processing.

## Add one conversation and try the inbox

Choose **Add a conversation**, select the exact person and app, and choose
whether to import recent text history. Importing history never sends anything.
The new contact has automatic replies off.

Choose **Inbox & replies**. Textbutler lists unanswered incoming messages in your
selected conversations. Choose **Type a reply**, review the recipient and the
complete disclosed text, then type `send` if you want to send it. This path does
not require an AI account. Leaving the review sends nothing.

If a qualified agent becomes available, choose it under **Manage a contact**.
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
