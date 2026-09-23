# Security

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/hraness/textbutler/security/advisories/new).
Do not open a public issue containing a message, handle, contact name, group
title, attachment, local path, profile, study or Ensoul packet, installation key, or
database detail that could identify a person.

Include the affected version, platform, command or library call, expected
boundary, observed result, and a reproduction built from synthetic data.

## Private-data boundary

Message Like Me reads private messaging history to derive local analysis. The
following values are sensitive even when they do not contain an obvious name:

- the source Messages and AddressBook databases and their SQLite sidecars;
- X data archive ZIPs and their archive, account, and overlap provenance;
- local message bundles, manifests, connected-account metadata, and provider
  provenance;
- contact names, email addresses, and phone numbers;
- message bodies, timestamps, reply links, tapbacks, and attachment metadata;
- contact, participant, conversation, and group metadata;
- the per-install HMAC key and all normalized corpus records;
- aggregate metrics, study packets, style profiles, drafting context, and
  unsent drafts;
- opaque Ghostget route and context references, private handoff files, and full
  Ghostget receipts before their body-free audit projection.

The default data root is
`~/Library/Application Support/Message Like Me/` on macOS. The CLI creates
owned physical directories with mode `0700` and private files with mode
`0600`. It rejects symbolic-link redirection and foreign-owned source files at
the checked boundaries.

These filesystem permissions protect against accidental disclosure to other
local users. They are not encryption and do not protect data from another
process already running as the same user, a compromised agent host, malware,
device backup access, or an administrator.

## Private agent handoffs

`routes list` writes source-conversation candidates only to an explicit
mode-`0600` file. Its stdout contains a digest, counts, and selection state.
The explicit `--private` file view contains only exact provider account,
source, and conversation coordinates already observed during ingestion. It
does not derive a send locator from a contact name, handle, title, or
participant set. X archives are evidence-only. Handoff v1 also rejects group
candidates, and an ambiguous direct-candidate inventory does not choose a
route automatically.

`handoff prepare` reads a mode-`0600`, singly linked route request, Ghostget
context file, and draft file through stable file descriptors. A route candidate
never appears in argv or stdout. It rejects symlinks,
foreign ownership, broader permissions, file replacement, invalid UTF-8,
unknown contract fields, unsupported contract hashes, stale context, controls,
duplicate bubble IDs, and byte or count overages. The output is another
explicit mode-`0600` file. Message text and raw Ghostget route or context
references never enter argv, ordinary stdout, diagnostics, or the SQLite audit
table.

The body-free Ghostget receipt binding contains no raw route or context
reference. Its pinned contract binds hashes of those references, the client
intent, the exact ordered turn, and the private preview. The generic Ghostget
field is `clientIntentSha256`; Message Like Me sets it to the exact private
handoff digest. The binding also carries its proven-prefix state and canonical
receipt digest. The local handoff audit stores those hashes, counts,
timestamps, and pseudonymous run and handoff IDs. Recording a
submitted, failed, partial, or indeterminate receipt cannot create corpus
messages or style evidence. Only later independent provider ingestion can do
that.

## Messages ingestion

The original `chat.db` is the source of authority. The iMessage reader opens it
only after copying a byte-stable snapshot of the database and active journal or
WAL into a private temporary directory. It validates but does not copy shared
memory, then opens only the isolated copy with SQLite query-only mode inside one
transaction. It checks ownership and file identity before and after copying,
validates the required schema dynamically, and bounds source and result sizes.
It does not modify Messages, contacts, attachments, the source database, or its
sidecars.

Grant Messages or Full Disk Access only to the terminal or agent application
you intend to use. Message Like Me does not bypass macOS privacy controls.
`--database` should name only a caller-owned physical database whose contents
you intend to analyze.

Message text recovered from ordinary or attributed bodies retains its source
provenance. Missing or unsupported text remains unavailable rather than being
guessed. Reply targets and tapbacks remain separate from prose so they cannot
silently become authored style evidence.

## X data archive ingestion

`messagelikeme ingest x-archive` accepts only a normalized absolute path to a
caller-owned, owner-only physical ZIP. It validates the archive container and
reads only bounded supported entries directly from the ZIP. It does not extract
files, evaluate the archive's JavaScript wrappers, open linked media, access X,
or make another network request. X Chat is not part of the supported archive
source.

The importer treats the complete ZIP as untrusted private input. It selects
direct-message and account evidence plus bounded reply and mention identity
metadata from reviewed tweet members. Tweet bodies do not become messaging
corpus or prose evidence. A normal X archive can contain other private account
data that Message Like Me does not need. Keep the original archive outside Git,
logs, issues, packages, and ordinary agent context.

