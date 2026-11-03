# TextButler

**Retired.** TextButler is no longer maintained. The source, tagged releases,
and release artifacts are preserved for historical reference. The setup and
operating instructions below are historical and are no longer supported.

> 💬 TextButler is an AI butler for your messages, running on your Mac. Turn it
> on for the iMessage, WhatsApp, or Beeper chats you choose, and it drafts or
> sends replies using your shared history and the notes you keep on each
> person, all in files you can edit. Replies carry a label by default,
> configurable per person.
>
> Ask your agent to set it up: https://textbutler.app

![AI in your messages: a friend asks “Butler, what time did Sam say?” in iMessage, and a reply marked 🤖{ } answers from what Sam wrote earlier.](site/public/launch/readme-hero-light%402x.png#gh-light-mode-only)
![AI in your messages: a friend asks “Butler, what time did Sam say?” in iMessage, and a reply marked 🤖{ } answers from what Sam wrote earlier.](site/public/launch/readme-hero-dark%402x.png#gh-dark-mode-only)

TextButler adds an AI assistant to the iMessage, WhatsApp, and Beeper chats
you choose on your Mac. By default, it answers when someone in the chat says
“butler”, and it marks its replies as AI.

TextButler runs on your Mac. New installs start paused until you choose which chats it can answer.

> **Maya:** are we still on for climbing tomorrow?\
> **Maya:** Butler, what time did Sam say? And is he bringing the harness?\
> **Sam’s Mac:** 🤖{ 👀 }\
> **Sam’s Mac:** 🤖{ On Monday Sam said Friday at 6:30 at the gym, and that
> he’d bring the spare harness for you. Nothing here has changed since. }
>
> *The first message gets no answer because it doesn’t say “butler”. The reply
> comes only from what Sam wrote earlier in the same chat.*

## Set it up with your agent

TextButler is set up from source by a coding agent such as Claude Code, Codex,
or Devin. Paste this prompt into your agent:

```text
Set up TextButler on this Mac: https://github.com/hraness/textbutler
Follow docs/textbutler/getting-started.md step by step.
Install or update GhostGet to exactly 0.18.71: https://ghostget.com/docs/tutorials/getting-started
Check `ghostget --version`, then restart or reconnect TextButler's GhostGet host so it checks the new capabilities.
Connect my iMessage, and WhatsApp or Beeper if I use them.
For replies, if Ollama is running with qwen3:4b-instruct-2507-q4_K_M, choose it with `textbutler providers local`; otherwise ask me which option I want.
Run `textbutler doctor` after each step and do what it says.
Stop and tell me whenever macOS asks for a permission, a pairing, or a key.
Leave every chat turned off and don't send any messages.
```

1. **Your agent installs it.** It clones this repository, installs
   [GhostGet](https://ghostget.com) for the messaging connection, and runs
   `textbutler doctor` until only your steps are left.
2. **You approve your Mac.** For iMessage, turn on Full Disk Access for the
   TextButler helper, then allow the Messages prompt when your agent reruns
   setup. For WhatsApp or Beeper, pair once. Then choose what writes replies.
3. **You turn on one conversation.** Every chat starts off, and the butler
   starts paused. Choose a direct or group chat and run `textbutler resume`.
   The next time someone there says “butler”, it answers.

The agent follows the [setup guide](docs/textbutler/getting-started.md), which
you can also read step by step.

## Open the guided terminal

To set it up yourself, use a Mac with Bun 1.3.14:

```sh
git clone https://github.com/hraness/textbutler.git
cd textbutler
bun install --frozen-lockfile --ignore-scripts
bun run textbutler tui
```

Choose **Setup & readiness**, then **Connect messaging apps**. TextButler uses
an existing GhostGet installation for messaging sign-in and permissions. Setup
and choosing a conversation never send a message.

For AI replies, install the local copy with `bun run textbutler:install` and
run `~/.local/bin/textbutler`. The installer refuses to build if the code doesn’t match the last reviewed version.
Before you rely on automatic replies, test with someone you trust on the
account you’ll use.

## What it works with

| Messaging app | What you get | What it needs |
|---|---|---|
| iMessage | Replies in selected direct and group chats | A Mac that stays awake and signed in to Messages. SMS, RCS, and reactions aren’t supported. |
| WhatsApp | Replies in selected direct and group chats through a linked device | Pairing during setup. The connection uses an unofficial WhatsApp client. |
| Beeper | Text replies in selected direct and group chats across its connected networks | Beeper Desktop open. Check each network’s terms before using AI with its messages. |

Messages reach TextButler through GhostGet, a separate Mac tool you
[install or update before connecting](https://ghostget.com/docs/tutorials/getting-started).
TextButler runs in the background with no window or menu bar icon. The website,
[textbutler.app](https://textbutler.app), never receives your messages.

## How it works

![One message, start to finish: a friend’s message arrives through GhostGet on your Mac, passes five checks and gets 🤖{ 👀 } right away, then your notes and the recent chat are read, your chosen model writes, and the marked reply goes back to the chat](site/public/diagrams/d1-one-message-wide.light%402x.png#gh-light-mode-only)
![One message, start to finish: a friend’s message arrives through GhostGet on your Mac, passes five checks and gets 🤖{ 👀 } right away, then your notes and the recent chat are read, your chosen model writes, and the marked reply goes back to the chat](site/public/diagrams/d1-one-message-wide.dark%402x.png#gh-dark-mode-only)

1. **Someone texts you** in a direct or group chat you’ve turned on. GhostGet
   passes the message to TextButler on your Mac.
2. **It checks before it answers.** Is this chat turned on? Are its members
   unchanged? Does the message match the reply mode? Have 5 minutes passed
   since you last wrote here? Is it under 12 replies this hour? It also waits
   8 seconds so a burst of texts gets one answer.
3. **It acknowledges the request** with `🤖{ 👀 }`.
4. **It reads the conversation** and the notes you keep for it: how you talk,
   what matters, and what’s off-limits. In your own chat it can also search
   your full history; for other chats that’s off unless you turn it on.
5. **Your chosen model writes the reply.** It can search the web only when a
   Gateway key is saved, and it refuses any search that would reuse words from
   your private messages.
6. **It replies in the same chat**, wrapped as `🤖{ … }`. If it can’t tell
   whether a send went through, it doesn’t send it again.
7. **You can step in anytime.** Write in the chat and it stays out. Pause
   everything with one command, or ask for a draft to review first.

**Keyword mode** is the default: it answers only messages that contain the word
“butler”, in any capitalization. **Smart mode** can recognize a request for
help without the keyword and stays quiet when it isn’t sure. You can ask it
too: say “butler” in any chat you’ve turned on, including your own.

Each group gets its own notes, separate from your direct conversations. Group
context starts with messages that arrive after you add the group. If its
members or account change, select the group again before replies resume.

## Pick what writes replies

![Where your words go with a local model: GhostGet, TextButler, and Ollama all sit inside your Mac, and nothing crosses its edge to write the reply](site/public/diagrams/d2-words-local-wide.light%402x.png#gh-light-mode-only)
![Where your words go with a local model: GhostGet, TextButler, and Ollama all sit inside your Mac, and nothing crosses its edge to write the reply](site/public/diagrams/d2-words-local-wide.dark%402x.png#gh-dark-mode-only)

Replies can be written by a local model through Ollama, by Qwen through your own Vercel AI Gateway key, or by your Claude Code, Codex, or
Devin subscription through xcb.

| Reply writer | Setup command | Where the conversation goes |
|---|---|---|
| A local model through Ollama | `ollama pull qwen3:4b-instruct-2507-q4_K_M`, then `textbutler providers local` | Reply writing stays on your Mac. Optional web search still sends queries through a saved Gateway key. |
| Qwen through your Vercel AI Gateway key | `pbpaste \| textbutler providers gateway-key` | Conversation context goes to Vercel AI Gateway. Spending stops at $1 a day. |
| A Claude Code, Codex, or Devin subscription | `textbutler providers check ACCOUNT` after connecting [xcb](https://github.com/hraness/xcb) | Conversation context goes through xcb to your chosen account. The reply model can’t run commands on your Mac. |

A writer you choose with a command wins. Otherwise a saved Gateway key wins,
and with no key saved, the background service picks up an Ollama server that
is already serving the pinned model. Stop the service before
`providers local`, and restart it after changing the writer.

With a Gateway key saved, the butler can also search the web in the
conversations you turn on (in your own chat, only when you ask), even when a
local model writes the replies. Turn search off for one conversation with
`textbutler habitats configure`. The
[subscription guide](docs/textbutler/native-subscription.md) covers xcb setup.

## Stay in control

A background service does the work, and you control it from the terminal:

```sh
bun run textbutler daemon install
bun run textbutler status
bun run textbutler pause
bun run textbutler resume
bun run textbutler contacts enable CONTACT
bun run textbutler contacts disable CONTACT
```

`daemon install` starts the service now and at every sign-in, as a per-user
LaunchAgent. `status` shows whether it’s running, whether replies are paused,
and each conversation’s state. `pause` stops every reply at once, and
`contacts disable` turns off one conversation. `daemon uninstall` keeps your
settings and conversation notes.

For AI replies, start the service from the installed copy:
`~/.local/bin/textbutler daemon install`. A service started with
`bun run textbutler` from the checkout doesn’t write AI replies.

### When TextButler doesn't reply

Start with read-only checks from the installed copy:

```sh
~/.local/bin/textbutler doctor
~/.local/bin/textbutler status
~/.local/bin/textbutler daemon status
```

- If replies are paused or the conversation is off, that is expected: new
  installs start paused with no chats enabled. Review the conversation before
  you turn it on using [Stay in control](#stay-in-control).
- If the service is disconnected, inspect `daemon status` and follow the
  [setup guide](docs/textbutler/getting-started.md). A service launched from the
  checkout does not write AI replies; use the installed copy.
- If the service is running but ignores a message, check that the chat is
  selected and that the message contains “butler” in the default keyword mode.
  Your recent reply, the hourly reply limit, or a changed group membership can
  also prevent a reply. See [How it works](#how-it-works).
- TextButler answers only while the Mac is awake and signed in, and the
  `doctor` report says so: “Replies need your Mac awake and signed in.” Closing
  the terminal doesn't stop the service.
- If `doctor` says your messaging apps are set up but not loaded, or you
  updated GhostGet, restart the service so it reconnects and checks each app
  again: run `~/.local/bin/textbutler daemon uninstall`, then
  `~/.local/bin/textbutler daemon install`. `daemon install` alone leaves a
  running service as it is. If an app no longer shows as connected, sign in to
  it again with GhostGet. Beeper also needs Beeper Desktop open.
- If iMessage chats stop loading, turn TextButler back on in System Settings ›
  Privacy & Security › Full Disk Access. When the **macOS access for iMessage**
  step in `doctor` isn't done, it names the setting to change.
- If the **AI replies** step isn't done, nothing can write a reply yet. Choose
  one in [Pick what writes replies](#pick-what-writes-replies).

If a send could not be confirmed, inspect status before repeating it. A missing
confirmation does not mean the message was not sent.

### Review a reply before it sends

```sh
bun run textbutler inbox
bun run textbutler replies suggest CONTACT
bun run textbutler replies show DRAFT
bun run textbutler replies send DRAFT DIGEST
bun run textbutler replies discard DRAFT
```

`CONTACT` is the exact contact ID or a unique name match. `replies show` prints
the recipient, the complete outgoing text, and the digest that `replies send`
needs; a preview alone can’t send. Drafts expire after 15 minutes, and a change
to the conversation, its settings, or an attachment requires a fresh review.
To send your own words, open the guided terminal, choose **Inbox & replies**,
pick a conversation, and choose **Type a reply**.

`submitted` means the messaging app accepted the message, not that the
recipient received or read it. A pending send prints a job ID; check it with
`bun run textbutler jobs show JOB_ID`. Don’t repeat a send whose outcome is
unknown. TextButler blocks it until the outcome is sorted out.

### Marker and notes

Replies and acknowledgments carry the `🤖{ … }` marker by default. You can
change or clear it for one conversation, but never in your own chat. The draft
review shows the exact text that will go out.

Each conversation you turn on gets a folder of plain files on your Mac
(`AGENTS.md`, `ABOUT.md`, `MEMORY.md`, `STYLE.md`) with your notes on how you
talk, what matters, and what’s off-limits. Your settings and sign-ins live
elsewhere, where the butler can’t change them. Optional learning is off by
default and needs a Claude Code subscription through xcb. It can remember up to
64 sourced notes and adjust tone per chat; `textbutler habitats show` lists
them and `textbutler habitats memory-clear` removes them.

## For agents

Every command takes `--json`, and `textbutler commands --json` lists each
command with who may run it. Commands that send a reply or turn a chat on need
you in person: an agent gets `human-required` and nothing changes.
`textbutler tui --snapshot` prints the guided terminal’s views as plain text.

The [agent JSON CLI](docs/textbutler/agent-cli.md) lets an agent list
conversations, read and summarize history, prepare text or media drafts, and
send a message you explicitly authorized, through the same staged steps the
butler uses. See the [command reference](docs/textbutler/cli-parity.md) for
every command.

## Compared with other tools

Smart Reply in Apple Messages and Writing Help in WhatsApp suggest replies you
send yourself. [GhostReply](https://ghostreply.lol) is a $4.99 Mac app that
answers iMessages in your texting style. [OpenClaw](https://openclaw.ai) is an
open-source assistant you message, and it can run commands on your computer.
TextButler answers only in the conversations you turn on, keeps editable notes
for each one, marks its replies by default, and its reply model can’t run
commands on your Mac. Read the side-by-side comparisons with
[OpenClaw](https://textbutler.app/compare/openclaw),
[GhostReply](https://textbutler.app/compare/ghostreply), and
[other assistants](https://textbutler.app/compare).

## Docs

| Guide | Read it to |
|---|---|
| [Getting started](docs/textbutler/getting-started.md) | Install, connect your messaging apps, and turn on a first conversation |
| [Messaging apps](docs/textbutler/messaging-apps.md) | See what each connection supports and its limits |
| [AI subscriptions through xcb](docs/textbutler/native-subscription.md) | Write replies with Claude Code, Codex, or Devin |
| [Agent JSON CLI](docs/textbutler/agent-cli.md) | Drive TextButler from a coding agent |
| [Command reference](docs/textbutler/cli-parity.md) | Look up every command and who may run it |
| [Architecture](docs/textbutler/architecture.md) | Understand how the parts fit together |
| [Provider setup](packages/textbutler/PROVIDERS.md) | Configure reply providers as a developer |

TextButler keeps each conversation’s context in files you can read and edit,
marks its own replies by default, and answers only after you turn a
conversation on: the design every Hraness project shares. [The thread through Hraness](https://hraness.com/writing/the-thread-through-hraness)
follows that design across the projects, and the
[ALGAL vision](https://algal.computer/docs/vision/) states the bet behind it.

## Develop and contribute

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` type-checks the project, runs the test suite, validates the
bundled Agent Skills, rebuilds `dist/`, and tests a packed install.
`bun run check:textbutler` runs only the TextButler packages.

Tests use only synthetic messages, contacts, archives, and conversations. Never
add a real message, handle, group title, attachment, contact record, private
path, or derived profile to a fixture. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before opening a change, and report security issues as described in
[SECURITY.md](SECURITY.md).

## Support

`textbutler support` shows optional ways to support TextButler’s development.
The background service and administrative commands never show these notices,
and `HRANESS_SUPPORT=off` turns them off everywhere else. Support state stays
on your Mac; these commands don’t sign you up or charge anyone.

## License

MIT
