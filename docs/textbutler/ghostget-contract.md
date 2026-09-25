# Ghostget integration contract

Textbutler owns reply policy and contact memory. Ghostget owns messaging
accounts, native permissions, synchronization, event storage and outward
actions. Textbutler communicates with its own Ghostget owner process through
`ghostget messaging automation serve --stdio`; it does not share the Ghostget
menu companion's private helper or open provider databases.

The automation contract was first admitted with
[Ghostget 0.18.2](https://github.com/hraness/ghostget/releases/tag/v0.18.2).
This development version of the native `TextButler.app` iMessage setup pins Ghostget
0.18.21. Its matching artifact and live conversation checks remain pending.
The required contract preserves the native helper's resource bundle, avoids
opening unrelated protected folders during state validation, and exposes bounded
discovery diagnostics without message bodies. Valid native chat rows without
usable participant metadata are omitted from partial discovery results; they
cannot become sending targets. Follow the
[current setup guide](getting-started.md#give-textbutler-access-to-imessage).
Installation is explicit and starts no provider. Older generic CLI routes do
not become automation grants.

## Owner process

The private protocol is `ghostget.messaging-automation/1`. Every bounded JSON
request has an ID, method and parameters; every response repeats its protocol
and ID and carries either a checked result or a typed error. Initialization
selects up to two explicit accounts, one per network, through stdin. Contact
memory and model tools cannot configure that process or invoke its control API.

Textbutler records process custody before launch, bounds its streams and queue,
and removes custody only after a successful close response and verified clean
process exit. Cancellation and revocation can interrupt an active submission.
A malformed response, crash or uncertain cleanup retains the recovery fence.
Restarting Textbutler does not silently clear it.

## Contacts, events and grants

| Surface | Implemented contract |
| --- | --- |
| `status`, `start` | Observe capabilities; explicitly start supported synchronization. |
| `conversations`, `enroll`, `enrollments` | Exact account generation and direct participant-bound conversation enrollment. |
| `poll`, `pollSet`, `history`, `events` | Bounded history, durable observation cursors, revisions, catch-up and gap detection; `pollSet` shares one provider session across a contact set and reports each enrollment separately. An enrollment busy with another operation reports its current stored row — not necessarily synced this tick. |
| `grant`, `grant.get`, `grant.by-intent`, `revoke` | Recipient, action, expiry and quota limits; idempotent issuance lookup and immediate revocation. |
| `asset`, `prepare` | Admit exact attachment bytes and bind the ordered action list to a context revision and expiry. |
| `submit`, `cancel`, `run` | Journal an action claim before dispatch and retain accepted, failed, partial or indeterminate results. |
| `close` | Wait for owned provider cleanup before acknowledging shutdown. |

Enrollment records contain the provider account incarnation, source generation,
implementation identity, exact conversation coordinate and participants. Display
titles are labels, not authority. Account or participant replacement invalidates
the binding. Existing Textbutler version 1 read bindings remain readable;
automation requires explicit version 2 enrollment.

Ghostget's managed permissions must explicitly allow each requested operation.
A broad capability advertisement does not create a grant. Textbutler activation
issues a bounded grant only after checking the selected agent account and
conversation. It renews standing enabled-contact grants within their limits,
and persists grant intent before issuance so a lost response can be resolved
without blindly creating another grant. Disabled and uncommitted grants are
reconciled through revocation.

Startup, re-enablement and recovery drain old events silently. An unresolved gap
pauses automation. Textbutler waits for a new eligible inbound event and applies
debounce, owner cooldown, classification and rate limits. Ghostget rechecks
identity, permission, context and grant before dispatch, and observes intervening
conversation changes between actions. Neither component retries an uncertain
send automatically.

## Rich actions

Attachments, reactions, stickers, rich links and native polls are separate
capabilities. They become available only when the installed provider, current
account and managed permission admit them. Message targets must belong to the
enrolled conversation. Attachment and sticker paths are resolved by Textbutler's
contact file broker; Ghostget receives admitted bytes, not arbitrary paths.

Every response starts with disclosed text while disclosure markers remain
configured. For a nontext response, Textbutler inserts a companion such as
`🤖{ … }` before the rich actions; when the owner clears all three disclosure
fields no companion is added and butler authorship is carried by the accepted
message IDs the run receipt returns to Textbutler's journal instead of by
visible text. Execution stops
when a preceding action fails or the conversation changes. An accepted receipt
does not claim delivery.

Native iMessage exposes text and files through the pinned helper and its
currently usable rich methods for six standard tapbacks, stickers, links and
polls. Rich methods require the owner's separately configured native bridge.
App Clips and arbitrary mini-app experiences remain unavailable: no reviewed
native executor exists. Linq's hosted APIs are a design reference and cannot
silently substitute another sender for the owner's personal conversation.

## Verification boundary

The source tests cover account changes, cursor restart and gaps, grant revocation
and lost responses, exact byte admission, ordered actions, cancellation and
uncertain results using synthetic accounts. They do not establish live provider
delivery. A bounded live acceptance test needs explicit account, recipient and
message authorization and must record the exact provider/runtime versions.
See [WhatsApp](whatsapp.md) and [the architecture](architecture.md).
