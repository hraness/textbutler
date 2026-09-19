# Textbutler readiness

Textbutler currently supports a local, owner-controlled pilot. Its terminal and
menu can connect configured messaging accounts, select direct conversations,
show the reply inbox and manage contacts. An owner can write a reply, review its
complete disclosed text and explicitly send it. Installation starts no service,
connects no account and enables no automatic replies.

This is not yet an unattended production assistant. The following boundaries
remain visible in setup and must be resolved before that claim is made.

| Area | Current state | Remaining acceptance evidence |
| --- | --- | --- |
| First use | Guided terminal, actionable readiness, additive configuration, paused defaults | First-run testing with real owner-selected accounts and permissions |
| Menu bar | Shared native Rust runner; setup, connections, contact controls, bounded menus and recoverable jobs | Confirm native lifecycle on each supported macOS release |
| Reply review | Complete ordered action review, recipient/context digest, attachment byte verification; typed preview revision checks | Agreed-recipient live delivery and takeover tests |
| Agent execution | Source and local pilot expose no qualified default AI engine | Reviewed runtime provenance for API execution, or a published confined native agent adapter with both classifier and reply profile evidence |
| iMessage | Existing native Ghostget connection | Current account permissions and live transport qualification |
| WhatsApp | Existing Ghostget linked-device connection and explicit sync | Current linked-device identity, sync and live transport qualification |
| Beeper | Direct text conversations through Ghostget 0.18.14+; independent connection checks | Current Desktop API/account setup, canonical pending-send reconciliation, and edit/delete observation coverage |
| Uncertain sends | Journal preserves intent and blocks further sends | Owner reconciliation using durable upstream run/message identity; no blind retry |
| Distribution | Local integrity-checked bundle and inert installer | Signed/public release provenance, upgrade qualification and provider-specific admission |

## Interface direction

XCB is a useful interaction reference: a clear status view, filtered pickers,
contextual choices, complete review and clean cancellation. Textbutler follows
that separation with a thin terminal client over its owner control protocol.
All permission, account, contact, grant and dispatch checks remain in the daemon.

The native menu already uses the shared Rust desktop foundation. A new Rust
runtime is not required to make these controls usable. If the terminal grows
into a full-screen workspace, XCB's Ratatui/Crossterm interface is an appropriate
reference. Reusing its constrained agent execution requires a published adapter
and qualification contract; launching its CLI with inherited tools or sessions
would not provide that boundary.

## Messaging expansion

Use Beeper for linked Signal, Telegram and Instagram conversations while
retaining native iMessage and WhatsApp. Current Beeper automation is text-only;
capability labels must not promise attachments, reactions, polls or delivery
confirmation that its adapter does not supply.

A native Telegram client, an owner-linked Signal adapter and an Instagram
professional-account integration have different account models and operating
requirements. They should enter through Ghostget's scoped transport contract,
with explicit capabilities and live acceptance criteria. Business/bot APIs are
not substitutes for a personal inbox. See [messaging app support](messaging-apps.md)
for current primary sources and the limits of each approach.

## Operational checks

Before enabling automatic replies, verify the exact installed artifact, model
account, messaging identity and selected recipient. Exercise pause, owner
activity during composition, cancellation just before dispatch, transport loss,
restart during an uncertain send and grant expiry. A passing synthetic suite is
source evidence; it does not prove real delivery or native agent isolation.

Retain failed or uncertain custody records. Reinstallation, restart and setup
must not delete them to make an account appear ready.
