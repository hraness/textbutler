# Use TextButler from an agent

TextButler's CLI returns JSON for conversation reads, summaries, drafts and
sends. Run it as the signed-in Mac user with the TextButler daemon running.
Connect iMessage and your AI subscription using the [setup guide](getting-started.md).
Explicit owner commands work while automatic replies are paused and the
selected contact is disabled.

## Select a conversation

```sh
textbutler conversations list
textbutler contacts add CANDIDATE_ID
textbutler contacts list
textbutler messages capabilities CONTACT_ID
```

Use the exact IDs returned by the preceding commands. A unique contact name
also works; ambiguous names fail. Adding a contact keeps automatic replies off.
Add `--history` to `contacts add` only when you want a retained history import.
Reading current history does not require that import.

## Read and summarize

```sh
textbutler messages history CONTACT_ID --limit 100
textbutler contacts account CONTACT_ID native-claude-code
textbutler messages summarize CONTACT_ID --limit 100
```

History includes message IDs, authorship, time, text, related message IDs and
attachment metadata when the provider exposes it. Ghostget 0.18.20's native
iMessage history currently omits attachment metadata. Limits range from 1 to
200 messages. The response reports
shortened text and omitted records; it is a recent sample, not a complete
archive. It does not download or interpret attachment contents.

Summaries use the contact's selected, qualified subscription account. The
response includes source message IDs and the size of the sample used. Review
the generated interpretation against those messages. A calling agent can also
summarize the history JSON itself without starting another inference request.

## Compose, review and send

For an AI suggestion, use `textbutler replies suggest CONTACT_ID`. To provide
the content yourself, create an unsent draft:

```sh
textbutler messages compose CONTACT_ID --text 'Tuesday works for me.'
textbutler replies show DRAFT_ID
textbutler replies send DRAFT_ID DIGEST
```

Use the digest returned by the complete draft review. It binds the recipient,
content and imported media. Changed conversations or media can invalidate a
draft. Disclosure settings apply to the reviewed and sent content.

An explicitly authorized literal text can be sent in one command:

```sh
textbutler messages send CONTACT_ID --text 'I have arrived.'
```

Treat that command as an outward action. A CLI's availability is not permission
for an agent to message someone without its user's instruction.

## Media and reactions

Inspect `messages capabilities CONTACT_ID` before requesting an action.
These commands create unsent drafts for the same review and send flow:

```sh
textbutler messages attach CONTACT_ID /absolute/photo.jpg --caption 'Our view today'
textbutler messages react CONTACT_ID MESSAGE_ID '👍'
textbutler messages react CONTACT_ID MESSAGE_ID '👍' --remove
```

Media imports accept owned regular files up to 16 MiB and copy them into the
selected contact's private outbox. The draft records the imported bytes; later
changes to the original source file do not change that copy. Common image,
audio, video and document types are recognized. Transport support and current
account permissions still determine whether an attachment can be sent.

For an ordered batch, put 1–7 supported action objects in a JSON array and use
`messages compose CONTACT_ID --actions /absolute/actions.json`. The supported
shapes are defined by the [action types](../../packages/transport/src/types.ts).
Attachment and sticker paths in an action object are relative to that contact's
workspace. The daemon validates targets, capabilities and imported media.

The current connector supports ordinary text and media on a Mac with the
required permissions. Reactions and other rich actions require its separately
configured Messages bridge. TextButler does not install that bridge or change
macOS security settings. Outgoing threaded reply targeting is currently
unsupported; the CLI does not turn a requested thread reply into an ordinary
message. Incoming reply relationships remain visible in history.

## Read uncertain results

Long operations may return a job ID. Read that exact job with
`textbutler jobs show JOB_ID`; do not repeat the original send. A successful
transport receipt reports `submitted`. A `partial` or `indeterminate` outcome
needs reconciliation before another attempt. Commands return a nonzero exit
code for pending or unsuccessful sends.

Append `--data-dir /absolute/private/path` to use another installation.
`textbutler messages --help` lists the agent commands.
