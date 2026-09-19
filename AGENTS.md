# Textbutler redesign scope

The owner has authorized replacing the unused Message Like Me product with
Textbutler, a macOS message-butler daemon and menu companion at `textbutler.app`.
`PRODUCT.md` and `docs/textbutler/architecture.md` define the new product.
The historical constraints below continue to govern the legacy `src/`, `dist/`,
published message contracts, and their existing release machinery. They do not
prohibit the explicitly requested new runtime in `packages/` and the menu
companion adapter that drives the shared desktop-foundation runner. Desktop
apps, signing, and notarization are outside the current product scope.

- New agents receive only one contact's brokered files, bounded public web
  requests, and recipient-bound proposed messaging actions. Never enable shell,
  arbitrary process tools, inherited plugins, or extra filesystem roots.
- The exact Textbutler provider SDKs may be development dependencies of the
  source checkout. Preserve the legacy public runtime's dependency/import
  restrictions and packed export boundary; it never loads those SDKs.
- Keep owner settings, credentials, route bindings, and executable plugins
  outside model-writable contact workspaces. Preserve user data and frozen wire
  identities throughout migration.
- Apply disclosure in trusted code, check human takeover immediately before
  dispatch, and journal send intent. Never retry an indeterminate send.
- Unqualified provider restrictions and unsupported transport operations must
  remain unavailable. Synthetic tests do not prove live delivery or sandboxing.
- Run `bun run check:textbutler` for the new source packages as well as the
  existing required aggregate. Native menu-companion builds are gated by the
  shared desktop-foundation release, not this repository.
- Repository/package rename and website deployment must use a reviewed identity
  migration that preserves the existing release and production protections.
- Informational site changes may use the explicit site-source promotion path in
  `docs/publishing.md`, independently of legacy npm/package publication. That
  path still requires exact current-main CI and site-build admission, reviewed
  workflow changes, protected conditional ref writes, status-authority cleanup,
  and verified provider readback. The legacy release path retains its gates.
- Preserve any existing required environment review. Complete the exact run's
  review through the normal provider interface; this redesign does not authorize
  removing runtime-enforced reviewers or other protection settings.

# Contents

- `src/` – the deterministic local iMessage, X archive, Contacts, and private
  Beeper and native WhatsApp source-bundle readers, normalized corpus and
  metrics, private SQLite store, profile parser, Agent Skill installer, and
  `messagelikeme` CLI.
- `schema/` – public versioned JSON Schemas for deterministic artifacts and
  agent-authored profiles.
- `docs/` – public methodology, evidence limits, research review, prior-art
  comparisons, and the release-bound publication runbook.
- `skills/message-like-me/` – the canonical Message Like Me Agent Skill and its
  progressive analysis, drafting, privacy, and profile references.
- `.agents/skills/` – portable plan authoring, phased execution, implementation,
  and independent review workflows.
- `site/` – the informational public project page; it has no private-data or
  product-runtime connection.
- `scripts/` – skill, standalone-boundary, built-output, and packed-consumer
  verification.
- `dist/` – committed Bun-targeted JavaScript used by immutable GitHub installs.
- `.github/workflows/` – read-only CI, checks-gated immutable tag releases,
  and the separately admitted production-ref writer.
