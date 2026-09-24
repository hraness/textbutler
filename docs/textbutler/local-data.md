# Local data

Textbutler keeps settings, contact memory, reply journals and setup records in
`~/Library/Application Support/Textbutler`, unless you select another data
directory. These files are private to the Mac user. xcb and Ghostget keep their
own accounts and credentials in their separately configured state directories.

Explicit CLI media imports live in the selected contact's private `outbox`.
Each file is limited to 16 MiB and shares the contact workspace's 500-file
budget. Repeating an import of the same bytes and extension reuses its content
identity. Imports remain after a draft expires so the owner can review or reuse
them. A complete installation data erasure removes these copies without
changing their original source files.

iMessage setup retains one small account binding so a repeated setup cannot
silently authorize a different account under the same name. Failed attempts do
not replace that binding. Setup results contain bounded progress and digests;
they contain no message bodies or credentials.

An app upgrade retains the previous signed app and its receipt under
`~/Applications/.textbutler-app-upgrades`. Up to 32 transitions are retained.
A pending transition also keeps `state/macos-app-upgrade.json` in the data
directory until completion or rollback is proven. Keep both locations intact
while an upgrade is unresolved.

When habitats are enabled, the run journal additionally keeps per-contact
habitat state (personality and tool configuration, owner-authored soul anchors,
learned excerpts, reply episodes, observed follow-up windows, evaluation records
and rollback history). A reply episode can include up to two tool queries and
results shortened to 4 KiB each, plus the kinds of actions submitted. Learned
memory holds up to 64 source-backed 1 KiB excerpts under a 96 KiB encoded archive
limit, with categories, source message IDs, authors, dates, source digests and
truncation flags. Digests cover the bounded canonical observations used by
learning. Episodes retain at most eight 512-byte excerpts shown while composing
the final reply, plus up to 24 IDs and digests for excerpts exposed only by tool
steps. Clearing learned memory removes the active excerpts and prevents older
observations from restoring them; retained episodes, inference records and
`MEMORY.md` are separate records. JavaScript tool evidence stores a code digest,
not executable source, and a bounded result.
Habitat state is limited to 512 KiB per
contact. The journal keeps the latest 32 replayable inference records per
contact and a global daily table of API
usage reservations with their provider-cost settlements. Gateway and other
provider credentials live under `state/provider-credentials` with owner-only
permissions; they never enter contact workspaces or journal evidence.

The explicit legacy iMessage crash reconciliation script accepts a private
witness for the Ghostget 0.18.16 startup failure. It checks the original crash,
app, connector, account and process state, then archives a bounded settlement
record before releasing that attempt's setup marker. It never retries setup or
changes accounts, permissions or messages. It refuses other failure types.

## Remove Textbutler data

Use `textbutler daemon uninstall` and stop the menu companion before removing
local data. Confirm that Textbutler and its connector operations have stopped.
If an operation has an uncertain outcome, reconcile it and retain the evidence
needed to settle that operation first.

To erase an installation, the owner can then delete its complete Textbutler
data directory. This removes settings, contact memory, journals, setup results
and the iMessage account binding. It does not delete Messages history, Ghostget
or xcb accounts, or macOS permission grants. Removing individual binding or
custody records is not a supported way to replace an account or retry a failed
operation. Reinstalling the command and uninstalling the background service
both preserve data by default.

After all app transitions are settled and the installation has stopped, the
owner may also delete retained app upgrade directories when their rollback
copies are no longer needed. These directories contain app artifacts and
upgrade receipts; they do not contain message history or provider credentials.
