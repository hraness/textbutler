If you already pay for Claude Code or Codex, Textbutler can write your reply drafts on that subscription, and you do not need a second AI plan to get them.

## Drafting help without another bill

A friend asks about Saturday, your landlord wants a time for the repair, and you would like a first draft of each reply. If you already pay for a coding subscription, a separate model plan for drafting would mean paying for AI twice.

Textbutler hands the writing to xcb, which talks to the subscription you have already signed in to. Your conversations, contacts and sends stay on Textbutler's side.

## What xcb is, for someone who has never used it

[xcb](https://xcb.sh), short for Excalibur, is a local tool that routes coding tasks across the Claude, Codex and Devin subscriptions you already pay for. It keeps the sign-in for each account, starts the provider's program when there is work, and keeps an account locked to one job until that provider process has exited.

xcb's main interface runs coding tasks. It also has a smaller mode for other applications: an app sends a prompt and gets text back. In that mode xcb gives the model no tools, loads no saved session and runs no hooks or plugins. The model can only answer.

xcb's documentation names Textbutler as the reference consumer of that mode. Textbutler accepts two of xcb's three providers: Claude Code and Codex. xcb's Devin support is still a candidate that has not passed xcb's own checks, and Textbutler does not accept a Devin account today.

xcb also decides which accounts an application may use. It offers an account and model to applications only after that exact pair passes xcb's application check, and that approval expires within 24 hours.

## How Textbutler calls it

On the Textbutler side, setup happens once, with Textbutler stopped. You point it at the xcb program on your Mac, the folder where xcb keeps its state, one account and one exact model name copied from xcb's own account and model lists:

```sh
bun run textbutler setup \
  --xcb /absolute/path/to/xcb \
  --xcb-state /absolute/path/to/xcb-state \
  --xcb-account claude:ACCOUNT_ID \
  --xcb-model FULL_MODEL_KEY
```

Use `codex:ACCOUNT_ID` to add a Codex account the same way. Setup records a fingerprint of the xcb program and the account you chose. It does not copy your subscription login, and it does not switch on any contact.

Every draft then follows the same loop:

1. **Check the program.** Before each call, Textbutler confirms the xcb program on disk still matches the SHA-256 fingerprint from setup. If you upgraded or replaced it, the call is refused until you review the change.
2. **Send the prompt privately.** The request, including that contact's context, goes to xcb on standard input, never in command-line arguments where other programs could see it.
3. **Read the answer strictly.** The reply must be well-formed, name the same account and model that were requested, and fit a size limit. Textbutler rejects JSON with a repeated key, so a reply cannot carry two values for one field.
4. **Carry out actions itself.** The model may ask for one of a short list of Textbutler actions: edit this contact's notes, read a public web page, or stage a reply. Textbutler checks each request and performs it for that one contact only. A run stops after 16 steps or 12 operations.

The split of responsibilities:

```text
xcb holds the login and runs the model.
Textbutler holds the contacts, the recipients and the send button.
```

The model never gets a file or messaging tool from the provider, and it cannot pick another contact, another recipient or a credential. Textbutler never passes your subscription login to xcb or reads it back.

AI drafting works only in a local build of Textbutler, made with `bun run textbutler:install`. The build carries a reviewed record of the exact source files and of Textbutler's two drafting profiles, one to decide whether a message wants a reply and one to write it. If the source has changed since that review, the build refuses. Running Textbutler straight from a source checkout leaves AI drafting switched off.

## What you get as a user

- **Drafts on the plan you have.** Replies are written by the Claude Code or Codex account you connected.
- **Your login stays in one place.** xcb keeps the subscription credentials. Textbutler's contact folders never hold them.
- **You decide what is sent.** A draft is only text until you read it with `replies show` and approve it with `replies send`. Trusted Textbutler code adds the disclosure marker (on by default), checks that the conversation has not moved on, and records the send.
- **No quiet switch to paid API use.** If the subscription route is unavailable, busy or out of date, Textbutler reports that and waits. It does not try another account or the Claude API.

## The API route is billed separately

Textbutler has a second way to draft: the Claude API, using an Anthropic API key you create. Anthropic bills that route per use, apart from any Claude Code subscription. You set it up on purpose: the key goes in a private file, you enter current prices from Anthropic's published pricing, and those price notes expire after 30 days. Each run reserves a conservative amount against a budget you set, $0.25 by default and at most $5. That reservation is a planning limit and does not cap Anthropic's invoice.

The two routes never mix. Choosing Claude Code or Codex never borrows an API key, and a failed subscription call cannot fall through to API billing. The API route also needs its own trusted packaged runtime, which a source checkout does not provide.

## Limits

This is a developer-built integration inside a product that is in development. You install xcb yourself, from its releases or from source, and it must be a build that includes the application mode Textbutler calls. Textbutler pins the exact xcb program you set up rather than a release number. It also pins a companion library, AgentMixer {{AGENTMIXER_VERSION}}, for shared helpers such as Claude API price parsing; that version number is not the version of xcb. A successful account check reads xcb's account list without making a model call, so it does not prove a draft will be good or a message will arrive. Automatic replies have been tested end to end only over iMessage, by the developer. Start with an unsent suggestion, and see [Introducing Textbutler](/blog/introducing-textbutler) for the full status and the rest of the reply flow. For how xcb itself works, read [Introducing xcb](https://xcb.sh/blog/introducing-xcb).
