# Messaging apps

Textbutler can use native iMessage and WhatsApp connections through Ghostget,
or a Beeper connection for several messaging apps at once. For a Mac with
iMessage, WhatsApp, Signal, Telegram and Instagram, Beeper is the simplest
shared connection. Each conversation still needs its own enrollment and reply
settings. An available connection does not by itself enable automatic replies.

## Choose a connection

| App | Current route | Other options |
| --- | --- | --- |
| iMessage | Ghostget's native Mac connection, or Beeper on that Mac | Keep the native connection for users who do not use Beeper. Apple's Messages framework creates iOS conversation extensions; it is not a Mac inbox API. |
| WhatsApp | Ghostget's reviewed linked-device connection, or Beeper | The official WhatsApp Business Platform is a separate business integration, not a connection to an ordinary personal inbox. |
| Signal | Beeper | A future `signal-cli` connection is possible, but it is unofficial and needs separate maintenance and qualification. |
| Telegram | Beeper, subject to the content-use limits below | Telegram's official TDLib supports personal client sessions. A direct connector is a future option, not currently implemented in Textbutler. |
| Instagram | Beeper | Meta's official messaging API supports professional accounts. It does not cover the same personal-inbox use case. |

Beeper documents support for these networks, with iMessage limited to macOS.
Its Desktop API runs locally while Beeper Desktop is open. Beeper recommends
on-device connections for this API; initial history can be incomplete.
See [Beeper's Desktop API overview](https://developers.beeper.com/desktop-api/)
and [connection types](https://help.beeper.com/chat-networks/using-on-device-chat-network-connections-in-beeper).
Beeper labels the API a [public beta](https://www.beeper.com/desktop-api).
Apple describes its [Messages framework](https://developer.apple.com/documentation/messages/)
as a way to create sticker packs and iOS conversation extensions.

## Connect Beeper

1. Install Beeper Desktop and connect the messaging accounts you want to use.
   Prefer on-device connections when using this Mac as your messaging host.
2. Enable Beeper's local API. Its current authentication guide places approved
   connections under **Settings → Integrations**; some releases use
   **Settings → Developers**. Authorize Ghostget using its supported Beeper
   account setup. Keep credentials out of contact folders.
3. Use a Ghostget release that includes Beeper owner automation. This support
   entered Ghostget's 0.18.14 source. It requires the reviewed Beeper adapter
   and pinned Beeper CLI; an older read-only export setup is insufficient.
4. Allow Ghostget's exact Beeper automation read and text-send operations for
   that account. Then select its account ID in Textbutler setup.
5. Enroll a single conversation, inspect its identity, and start with a reviewed
   reply. Enable automatic replies separately after the connection and selected
   agent account pass their checks.

The current Ghostget automation route supports Beeper text sends and bounded
conversation history. Beeper's wider API also offers attachments and other
actions, but those are not yet admitted through this Textbutler route. The
connection requires Beeper Desktop to remain open. Restart and reconnect should
finish catching up before new messages can trigger a reply.
See the [Ghostget owner contract](ghostget-contract.md) and
[Beeper authentication](https://developers.beeper.com/desktop-api/auth/).

iMessage in Beeper requires the Mac's Messages data, Automation, Accessibility
and Contacts permissions. Beeper may briefly bring Messages into view. That
connection remains on the Mac where it was configured.
See [Beeper's iMessage setup guide](https://help.beeper.com/en_US/chat-networks/new-imessage-on-macos-getting-started-guide).

## What “sent” means

Beeper returns a pending message ID when it accepts a send request. That is not
proof of delivery. The API can resolve that ID through a subsequent message
read; delivery status is available only when the network reports it. Textbutler
must preserve an uncertain result without sending the message again.
See [Beeper's send contract](https://developers.beeper.com/desktop-api-reference/resources/messages/methods/send/).

The optional Beeper WebSocket stream is experimental. Its sequence numbers
apply to one connection, so they are not durable restart cursors. A production
connector needs bounded catch-up reads after reconnection. Ghostget currently
owns the durable observation boundary for Textbutler.
See [Beeper's event stream](https://developers.beeper.com/desktop-api/websocket-experimental/).

## Expansion without Beeper

**iMessage and WhatsApp:** Improve the existing Ghostget setup and recovery
paths first. Text and file support on iMessage should work with ordinary Mac
permissions; advanced native actions depend on separately configured support.
The current WhatsApp connection uses a reviewed private build of
[wacli](https://github.com/openclaw/wacli), an unofficial linked-device client.
Its pairing and update requirements are part of the integration.

**Telegram:** TDLib is the strongest documented route to a direct personal
client. It supplies login state changes, local storage, `getChatHistory`, and
`sendMessage`. A shipped client needs its own application ID and hash, a user
login flow, and protected local session storage.
See [Telegram's TDLib guide](https://core.telegram.org/tdlib/getting-started)
and [application registration](https://core.telegram.org/api/obtaining_api_id).

Telegram's current terms restrict using platform content with AI. The content
license describes exceptions only when all relevant users provide explicit,
informed, affirmative and continued consent for the specific content and chat
context. A Beeper connection does not remove that restriction. Do not treat
owner login alone as authorization for unrestricted Telegram AI processing;
resolve the applicable consent requirements before enabling that workflow.
See [Telegram's API terms](https://core.telegram.org/api/terms) and
[content license](https://telegram.org/tos/content-licensing).

**Signal:** A future Ghostget adapter could link `signal-cli` to an existing
account, receive messages through its daemon, and submit exact recipient-bound
sends. The project explicitly calls itself unofficial and warns that versions
older than three months may stop working. This adds a linked device and a
maintenance obligation; it is not an official Signal integration.
See [the signal-cli project](https://github.com/AsamK/signal-cli).

**WhatsApp Business and Instagram professional accounts:** These are viable
future business connectors with their own setup. WhatsApp uses a business
account, registered business number, access tokens and webhook subscriptions.
Instagram requires a professional account and messaging permission; its Send
API generally replies after a person initiates contact and does not support
group messaging. Neither route should be offered as a replacement for a
personal inbox. See Meta's [WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
and [Instagram Send API](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api).

For personal Instagram, keep Beeper as the supported connection path. Avoid
adding an independent private-API or browser-session connector until it has a
maintained provider contract and reliable account recovery.

These recommendations reflect documentation checked on September 19, 2026.
Synthetic tests establish parser, permission and recovery behavior. A live
acceptance check still needs the intended account, one exact recipient and an
authorized message; it must verify reconnect and uncertain-send behavior as
well as the first successful request.
