Textbutler is a message butler for your Mac. It drafts replies to the iMessage, WhatsApp and Beeper conversations you pick, and by default the send decision stays with you.

A friend asks which weekend works for dinner, your sister wants the name of that plumber, and a former coworker wants to catch up. Each thread needs thirty seconds of thought and a reply you would send, and by Thursday there are dozens. Textbutler runs on your Mac, keeps each contact's context in files you can read, works from the history you choose to import, and writes drafts you check before they go out.

If you knew it as Message Like Me, this is the same project under a new name; messagelikeme.com now redirects here.

## Who it is for

Textbutler is for a Mac owner who is behind on personal conversations and wants to read every word the butler writes before it goes out. It also suits developers who already pay for a Claude Code or Codex subscription and want to see a reference application built on xcb.

It is the wrong tool if you want to message people you do not already talk to, send the same note to many people, or run an assistant that passes itself off as you. Textbutler works only in one-to-one conversations you add one at a time; group chats never start a reply. Its own replies carry a visible marker by default, and we recommend leaving it on.

## What it does today

Textbutler connects to your messaging apps through Ghostget, which handles sign-in and permissions, so the butler never opens the Messages database itself. You add one conversation at a time. A new contact starts switched off, and a new install starts paused. Adding a conversation never sends a message.

For each contact, Textbutler keeps a private folder of plain files: who the person is to you, dated notes, and evidence of how you write to them. Folders are named with opaque identifiers rather than names or phone numbers, and the model can only read and edit files inside the one folder it is working on. Importing history is a separate opt-in step. It takes up to 200 recent messages from that one conversation, keeps who said what and when, records anything it shortened or left out, and does not fetch media. It is a starting sample, not your whole archive.

The daily loop runs from the terminal:

```sh
textbutler inbox                        # which chats have unanswered messages
textbutler replies suggest <contact>    # ask for a draft for one of them
textbutler replies show <draft>         # read every line it would send, and to whom
textbutler replies send <draft> <digest>
```

`inbox` only reads. A suggestion is a draft that expires after fifteen minutes and never sends on its own. `show` prints the exact recipient, every message in order, and a digest of that review. `send` sends only the draft that matches the digest you just read; if the conversation moved on, your disclosure settings changed, or the draft expired, it refuses instead of sending something stale. You can also type your own reply with `replies send <contact> <text>`, or `discard` a draft you do not like. The menu bar companion can check for replies and preview drafts, but a shortened preview there cannot authorize a send.

When the butler writes, trusted code wraps its text in a marker the other person can see. The default looks like `🤖{ hello this is my response }`. You can change those markers per contact. You can also clear them, and then the other person sees plain text with nothing to show the butler wrote it, so tell people you use it if you do that. Either way Textbutler records privately which messages it wrote, so its own words never get mixed back in as examples of your style.

AI drafts run through xcb on the Claude Code or Codex subscription you already have. xcb keeps your sign-in, and the model receives no tools of its own: it returns text or a proposed action, and Textbutler checks it before anything else happens. The details are in [How Textbutler uses xcb](/blog/how-textbutler-uses-xcb).

To start, clone the repository and open the guided terminal with Bun {{BUN_VERSION}}:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run textbutler tui
```

Choose **Setup & readiness**, then **Connect messaging apps**. You can read your inbox and send replies you write yourself without any AI account. AI drafts need a local build (`bun run textbutler:install`) and a connected xcb account.

## Where it is going: a habitat for each conversation

You write differently to your mother than to your running partner, so one style profile per owner misses most of what matters. Textbutler's longer bet is that each conversation gets its own small, private learning space, which the source calls a habitat.

Habitats are opt-in and switched on by the owner. Each conversation gets its own, and nothing is shared between them, even between two threads with the same person. You can write a fixed core for a contact, covering your voice, your shared history and any boundaries, and the habitat treats it as an anchor it may not rewrite. Over time a background step looks at how past replies landed and proposes a new reply plan: warmer or more direct, more or less formal, longer or shorter, more or less humor. A candidate plan replaces the current one only after a blind side-by-side replay, scored by a separate judge, shows it did no worse on either of the two most recent cases that got a response, and better by a set margin on average. Silence from the other person does not count as success.

A plan is style and strategy, stored as data. It cannot change who receives a message, which AI provider runs it, what tools are allowed, or whether replies are disclosed. Web search, meme search and the small code sandbox are switches only you control. The learning step is told to leave them alone and keep your core text word for word, and a candidate that changes either one is rejected before it can take over. You can inspect a habitat at any time; rolling it back or clearing what it remembered requires pausing the butler first. [How Textbutler uses ALGAL](/blog/how-textbutler-uses-algal) walks through how those programs run.

Habitats are the direction Textbutler is heading. The code is in the repository and runs only when you turn it on, and like the rest of Textbutler it is in development.

## Limits and status

Current status:

> {{SITE_STATUS}}

Other limits:

- **Local does not mean offline.** Textbutler, its files and its send log live on your Mac, and textbutler.app never receives your messages. To write a draft, though, it sends that contact's context to the AI provider you connected. Habitats default to a hosted model route, with a local model server as the alternative, and web search, if you turn it on, sends public queries to a search provider.
- **The butler can reply on its own only if you set that up.** For a contact you switch on, after you resume the butler, Textbutler can answer when asked by name or when a classifier is confident help is wanted. Those replies carry the marker unless you cleared it, wait five minutes after you last wrote, are capped per hour, and apply to at most five contacts unless you raise the limit. Disabling the contact or pausing everything cancels pending replies. Leave contacts off and it only drafts.
- **History is a sample.** Import is capped, per conversation and without media.
- **The Ghostget connection is still being checked.** The live link between Textbutler's background service and Ghostget is waiting on live testing across apps. Beeper reaches apps such as Signal and Telegram as text only, and what is available depends on your linked accounts. Telegram's terms restrict using its content with AI, and connecting through Beeper does not change that. [How Textbutler uses Ghostget](/blog/how-textbutler-uses-ghostget) covers what that connection does and does not do.
- **No signed app yet.** You build it yourself, and a rebuilt local copy may need macOS permissions granted again.

[PeopleBlade](https://peopleblade.com), a local-first CRM for your personal agent, shares Textbutler's message bundle format: both tools implement the versioned message-like-me.local-message-bundle interchange without importing each other's private state.