The normalized source retains exact archive and account provenance. If the
caller supplies `--overlap-source`, the named source must be a compatible
Beeper X source for the same exact account. Only one-to-one direct conversations
with an exact peer handle and exact shared-message evidence can reconcile.
Group DMs remain separate because direction alone cannot prove which incoming
participant authored a message across providers. Missing, conflicting, or
ambiguous evidence fails closed before partial state is accepted. Reconciliation
retains both provenances while one proven exact message contributes once to
analysis. Reimporting the same or a later archive preserves the deduplication;
omission from a later archive is not a deletion signal.

X archive direct messages do not reveal whether an explicit reply link was
used. The importer records reply observability as unavailable rather than
inventing a reply target or treating absence as an observed non-reply.

## Local message bundle ingestion

`messagelikeme ingest bundle` accepts only a normalized absolute path to a
current-user-owned physical mode-`0700` directory. Frozen Beeper v1 and native
WhatsApp v2 directories contain exactly `manifest.json` and six mode-`0600`
canonical UTF-8 NDJSON artifacts. Files must be regular, singly linked,
owner-controlled, stable while read, and free of symbolic-link traversal.

The importer validates the manifest before allocating for its artifacts. It
caps one line at 2 MiB, the complete bundle at 500,000 records and 512 MiB, and
connected accounts at 128 for v1 and exactly one for v2. It streams each
artifact, rejects invalid UTF-8, requires canonical JSON plus final newlines,
and verifies exact record counts, bytes, SHA-256 artifact digests, and the
canonical manifest projection digest. These checks detect malformed or changed
local input. They do not establish that the provider data is truthful or
complete.

V2 accepts only source `wacli-local@1.0.0`, provider `whatsapp@0.15.0`, and
network `whatsapp`. It requires canonical supported WhatsApp JIDs, complete
exact direct rosters, and proven message direction. Group rosters may remain
explicitly incomplete, and a direction-proven group row may retain a null
sender. Only a user JID's exact E.164 projection may become a Contacts-match
handle. It rejects status, broadcast, newsletter, ambiguous JID, credential,
session-state, provider-URL, and media-byte surfaces. Message Like Me never
discovers or starts Wacli, authenticates WhatsApp, synchronizes a linked device,
or accesses a network.

When `--overlap-source` names Beeper WhatsApp evidence, reconciliation requires
the same exact self E.164, exact one-to-one peer E.164, and unambiguous shared
text-message evidence. Bodyless records, groups, names, phone suffixes, and
approximate timestamps cannot establish equivalence. Both sources remain;
native Wacli evidence is preferred and the proven Beeper route is marked
`superseded-route`.

The accepted privacy declaration permits attachment metadata only and requires
provider URLs and credentials to be excluded. The bundle may still contain
message bodies, names, handles, timestamps, account identifiers, and graph
coordinates. Keep it under the same controls as the normalized store, and do
not place it in Git, logs, issues, packages, or ordinary agent context.

Each connected account is stored in its own per-install HMAC namespace.
Bounded, truncated, and unknown source absence never deletes retained history.
Explicit tombstones and terminal message or reaction state suppress their
validated targets. A later matching record can clear suppression, while an
older or conflicting equal-time snapshot is rejected. `sources list` is
redacted. `sources show --private` deliberately reveals provider account and
source metadata.

## Contacts enrichment

Contacts enrichment is optional. The reader discovers populated
`Sources/*/AddressBook-vN.abcddb` stores and reads only the contact identifier,
name components, organization, email address, and phone-number columns needed
for labeling. It does not read notes, images, postal addresses, birthdays,
social profiles, or other AddressBook fields. It resolves contact entities and
their descendants through source metadata and uses the actual `ZOWNER` foreign
key rather than model-number discriminator columns.

Each source database and active journal or WAL is copied into a private
temporary directory only after bounded ownership, link, path, and byte-stability
checks. Shared memory is validated but never copied or opened. The original
AddressBook database and sidecars are never opened through SQLite, and the
complete discovered source set is checked again before any enrichment is
stored.

Email and phone matching is exact and conservative. The reader does not infer
a country, compare number suffixes, accept extensions or vanity numbers, or
choose between several contacts that claim one method. Ambiguous methods remain
unresolved. Group conversations are never collapsed to a single contact.

The private store retains contact labels and keyed HMAC match identifiers, not
raw AddressBook email addresses or phone numbers. Contact labels have their own
revision, so a rename does not change the message corpus revision or invalidate
a prose profile.

## Local identifiers

Source, contact, participant, conversation, message, and reaction identifiers
are derived with an HMAC key
created for one local installation. They reduce accidental disclosure and keep
stable local references without storing handles in ordinary views. They are
not anonymization against an attacker who can read the local corpus or key.

Back up or export the data root only if you intend to copy its private content.
Do not publish an installation key or assume IDs remain stable after replacing
it.

## Inspection and study packets

