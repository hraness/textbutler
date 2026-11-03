# Retirement status

TextButler is retired. This status supersedes the redesign authorization below
and the unattended setup, installation, daemon/app activation, maintenance,
deployment, and release instructions in this repository. Those instructions are
historical; they do not authorize new installations, service activation,
messaging, or publication.

Work is limited to the owner's retirement request and preservation or recovery
work explicitly put in scope. Validation and protected delivery requirements
still apply to those changes.

Preserve private local work, message and Contacts sources and their sidecars,
local identities and keys, journals, reservations, unresolved send intents,
custody records, and upgrade rollback copies. Keep frozen public contracts,
exports, dependency pins, releases, tags, and assets intact. Retirement does not
authorize deleting or resetting user data, shared accounts, or credentials.

<!-- browser-automation:start -->
- Ordinary owned automated browser runs use versioned Chrome for Testing or the browser provisioned for the pinned Playwright version. Reject the installed auto-updating Chrome application, including explicit executable overrides and symlinks; never fall back to it when provisioning is missing. Report the resolved executable and browser version, and close owned contexts and browsers gracefully in cleanup. Attaching to an explicitly authorized user-owned browser is a separate operation: preserve its profile and lifetime. Keep regression checks for browser selection in the existing required checks; see [browser automation](https://github.com/hraness/.github/blob/main/BROWSER_AUTOMATION.md).
- Never start the system Chrome app directly from an agent shell; use the repository's browser tooling and respect its scheduler and browser custody controls. For owned launches, pass `--mute-audio` and merge `PaintHolding,MacAppCodeSignClone` into any existing `--disable-features` value instead of adding a second switch. Finish owned process, context, and profile cleanup before releasing the browser lane. Never signal another holder or manipulate its lease to obtain a slot.
- The sole native-runtime exception is Slopcamera’s documented signature-verified, version-bound, immutable task-owned Chrome snapshot, never a direct launch of the installed application. Its current integrity-bound launch contract must disable `MacAppCodeSignClone`; retain vendor identity verification, browser custody, graceful cleanup, and regression checks. Qualify the native fix with live clone-growth and cleanup evidence before activating this exception. It is not an executable override or fallback for ordinary automation; see [the native-runtime exception](https://github.com/hraness/.github/blob/main/BROWSER_AUTOMATION.md#slopcamera-native-runtime-exception).
<!-- browser-automation:end -->

# Historical Textbutler redesign scope

The authorization below records previous work. The retirement status above
governs current work.

The owner has authorized replacing the unused Message Like Me product with
Textbutler, a headless macOS message-butler daemon at `textbutler.app`.
`PRODUCT.md` and `docs/textbutler/architecture.md` define the new product.
The historical constraints below continue to govern the legacy `src/`, `dist/`,
published message contracts, and their existing release machinery. They do not
prohibit the explicitly requested new runtime in `packages/`. The owner removed
the menu bar companion: Textbutler is controlled through its CLI and guided
terminal only. Every command follows the shared desktop-foundation grammar
(`packages/textbutler/src/grammar.ts`): `--json` prints the shared envelope,
`commands --json` lists each verb's class, and `decide` verbs (approvals
decide, permissions set loosen, control install/uninstall and their older
daemon install/uninstall names) need the person in their own terminal. Keep `docs/textbutler/cli-parity.md` in step with the
registry. The owner also authorized a minimal native TextButler.app
supervisor so macOS can grant Messages access to TextButler itself. Its fixed
roles launch only the verified runtime's daemon or owner-invoked iMessage setup;
opening the app itself starts nothing. Preserve exact
payload and lifecycle identity checks. Public Developer ID signing and
notarization remain outside this local installation scope.

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
  existing required aggregate.
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
- `STYLE.md` and `WRITING.md` – the public prose and internal writing guides,
  synced from hraness/.github.
- `package.json`, `tsconfig.json`, and `bun.lock` – Bun package, build, and
  verification configuration.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change. Do not add
  another package manager or lockfile.
- Public material never references or links Message Like Me, its package, its
  `messagelikeme` command, or `messagelikeme.com`; that prototype is retired.
  Public material is the site (pages, metadata, structured data, `llms.txt`,
  sitemap, blog), README.md, CONTRIBUTING.md, SECURITY.md, and
  `docs/textbutler/`. Take TextButler's description from the portfolio registry
  and its status from `SITE_STATUS` in `site/app/_lib/site.ts`. The frozen
  package description in `package.json` stays exact until a reviewed identity
  migration: “A local-first CLI and Agent Skill for studying private messaging
  history and drafting messages that sound like you.”
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
  runbook. Treat `textbutler.app` as an informational project page, never as
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
- Follow `docs/publishing.md` for the stable release procedure. Treat an
  immutable annotated stable `v*` tag matching every checked version
  identity at a reviewed commit in current `main` history as a
  release request. Publish only after the complete root, site, packed-consumer,
  synthetic macOS gate, and exact-tarball macOS/Linux gates pass. Build the
  package once, publish the immutable Latest GitHub Release with that tarball
  plus `SHA256SUMS` first, then publish the same tarball through npm trusted
  publishing. Keep the tag workflow's write scope split: only the
  GitHub publication job gets `contents: write`, only the npm publication job
  gets `id-token: write`, and a separate read-only job admits exact bytes and
  provenance. Treat every SHA-pinned setup and artifact action in those jobs as
  part of the privileged release TCB. Keep the GitHub token scoped to the
  dependency-free publisher step. A later positive attempt
  may finish the same exact tag, commit, and tarball only when Sigstore binds
  the actual run ID and an allowed positive attempt.
- Vercel's production branch is `main` like every other Hraness site: the
  GitHub integration deploys `main` to production automatically and pull
  requests produce previews. There is no separate promotion ref, writer
  workflow, canary, or status-authority step, and no manual deploy or dispatch
  in the routine path.

<!-- hraness-public-copy:start -->
- Public copy (websites, READMEs, docs, package and GitHub descriptions, CLI help, `llms.txt`, generated pages) follows `STYLE.md`, synced from hraness/.github. Text a model writes for publication also follows `GENERATION_STYLE.md`.
- The delivery vocabulary in this file (admission, qualification, custody, receipt, bounded, lane, gate, surface, projection) is internal. Translate it into what the reader gets.
- Take one-line product and sibling descriptions from the portfolio registry and versions from the release record. Tests pin facts, not prose.
- Run `bun run check:copy` before handoff when the repository has it.
<!-- hraness-public-copy:end -->

<!-- hraness-releases:start -->
- GitHub Release pages follow `RELEASES.md` in hraness/.github: the title is the registry product name and the tag, and the body is a summary, `## Changes`, `## Install`, `## Verify`, then the repository's identity record as a trailing HTML comment.
- The summary and changes come from the version's section of `CHANGELOG.md` in the tagged commit. Write that section in the version bump pull request. The release workflow copies it, generates Install and Verify from the release record, fails when the section is missing or empty, and never uses GitHub's generated notes.
<!-- hraness-releases:end -->

<!-- hraness-articles:start -->
- Essays and blog posts follow the essay addendum in `GENERATION_STYLE.md` and `ARTICLE_COPY.md` in `@hraness/design-kit`. The byline is “Hraness”, every post shows the provenance note naming its recorded reviewer, and no AI-drafted post is credited to a person unless that person rewrites and adopts it.
- Take product names, one-line descriptions, addresses, status labels, and relations from the portfolio facts in `@hraness/design-kit`. Render versions from the release record (`package.json`, a published-release file), never typed by hand.
- Write a “How X uses Y” post only for a registered relation that has a description. Change the relation and its post in the same change. Link between products only along registered relations, and between a technique post and product posts about the same technique.
- Every post has a review record: reader job, non-obvious answer, sources with the date checked, owner, reviewer identity, reviewer type (`ai` or `human`), a score out of 12, and a `reassessOn` date 28 to 56 days after review. The reviewer is independent of the run or person that drafted the post. An AI reviewer is recorded and shown as AI; `humanReview` stays null unless a person reviewed the post.
- A new post starts out of search indexes, sitemaps, and feeds. It becomes indexable only when its review record is complete, scores at least 9 of 12 with no zero score, and the page shows the provenance note.
- When a product is renamed or a relation changes, update the post bodies that mention it in the same change.
<!-- hraness-articles:end -->

<!-- hraness-launch:start -->
- Launch posts, their social posts, product mockups, and launch films follow the launch beats and social posts addendum in `GENERATION_STYLE.md` and the beats shape under “Introducing a product” in `ARTICLE_COPY.md` in `@hraness/design-kit`. Channel limits are in the launch posts section of `MESSAGING.md`.
- Build them with the `product-launch` agent skill, the `./mockups` and `./launch` exports of `@hraness/design-kit`, and `slopcamera html init --template launch-film`.
- Take every number in a beat, social post, film caption, or store listing from the product's launch facts module, and the status from the release record. Keep mockup accessible descriptions accurate; visible captions are optional and must add useful context.
- The social kit emits posts for X, Bluesky, Threads, and LinkedIn, and a fact sheet for the Show HN post and the Product Hunt first comment. A person writes those two.
<!-- hraness-launch:end -->

<!-- hraness-delivery:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the gates applicable to that action pass. Do not ask for duplicate confirmation. Build confidence through relevant automated checks, bounded diagnostics, and independent review, not another human approval. Passing checks does not expand task scope or authority.
- Prefer agentic service provisioning for new infrastructure. Check Vercel Marketplace for a native product that can provision the required resource first; use Stripe Projects as a supported alternative when it better covers the service or the Marketplace route only connects an existing account. Verify the current catalog, account, region, plan, recurring cost and resource capabilities before selecting a route. Prefer supported provider CLIs or APIs over browser-only setup when neither catalog fits, and explain the concrete exception. Reuse existing owner-controlled resources where appropriate; this preference alone does not authorize migrations, duplicate accounts, paid upgrades or wider access. Continue setup already authorized by the task and budget without duplicate confirmation. Keep provider credentials and generated environment files private, complete required interactive authentication, and verify deployment, persistence and recovery separately from successful provisioning.
- Separate artifact admission from live qualification and operational activation. Use applicable automated source, security, package/install, and provenance evidence for artifact admission; live provider qualification is not a universal publication prerequisite. Preserve explicit live acceptance criteria and require relevant live evidence for claims that depend on it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation.
- Use the repository's documented delivery workflow and preserve the identity, target, capacity, migration, and recovery guards applicable to operational activation. Replace an obsolete gate through a reviewed source and policy change with corresponding tests, never an ad hoc skip. Preserve every runtime-enforced approval, access control, branch protection, environment rule, safety policy, and required final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, unavoidable interactive authentication, an irreversibly destructive action outside task scope, or resolution of a failure that cannot be handled safely and autonomously.
- Preserve production and user data throughout delivery. Inspect the exact account, environment, deployment, and data target before writes. For data changes, inspect a dry run or equivalent migration plan and validate the recovery path before any effect that could lose or corrupt data. Prefer additive, backward-compatible migrations and bounded batches. Record mutation intent, use idempotency or conditional writes, and reconcile uncertain results before retrying. Verify deployed identity, health, and relevant data invariants after delivery. Routine delivery never authorizes resetting, truncating, dropping, or overwriting user data; stop the unsafe operation if preservation or recovery cannot be established.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Use unattended stable publication and production promotion when supported by the provider and repository. Establish supported machine authority once and verify it with a non-publishing preflight where available; routine releases should not require recurring interactive authentication or conversational approval. Releases and deployments run without a human in the loop: do not add required reviewers, manual approval environments, or wait timers to release or deployment paths, and remove any you find through a reviewed change. Keep account two-factor authentication, and do not add long-lived personal tokens.
- Main delivery is unattended. Open the pull request and enable auto-merge in the same breath (`gh pr merge --auto --squash <number>`), then move on; the required `Required` check is the reviewer. Until a repository's ruleset requires a check, `--auto` merges immediately, so wait for green checks there before merging. Never request a human reviewer or add required approvals, code owners, required conversation resolution, merge queues, manual-approval environments, or wait timers, and remove any you find with `scripts/apply-delivery-policy.py` from hraness/.github rather than by hand. Required checks run on the pull request head and are not re-required after main moves, so auto-merge never stalls behind another merge; main reruns the same gate after integration, and a red main is fixed forward by the next change. Repositories without CI use direct pushes to main.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- hraness-delivery:end -->

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
- At session start, if the `algal` skill is unavailable, install the current skill pack for Claude Code, Codex, and Devin for Terminal with `bunx skills add 0thernet/algal-skills --global --agent claude-code codex devin --skill '*' --copy --yes`.
- Confirm installation with `bunx skills list --global`. If Bun or network access is unavailable, continue with repository-native tools instead of blocking delivery.
- Treat ALGAL receipts as execution evidence, not provider attestation, and preserve the repository's normal verification and release gates.
<!-- algal-skills:end -->