- `README.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, and `LICENSE` –
  standalone public documentation, release history, policy, and terms.
- `STYLE.md` – the public and reader-facing prose contract.
- `package.json`, `tsconfig.json`, and `bun.lock` – Bun package, build, and
  verification configuration.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change. Do not add
  another package manager or lockfile.
- Keep the public description exact: “A local-first CLI and Agent Skill for
  studying private messaging history and drafting messages that sound like
  you.”
- Follow `STYLE.md` for public site, documentation, README, release, and
  Agent Skill prose.
- Follow the shared [Hraness README guidelines](https://github.com/hraness/.github/blob/main/README_GUIDELINES.md).
  Keep the durable definition, mechanism-backed rationale, shortest verified
  first task, observable behavior, boundaries, verification, and task-oriented
  documentation path current.
- Keep the public repository independently buildable. Do not reference another
  source repository, private packages, sibling paths, private fixtures, or
  publication mechanics.
- Keep `chat.db` authoritative and ingestion read-only, query-only,
  ownership-checked, schema-validated, and bounded. Never modify Messages,
  contacts, attachments, or SQLite sidecars.
- Treat an X data archive as an untrusted, private, owner-controlled ZIP. Parse
  bounded supported entries in memory without extracting files, evaluating
  JavaScript, accessing a network, or downloading media. Preserve exact archive
  provenance and reject ambiguous account or cross-source overlap claims.
- Treat a `message-like-me.local-message-bundle` as an untrusted, private,
  versioned directory boundary. Require its fixed inventory, canonical UTF-8,
  owner-only modes, bounded records, artifact digests, and manifest digest.
  Never let bundle absence erase retained history unless a future contract
  explicitly declares authoritative coverage; apply explicit deletions and
  tombstones separately.
- Preserve local message bundle v1 as the frozen Beeper contract. Treat bundle
  v2 as the exact one-account Ghostget/Wacli WhatsApp seam: source
  `wacli-local@1.0.0`, provider `whatsapp@0.15.0`, network `whatsapp`, canonical
  supported JIDs, and E.164 handles only when the JID proves them. Never add
  Wacli process, authentication, synchronization, network, or send code to
  Message Like Me.
- Treat AddressBook databases as optional label-enrichment sources. Isolate
  every database plus WAL or journal before SQLite opens it, validate contact
  entities and property owners dynamically, read only names and exact
  email/phone handles, and never modify Contacts or its sidecars.
- Keep the normalized corpus, installation key, study packets, profiles, and
  drafting context local in owned physical paths with private permissions.
  Reject symlinks and foreign-owned sensitive files.
- Derive stable local identifiers with the per-install HMAC key. Ordinary
  aggregate views omit bodies, handles, contact names, and group titles. Only
  `study prepare`, `ensoul prepare`, `evaluate prepare`, and `handoff prepare`
  may write bounded body-bearing artifacts outside the private database, and
  they write mode `0600` to explicit paths.
- Count only outgoing user-authored messages as owner-style evidence. Incoming
  messages supply response context. A contact-subject Ensoul packet is the
  narrow exception: require an exact direct AddressBook `person_` scope, rebase
  direction before selection, and mark owner prose as counterpart context.
  Preserve body provenance, explicit reply targets, and tapbacks as distinct
  data.
- Keep the CLI and library free of network access, AI-provider calls,
  authentication, accounts, telemetry, analytics, synchronization, and message
  sending. The installed Agent Skill supplies semantic analysis and unsent
  drafting through the agent already running it.
- Keep the command name `messagelikeme`, the package name
  `message-like-me`, and the Agent Skill name `message-like-me`. The canonical
  GitHub repository is `hraness/textbutler` with unchanged numeric ID
  `1342143606`; follow the version-neutral identity migration in the publishing
  runbook. Treat `messagelikeme.com` as an informational project page, never as
  a data plane.
- Keep CLI commands namespaced as `ingest imessage|x-archive|contacts|bundle`,
  `sources list|show`,
  `contacts list|show|resolve`,
  `inspect tempo|sessions`, `study prepare`, `ensoul prepare`,
  `profile apply|show|export`,
  `routes list`, `handoff prepare|verify|record`, `handoffs show`, plus `init`,
  `context`, `skill`, and `doctor`. Machine-readable commands support stable
  JSON stdout; diagnostics use stderr and typed exit codes.
- Parse every foreign value from `unknown`. Bound paths, source bytes, message
  counts, text bytes, lists, study examples, and profile fields before work
  escapes the boundary. Keep canonical timestamps and deterministic ordering.
- Version corpus, metrics, study-packet, and profile schemas explicitly.
  Preserve exact corpus-revision and packet-SHA provenance so stale profiles
  fail visibly.
- Keep `ensoul.source-packet.v1` and the stricter
  `ensoul.messages-source.v1` payload explicit. Record and packet identities,
  RFC 8785 content, record, and packet digests, subject-relative authorship,
  content role, source-owner transport status, revisions, bounds, omissions,
  and limitations must remain deterministic and body-bearing packets must never
  appear on stdout.
- Use synthetic public fixtures only. Add focused examples for parser, SQL,
  path, CLI, and privacy boundaries, plus property tests for ordering,
  partitioning, conservation, identity, canonicalization, and round trips.
- Keep `skills/message-like-me/SKILL.md` and the copied `skills/ensoul/SKILL.md`
  concise and route conditional detail to their linked references. The copied
  Ensoul skill is vendored source, never a runtime dependency. Preflight and
  install both complete skills for Codex, Claude, and generic Agent Skill
  targets at user or project scope without leaving a partial pair.
- Follow `docs/publishing.md` for the one-time production controls, stable
  release, and reviewed-`main` recovery procedure. Treat an immutable annotated
  stable `v*` tag matching every checked version
  identity at a reviewed commit in current `main` history as a
  release request. Publish only after the complete root, site, packed-consumer,
  synthetic macOS gate, and exact-tarball macOS/Linux gates pass. Build the
  package once, publish the immutable Latest GitHub Release with that tarball
  plus `SHA256SUMS` first, then publish the same tarball through npm trusted
  publishing before the separate current-`main` promotion workflow
  fast-forwards the established `website-production` ref with an exact
  expected-old lease. Keep the tag workflow's write scope split: only the
  GitHub publication job gets `contents: write`, only the npm publication job
  gets `id-token: write`, and a separate read-only job admits exact bytes and
  provenance. Treat every SHA-pinned setup and artifact action in those jobs as
  part of the privileged release TCB. Keep the GitHub token scoped to the
  dependency-free publisher step. Keep the dedicated status-signing App's
  private key inside the main-only `production-ref-writer-key` environment and
  expose it only to a fresh dependency-free, hash-pinned promotion job. Keep
  that environment free of required reviewers, wait timers, and custom
  deployment-protection rules, with administrator bypass disabled. Routine
  promotion proceeds through the existing machine gates without a human
  confirmation. Independent agent review of workflow-control transitions
  precedes their exact digest dispatch. Refresh the complete administrative
  controls census at setup, control-configuration or workflow-authority
  changes, and drift or interrupted-authority recovery. Routine releases rely
  on the existing per-run source, artifact, App, rules, denial, lease, and
  provider gates. Before environment admission, and
  again in that job before reading the key, require
  complete non-shallow history. The complete range must either preserve the
  baseline `.github/workflows` tree OID with no digest, or match the exact
  independently reviewed v2 control-epoch receipt and digest for every ordered
  commit and workflow-tree transition.
  Mint only the numeric one-repository `statuses:write` plus `metadata:read`
  App token. Require that App to be the pinned source of one exact-SHA success
  status, prove its readback, and revoke that token. Let only the same job's
  scoped `GITHUB_TOKEN` first prove denial while the exact App context is
  terminal `error`; accept only GitHub's singular exact GH013 violation payload
  for the protected ref plus the singular exact `remote: -` reason for the
  context ending `is errored.`. Before exact comparison, normalize only one
  consistent known Git non-TTY display suffix: zero, one, or eight ASCII
  spaces on both semantic remote lines. Reject every other trailing byte,
  suffix length, or mixed framing. Treat mutable Git progress, transport ordering,
  and helper-label framing as diagnostics rather than proof; the fixed Git
  executable, remote, arguments, and refspec bind the operation. Never accept
  the contradictory `is expected` or a missing-status interpretation. Then
  let that same job's scoped `GITHUB_TOKEN` perform the leased ref move, then
  mint a separate
  status-only token to replace the success with a proven terminal non-success
  status before revoking the second token. The status App must have neither `contents:write` nor
  `workflows:write`, and it must not be a ref-ruleset bypass actor. A reviewed
  workflow-control epoch requires the transition-scoped v2 digest protocol in
  the runbook: one no-digest run must fail before key admission while publishing
  the complete ordered commit and workflow-tree inventory, and one fresh manual
  attempt-1 dispatch may carry only the independently reviewed exact digest.
  Recompute that inventory before environment admission and again before
  reading the key. Never expand the status App, mint a temporary broad
  credential, or move the ref out of band. Require the bounded read-only
  provider outcome gate to finish.
  Already-exact recovery must not enter the key environment. Recovery may
  revalidate only an existing immutable, artifact-complete Latest Release and
  exact npm version and must never create either one. It may accept the
  exact-SHA Production deployment that an earlier consumed site-route authority
  created on that commit, never one that predates that authority's admitted
  success. A later positive attempt
  may finish the same exact tag, commit, and tarball only when Sigstore binds
  the actual run ID and an allowed positive attempt. Keep Vercel Production
  Branch on `website-production`; `main` and pull requests are preview sources.
  If a runner interruption may leave a success status, disable both routine
  promotion workflows and use only the target-bound terminal-authority cleanup
  in the publishing runbook after its 36-day complete attempt inventory and
  65-minute token-expiry quarantine. A hard cancellation can prevent token
  revocation and receipt persistence, so absent evidence starts a fresh
  quarantine rather than authorizing a retry. Cleanup may append only a distinct
  App-authored terminal `error`; it never moves a ref or creates restart
  authority. Require owner-admin before/after proof of empty ruleset bypasses,
  and treat every incomplete cleanup receipt as continued quarantine.

<!-- oompa-local-efficiency:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the gates applicable to that action pass. Do not ask for duplicate confirmation. Build confidence through relevant automated checks, bounded diagnostics, and independent review, not another human approval. Passing checks does not expand task scope or authority.
- Prefer agentic service provisioning for new infrastructure. Check Vercel Marketplace for a native product that can provision the required resource first; use Stripe Projects as a supported alternative when it better covers the service or the Marketplace route only connects an existing account. Verify the current catalog, account, region, plan, recurring cost and resource capabilities before selecting a route. Prefer supported provider CLIs or APIs over browser-only setup when neither catalog fits, and explain the concrete exception. Reuse existing owner-controlled resources where appropriate; this preference alone does not authorize migrations, duplicate accounts, paid upgrades or wider access. Continue setup already authorized by the task and budget without duplicate confirmation. Keep provider credentials and generated environment files private, complete required interactive authentication, and verify deployment, persistence and recovery separately from successful provisioning.
- Separate artifact admission from live qualification and operational activation. Use applicable automated source, security, package/install, and provenance evidence for artifact admission; live provider qualification is not a universal publication prerequisite. Preserve explicit live acceptance criteria and require relevant live evidence for claims that depend on it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation.
- Use the repository's documented delivery workflow and preserve the identity, target, capacity, migration, and recovery guards applicable to operational activation. Replace an obsolete gate through a reviewed source and policy change with corresponding tests, never an ad hoc skip. Preserve every runtime-enforced approval, access control, branch protection, environment rule, safety policy, and required final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, unavoidable interactive authentication, an irreversibly destructive action outside task scope, or resolution of a failure that cannot be handled safely and autonomously.
- Preserve production and user data throughout delivery. Inspect the exact account, environment, deployment, and data target before writes. For data changes, inspect a dry run or equivalent migration plan and validate the recovery path before any effect that could lose or corrupt data. Prefer additive, backward-compatible migrations and bounded batches. Record mutation intent, use idempotency or conditional writes, and reconcile uncertain results before retrying. Verify deployed identity, health, and relevant data invariants after delivery. Routine delivery never authorizes resetting, truncating, dropping, or overwriting user data; stop the unsafe operation if preservation or recovery cannot be established.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Use unattended stable publication and production promotion when supported by the provider and repository. Establish supported machine authority once and verify it with a non-publishing preflight where available; routine releases should not require recurring interactive authentication or conversational approval. Retain account two-factor authentication and provider controls, including required authentication for approval of an exact staged artifact; do not add long-lived personal tokens to eliminate an interactive prompt.
- Keep delivery gates proportional to the failure they prevent. Prefer required checks on the current integration candidate, independent agent review, and atomic or conditional integration. Add a merge queue or another approval stage only for a demonstrated coordination or safety need. Replace redundant queues, serial waits, and duplicate checks through reviewed policy changes while retaining evidence for the integrated result.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$oompa-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- oompa-local-efficiency:end -->

## Command Effect ownership

- Follow [docs/command-runtime.md](docs/command-runtime.md). Keep `runCommand` as
  the sole Promise runner and use the declared `CommandPlatform` and
  `CommandArtifacts` services for native operations and scoped ownership.
- Keep SQLite callbacks synchronous and retain exact private-path, digest,
  revision, profile, and handoff laws. Do not infer receipt rollback from an
  exception or delete a publication whose custody is unproven.
- Pin the approved Effect build dependency; bundle it into the CLI while keeping
  all five public JavaScript and declaration graphs independent of Effect.
- Preserve `check:effect`, `check:public-graphs`, and every existing full gate.
  Review policy and checker changes independently; do not weaken enforcement to
  silence a new implementation failure.

- `costs.json` at the repository root is the checked registry of every product data surface: store, kind (`authoritative` | `derived` | `telemetry` | `served`), retention class (`ephemeral` | `ttl:<ISO-8601>` | `account` | `tombstone` | `persistent`), owner module, and budget. A new table, bucket, stream, dynamic route, blob, or provider meter fails `check:cost-surfaces` until it registers.
- Bound every input before storage or provider I/O: request bytes, row counts, page sizes, batch sizes, retry counts, and event payloads. Unbounded input is a contract violation.
- No writes on read paths. Reads may cache; they never mutate.
- Derived state is rebuildable and lives in the cheapest tier that can serve it. Only authoritative state pays for transactional storage.
- Every mutation carries an idempotency key; a retried write never double-charges storage, quota, or provider spend.
- Analytics and metering events come from a checked allowlist with a byte ceiling per event.
- Content bytes live in the content store; the control plane keeps references and metadata only.
- Run `bun run check:cost-surfaces` before handoff whenever a data surface changes.

<!-- algal-skills:start -->
## ALGAL skills

- Prefer the globally installed `algal-*` skills for bounded git state, diffs, repository survey/search, test and release gates, CI polling, and web fetches instead of repeated raw tool output.
- At session start, if the `algal` skill is unavailable, install all eight skills for Claude Code, Codex, and Devin for Terminal with `bunx skills add 0thernet/algal-skills --global --agent claude-code codex devin --skill '*' --copy --yes`.
- Confirm installation with `bunx skills list --global`. If Bun or network access is unavailable, continue with repository-native tools instead of blocking delivery.
- Treat ALGAL receipts as execution evidence, not provider attestation, and preserve the repository's normal verification and release gates.
<!-- algal-skills:end -->
