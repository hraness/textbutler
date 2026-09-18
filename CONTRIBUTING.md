# Contributing

Issues and focused pull requests are welcome. Describe the behavior that should
change, include a minimal synthetic fixture when one helps, and keep unrelated
cleanup out of the same patch.

Install the pinned toolchain and run the complete gate:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Use Bun 1.3.14. Do not add another package manager or lockfile.

## Protect private data

Never use a real Messages database, message, handle, contact name, group title,
attachment, profile, study or Ensoul packet, private path, or installation key in a test,
snapshot, issue, commit, example, or diagnostic. Build SQLite fixtures from
synthetic conversations whose people and content never existed.

Preserve these boundaries:

- `chat.db` is opened read-only and query-only; ingestion never changes
  Messages or its source files.
- Message data remains local. Do not add networking, telemetry, analytics,
  hosted storage, AI-provider calls, authentication, or synchronization.
- There is no send, react, schedule, or messaging-application operation.
- Ordinary aggregate views omit bodies and private identities. Only explicit
  bounded study, Ensoul source, evaluation, or handoff packets write message
  bodies outside the private database.
- Incoming prose is response context, not evidence of the owner's writing
  style. A contact-subject Ensoul packet may rebase direction only for an exact
  direct AddressBook person scope and must keep owner prose as counterpart
  context.
- Local IDs remain HMAC-derived, and owned data paths remain physical and
  private.

## Tests and contracts

Pair parser, schema, SQL, path, and CLI changes with deterministic examples.
Add property tests for laws such as chronological ordering, session and burst
partitioning, aggregate conservation, reply linkage, canonical JSON, stable
HMAC identity, and idempotent re-ingestion where appropriate. Promote a shrunk
property failure into a named regression.

Keep `--json` stdout machine-readable and send diagnostics to stderr. Bound
database reads, message counts, text bytes, lists, study examples, and profile
fields before expensive work or publication. Parse foreign values from
`unknown` and reject unsupported schema changes instead of guessing.

Product-specific skill changes belong under `skills/message-like-me/`; the
copied standalone Ensoul skill lives under `skills/ensoul/` and must remain a
complete attributed vendored copy rather than a dependency. Keep each
`SKILL.md` focused on routing and shared boundaries, put substantial
mode-specific instructions in linked references, and keep each
`agents/openai.yaml` consistent with its skill. The installer must publish both
skills without leaving a partial pair. Run the complete gate after changing
packaged skill files.

The packed consumer must work from the standalone public repository without a
sibling checkout, private package, ambient Messages database, or network
access.

## Informational-site browser check

Check the site with `bun run --cwd site check`. Set
`TEXTBUTLER_BROWSER_EXECUTABLE` to an installed Chromium executable and
`TEXTBUTLER_NODE_EXECUTABLE` to an installed Node 24 executable, using absolute
paths, then run `bun run --cwd site check:browser` on the committed candidate.
Use the exclusive browser lane when a host or repository scheduler is present.
The verifier makes its own sterile production build in that same invocation and
joins the clean Git source and lockfile before and after compilation and teardown.

The 16 cases cover the editorial landing, documentation, legacy source catalog,
and frame-safe preview in both system appearances at desktop and touch widths.
They check actual rendered fonts, compiled stylesheet layers, Paper and preset
roles, responsive geometry, keyboard disclosures, document links, and collection
boundaries. Screenshots, the exact Git/build/browser receipt, and an isolated
browser profile remain in ignored `site/.browser-artifacts/` for review.

This check starts and stops its own loopback server and fresh browser. It blocks
external requests, uses no personal browser profile or inherited credentials,
and never launches a messaging reader, desktop app, agent, account check, or data
entry workflow. The README's exact external skills.sh badge image is replaced
with a labeled repository SVG fixture and recorded in the receipt; the external
badge service is not verified. All other request failures remain fatal. This is
not live provider or production-delivery verification. The script-free preview
must expose its restrictive CSP and block its framework scripts and manifest;
only those exact policy blocks are recorded separately from unexpected failures.
Every case settles requests, joins context teardown and route handlers, then
checks late failures before accepting evidence. Unexpected server exits fail.

By contributing, you agree that your contribution is licensed under the MIT
License.

## Command runtime changes

Read [the command runtime and private-publication contract](docs/command-runtime.md)
before changing command services, scope ownership, or receipt recovery. Run
`bun run check:effect` when editing a governed Effect module or its policy, and
retain the complete `bun run check` gate. Changes to the architecture checker,
its policy, or a public protocol graph require independent review. Expected
failures must stay explicit; adapters do not grant network or messaging authority.