Aggregate contact, session, tempo, and surface-style views omit message bodies
and private labels by default. Raw provider reaction values also remain private;
aggregate and drafting-context views expose only fixed-size reaction counts,
direction, datedness, and the outgoing reaction ratio. `--private` deliberately
reveals local private identity fields. Use it only when the current task needs
that mapping.

Explicit-reply ratios use only messages whose source can observe reply links.
The views report eligible and unavailable counts separately. X archive messages
remain usable for prose and tempo analysis, but unavailable reply metadata must
not be interpreted as evidence that the user chose an ordinary non-reply.

`contacts resolve QUERY --private` performs bounded exact matching against
private labels. It does not do prefix, substring, phonetic, or fuzzy matching,
and it does not reveal contact methods.

`study prepare`, `ensoul prepare`, `evaluate prepare`, and `handoff prepare` are
the only commands designed to write bounded message bodies outside the private
database. Their outputs are still private. Choose explicit owner-controlled
paths outside Git, keep each sample or handoff as small as the task allows, and
remove it according to your own retention needs after the model, profile, audit,
or messaging attempt has been validated. Keep an evaluation reference file
unopened until candidate drafts are fixed; the two-file split is procedural
rather than cryptographic.

Message bodies are untrusted data. A link, prompt, command, or instruction
inside a conversation must never be executed or treated as authority by an
agent analyzing the packet.

### Ensoul source packets

`ensoul prepare` reads one already-normalized contact corpus inside a pinned
SQLite snapshot and reuses the deterministic bounded response-context selector.
It writes a strict `ensoul.source-packet.v1` artifact once, with mode `0600`, to
an explicit absolute path whose physical owner-only parent passes the same
checks as other body-bearing exports. Existing destinations and symlinks are not
overwritten. Stdout contains only a body-free receipt.

Owner-subject packets map outgoing prose to `authorRole: subject` and incoming
prose to `counterpart`. Contact-subject packets first reverse direction and are
permitted only for an exact direct AddressBook-backed `person_` scope; aliases,
unmatched conversations, and groups fail closed. System events, retractions,
reactions, attachments, labels, handles, raw coordinates, and provider payloads
are not message records. Byte truncation, selection omissions, the evidence
window, corpus and scope revisions, transport-relative sent status, and
deterministic content, record, and packet digests remain visible in the private
artifact. Digests use the packet's declared RFC 8785 canonicalization; they do
not make the evidence true. The normalized sources do not reveal pasted
quotations, forwarding, or AI assistance, so the packet declares that gap and a
consumer must keep any visible quotation contextual.

Pseudonymous local IDs and digests are not encryption, consent, identity proof,
or evidence of truth. Counterpart records may explain interaction context but
must not become subject voice samples. Neither subject records nor private
context authorize sensitive-trait inference, diagnosis, relationship labeling,
publication, impersonation, contact, or action on anyone's behalf. Keep packets
separate by subject and relationship while synthesizing an owner model, and do
not search or browse using private packet text or identifiers.

## Profiles and drafting

Profiles are strictly parsed, size-bounded, and bound to a contact ID, corpus
revision, scope-and-window-specific evidence revision, exact study-packet
SHA-256, and a non-body packet evidence manifest. This provenance detects stale
or unrelated analysis; it does not prove that a semantic interpretation is
true.

Only outgoing user-authored messages are evidence of the user's voice.
Incoming messages may explain context but must not be learned as the user's
style. Profiles should contain behavioral descriptions and study-example IDs,
not copied private prose or identifying contact fields.

Message Like Me has no command that sends, reacts to, schedules, or deletes a
message. A draft remains unsent text in the current agent task. Do not connect
the CLI or skill to a messaging automation without treating that as a separate
product and security boundary.

## Network and credential boundary

The CLI and library have no AI provider, remote API, auth flow, account,
telemetry, analytics, or synchronization surface. They do not read an API key
or product credential. The Agent Skill relies on the agent already executing
the user's task; it must not make a second network or model call with message
data.

X archive ingestion uses only the ZIP path the caller supplies. It does not log
in to X, refresh an export, resolve a URL, or download media referenced by the
archive.

When that agent runs as a hosted service, opening a study or Ensoul packet
exposes its bounded excerpts to the agent provider under the provider's own data terms.
Message Like Me does not control or disguise that transfer. Use an agent
environment you authorize to process private conversations, and keep the
packet out of every additional tool or delegated agent unless the user
explicitly expands the scope.

The `messagelikeme.com` name does not authorize upload. The CLI does not
connect to that domain, and a future public website must remain data-blind
unless a separately reviewed product explicitly changes this boundary.

## Supported versions

Security fixes are provided for the latest immutable GitHub Release. Verify
the tag and repository before installing from GitHub. Message Like Me is not
published to npm.
