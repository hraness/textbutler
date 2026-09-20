# Textbutler

<!-- impeccable:product-schema 1 -->

## Platform

web

The product is a macOS-only CLI with a separate user-session daemon and a
native menu-bar companion. A locally built TextButler.app supervises the verified
runtime so macOS can grant iMessage access to the app. It has no desktop window.
This platform marker does not imply Windows, Linux, iOS, or browser-hosted
messaging support. The public website is informational.

## Users

Mac owners who want a clearly identified personal assistant to help selected people through their existing conversations. Developers can write extensions and supply their preferred coding agent.

## Product Purpose

Choose a few contacts, give each relationship a folder of context, and let a butler help when it is useful. The owner can pause the whole butler or disable an individual contact. The assistant learns from bounded conversation history and maintains readable, editable memory.

## Positioning

The owner connects a Claude Code or Codex subscription through
[xcb](https://github.com/hraness/xcb). xcb owns provider authentication,
confinement, account custody and zero-tool generation. Ghostget owns messaging
access. Textbutler owns contact selection, memory, disclosure, timing, response
policy and sending. A verified Textbutler build must pass its own reviewed composition admission
before subscription inference is available. Its MIT-licensed source is a reference application for
developers building on xcb's native application API.

## Operating Context

The Mac must be awake and signed in for local messaging. Quitting the menu companion leaves the separately installed user agent running. A global pause is always available. Contacts are selected explicitly; smart response is the default mode after activation. The keyword defaults to `butler`. The three disclosure fields default to `🤖`, `{`, and `}` and produce `🤖{ hello this is my response }`. Each field may be cleared individually or together; cleared fields remove the visible wrap while the daemon still attributes butler output through its send journal.

## Capabilities and Constraints

- Subscription providers receive zero tools through xcb. They propose bounded operations that Textbutler's broker may perform within one selected contact workspace, public web access and staged messaging actions. No shell or arbitrary process tools are exposed.
- The agent may evolve contextual guidance and memory. Trusted activation settings, provider credentials, executable extensions, routing, and permission grants remain outside its workspace.
- Human activity, global pause, contact pause, deduplication, and rate limits take precedence over an LLM decision. The cheap classifier can choose silence; it cannot expand authority.
- Rich actions include files, reactions, stickers, links, and mini-app experiences when the transport explicitly supports them. Unsupported capabilities are visible rather than silently imitated.
- History bootstrapping never triggers sends. Owner-authored text provides owner-style evidence; incoming messages and butler output do not.
- A separate owner workflow answers "what do I need to reply to?": the inbox scan lists conversations with unanswered inbound runs, `replies suggest` drafts a reviewable reply, and `replies send` dispatches only an explicit owner choice. Suggestions never send themselves.
- Message Like Me was an unused product spike. Its wire contracts and published artifacts still have downstream consumers and must not be changed in place.

## Brand Commitments

Name: Textbutler. Domain: textbutler.app. The owner explicitly permits
redesigning the previous product. Ghostget is the reference for the native
provider seam; Textbutler's supported surface is the CLI and status item.

## Product Principles

1. Make it obvious when the butler speaks.
2. Keep each relationship's memory inspectable and isolated.
3. Yield to the owner before composing and immediately before dispatch.
4. Expose proven transport capabilities with honest limitations.
5. Keep reusable agent execution separate from messaging policy.

## Evidence on Hand

The existing repository contains bounded history ingestion, provenance-aware
profiles, and frozen shared message contracts. New source packages contain the
Textbutler runtime, provider-independent transport and external xcb connection.
Automated fixtures are synthetic. They are not evidence of live provider
qualification or actual message delivery. The optional native app is built and
ad-hoc signed on the owner's Mac; it is not a notarized public distribution.
The CLI and menu-bar companion remain the user interfaces.

## Open Decisions and Working Defaults

The user delegated implementation judgment. The initial activation limit is five contacts, configurable from one to fifty. Smart response uses an eight-second message-burst delay, five-minute owner cooldown, twelve responses per contact per hour, and a classifier confidence threshold of 0.85. These are tunable initial defaults, not measured ideal values. A compact native menu and explicit CLI commands are the working interface direction. Optional Linq transport remains a proposed extension; Ghostget is the required primary boundary.
