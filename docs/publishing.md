# Publish Message Like Me

## Textbutler informational-site delivery

The following explicit site-subject route supersedes the package-publication
prerequisite below for the informational Textbutler website only. It grants no
package publication, native app release, provider qualification, or live message
authority. The legacy tagged package route and its exact-byte/npm checks remain
unchanged. Source repository identity is the canonical `hraness/textbutler`
with unchanged numeric repository ID `1342143606`.

Use the existing `Promote website production` workflow with `site_sha` set to
the exact reviewed current `main` commit, `site_ci_run_id` and
`site_ci_run_attempt` set to its successful `CI` run, and `release_tag` empty.
Do not rerun a promotion attempt; make a fresh attempt-1 dispatch. The route
requires exactly the current standalone/site job and macOS fixture/native job,
rejects an older attempt after CI is rerun, rebuilds the site, and admits a
bounded immutable Actions build-manifest artifact by exact run, attempt, source
tree, site subtree, lockfile digest, artifact ID/digest, and manifest bytes.

An advancing site target uses the same `website-production` ref, shared
promotion concurrency, existing status-only App, environment, rulesets, and
ordinary GitHub Actions ref writer as the legacy route. Before the App key is
available, complete governed Git histories and all ordered workflow-tree
changes must pass the site control-epoch admission. A changed workflow range
requires the independently reviewed exact digest emitted by preflight in
`control_epoch_digest`; unchanged ranges reject a supplied digest. Site epochs
use domain `textbutler/control-epoch/site/v1`, bind target and workflow source to
the same current `main` commit, and carry `tag: null`. They cannot authorize a
legacy package release. Both routes retain checked helper hashes and code-owner
review for the complete authority implementation.

Preserve the environment's actual protection rules. If the existing key
environment requires a reviewer, satisfy that exact run's review through
GitHub's normal environment approval interface after source admission and
independent control review. The site redesign does not remove reviewers, wait
timers or other runtime gates; the legacy setup policy below is not permission
to bypass an existing protection.

The site writer consumes prior status, proves that the ordinary writer is
denied by the exact required App status, attests one target, revokes the App
token, verifies current rules/status/source again, and makes one sterile
fast-forward push with the expected-old lease. App-only steps receive no ref
token; writer/admission steps receive no App key. The terminal consumption step
runs even after failure or cancellation when admission completed. The final
read-only jobs verify status consumption, revocations, unchanged rules, and
twice-confirmed REST/GraphQL Vercel Production identity for the exact source.

`textbutler-site-attempt` retains the explicitly listed public phase receipts
for 30 days when the runner can upload them. Hard termination may prevent this
upload; remote ref/status/provider readback and the existing interrupted
authority cleanup remain authoritative. Never blindly repeat an uncertain
write. If the ref already equals the site source, a fresh dispatch takes a
read-only qualification route with no App key or ref token. It requires the
status already consumed by the exact App bot (including its numeric actor
identity), the unchanged App-pinned rules, and the matching Production
deployment after the original successful CI completion. The retry's newly
built manifest is not treated as that existing deployment's publication time.
Leave `control_epoch_digest` empty for this already-exact route. An outstanding
success status must first pass the documented custody cleanup, not be silently
cleared by read-only qualification.

After provider success, verify `textbutler.app` serves the exact intended
deployment, truthful development status, canonical metadata and legacy links.
The current Vercel project/production branch remain the target; domain or
repository renaming is a separate inspected provider mutation.

## Repository identity migration

The repository rename keeps numeric GitHub repository ID `1342143606` and the
existing GitHub Apps, rulesets, protected refs, status contexts, environment
reviewers, workflow IDs, Vercel project, and production branch unchanged. The
canonical source identity for new release and promotion runs is
`hraness/textbutler`; an old-name redirect is not authority for a new run.
The npm name `@hraness/message-like-me`, its tag namespace, the
`messagelikeme` command, wire schemas, and historical release receipts remain
unchanged. `@hraness/agentmixer` publishes independently from the
`hraness/agentmixer` repository under its own `v*` tag namespace; this
repository consumes it only as a pinned immutable release artifact. Do not
rewrite an existing tag, npm version, or provenance statement.

Merge this version-neutral control migration independently before the next
product/version change. Refresh the complete administrative controls census
and independently review the exact helper/workflow changes. Before tagging,
read back each applicable npm trusted publisher and require canonical repository
`hraness/textbutler`, its existing exact workflow filename and permission set.
An old publisher identity blocks publication; do not fall back to a personal
token or weaken its policy. Any needed provider reconciliation is a separate
inspected operation. Historical versions retain their original provenance and
are not evidence for a new canonical-repository publication.

Before production promotion, follow the existing no-digest preflight and exact
reviewed control-epoch transition below. Preserve the actual key-environment
review and satisfy it through GitHub's normal interface. Neither the rename nor
this source migration permits an out-of-band ref move or a protection change.

## Legacy package publication

Message Like Me builds one exact public package tarball, validates those bytes
on macOS and Linux, and publishes the same tarball plus `SHA256SUMS` to an
immutable GitHub Release. Only then does it publish that tarball to npm through
trusted publishing. Its informational site can enter Vercel Production only
after both public coordinates pass admission. The tag workflow never receives
the production-ref writer key. A separate current-`main` workflow admits the
external npm and GitHub artifacts, then advances the production source after
the Release succeeds. A dedicated private Hraness GitHub App signs one
exact-commit status; the same protected job's scoped GitHub Actions token makes
the leased ref move only while the matching App-sourced success is current.

No personal access token, deploy key, Vercel token, or repository-administration
permission belongs in either workflow.

Routine production promotion needs no human confirmation. The current-main
source, public artifacts, complete workflow history, App authority, writer
denial, expected-old lease, and provider readback are machine gates. An agent
may perform the independent review and exact dispatch required for a changed
workflow-control epoch; that review precedes dispatch.

## AgentMixer package consumption

`@hraness/agentmixer` is published independently from the `hraness/agentmixer`
repository; its tag namespace, release workflow, provenance identity, and npm
trusted publisher live there and are governed by that repository's runbook.
This repository consumes it only as a pinned, immutable GitHub Release
tarball. Upgrading the pin is a reviewed `package.json`/`bun.lock` change
against an already-admitted upstream release; it never re-runs, rewrites, or
co-signs an upstream release.

## Establish the production controls once

Apply these controls in order. Record the exact readbacks in the change review.
Do not merge a product or version change until every control and the persistent
writer canary are complete.

The read-only Message Like Me pre-control snapshot on 2026-08-29 is:

- authoritative `main` is
  `167738fcc40e523d2696e2ff2bdbe29d502ba7df`;
- `refs/heads/website-production` is absent;
- the repository ruleset inventory is exactly empty;
- Vercel project `prj_K7VHB2ELASGF1OxTCxG8bfxOEoQJ` reports
  `link.productionBranch=main`; and
- its Production deployment for that exact `main` SHA is `READY` and
  `PROMOTED`.

The persisted Message Like Me Sites identifier
`appgprj_6a88baf1c6388191af90b2e1d7b846ee` is not accessible in the current
Sites workspace. Preserve it unchanged. Use the canonical Vercel control plane
for this rollout and do not create a replacement Sites project.

1. Merge the version-neutral release-control change from the reviewed current
   `main` head. Confirm the merged tree is the reviewed tree and all required
   checks passed.
2. Create the missing `website-production` ref once at that exact merged
   control commit. This bootstrap is the only manual creation of the ref.
3. In the signed-in Vercel project settings for project
   `prj_K7VHB2ELASGF1OxTCxG8bfxOEoQJ`, change Production Branch from `main` to
   `website-production`. The supported project PATCH does not expose this
   field, so use the signed-in provider UI and then perform an exact project
   GET readback. Require `link.productionBranch` to equal
   `website-production`. Preserve the existing project root, build command,
   install command, Git connection, domains, environment, and deployment
   settings.
4. Register one private Hraness-owned GitHub App dedicated to Message Like Me
   production authorization. Give the App exactly repository permissions
   `Commit statuses: Read and write` and implicit `Metadata: Read`, with no
   organization permission. Install it on `hraness` with selected-repository
   access to exactly `hraness/textbutler`. Record its numeric App ID,
   client ID, numeric installation ID, App slug, and the repository's numeric
   ID `1342143606`. These are distinct identities. Read the repository ID from
   GitHub's authenticated repository API and do not substitute a name at the
   token-mint boundary.
5. Create environment `production-ref-writer-key`. Limit deployment branches
   to selected branch `main` only. Configure no required reviewers, no wait
   timer, and no custom deployment-protection-rule App. Keep administrator
   bypass disabled (`can_admins_bypass=false`). The checked workflow admits
   only verified releases and revalidates the complete control range before
   reading the key; environment admission does not wait for a person. Store the
   private key only as
   environment secret `MLM_RELEASE_APP_PRIVATE_KEY`; store checked variables
   `MLM_RELEASE_APP_CLIENT_ID`, `MLM_RELEASE_APP_ID`,
   `MLM_RELEASE_APP_INSTALLATION_ID`, and `MLM_RELEASE_APP_SLUG` in that
   environment. Store the tag Release workflow's exact numeric workflow ID as
   repository variable `MLM_RELEASE_WORKFLOW_ID`, where the unprivileged
   trigger-verification job can read it. The privileged workflow declares
   `environment: { name: production-ref-writer-key, deployment: false }`, so
   admission and secret policy do not create a GitHub Deployment that would
   pollute the exhaustive Vercel Production inventory.
6. Add two active repository rulesets whose sole permanent ref target is
   `refs/heads/website-production`:
   - A no-bypass ruleset blocks creation, deletion, and non-fast-forward
     updates. It prevents recreation or force movement after the bootstrap.
   - A separate no-bypass required-status-check ruleset requires context
     `message-like-me/website-production-authority` from the dedicated release
     App's exact numeric App ID. It has no update restriction or bypass actor.
     Bind the expected status source to the App; do not use the client ID,
     installation ID, bot user ID, GitHub Actions Integration `15368`, a human
     identity, an unpinned status context, or a generic deploy-key bypass.
7. Add a separate active `main` ruleset requiring pull requests, code-owner
   review for `/.github/workflows/**`, the exact CI checks used by this
   repository, and protection from deletion and non-fast-forward updates. Keep
   bypasses empty.
8. Keep active no-bypass ruleset `Immutable version tags` scoped exactly to
   `refs/tags/v*`, with only update and deletion restrictions. It allows a new
   stable tag to be created but prevents an existing release tag from moving or
   disappearing. Read back `current_user_can_bypass=never` during the
   administrative controls census below.
9. Enable immutable releases for the repository. During that census, use
   owner-admin access out of band to require the repository
   immutable-releases endpoint to report `enabled=true`; record whether owner
   policy also reports `enforced_by_owner`. The Actions token cannot perform
   this administrative read. The workflow must still prove the resulting
   published Release reports `immutable=true` before npm can run.
10. Ensure `@hraness/message-like-me` exists publicly under the Hraness npm
   scope, then configure its sole trusted publisher as GitHub Actions repository
   `hraness/textbutler`, workflow file `release.yml`. Require its exact
   permission set to be `createPackage` plus npm's provider-imposed
   `createStagedPackage`. The checked Release workflow uses only its reviewed
   direct `npm publish` path, never `npm stage` or `stage publish`, and release
   preflight requires the staged-package inventory to be exactly empty. The
   one-time registry bootstrap may publish only the exact already-reviewed
   `v0.8.0` package bytes under the `legacy` dist-tag; every later release must use OIDC
   from the checked workflow. Once trusted
   publishing is proven, disallow traditional token publication for the
   package. This manual `v0.8.0` registry seed is historical bootstrap only.
   The registry may resolve both `legacy` and `latest` to those same immutable
   `0.8.0` bytes. Dist-tags are mutable labels, so sharing that coordinate does
   not alter the historical bootstrap or give it
   trusted-publisher metadata retroactively. Do not rerun its tag or invoke the
   automated Release workflow for `v0.8.0`. After the version-neutral control
   change merges, prepare a separate product pull request for a version newer
   than `0.8.0`; that new version is the first automated OIDC release and
   becomes Latest.
   Never retag or reuse `v0.8.0`. The public repository and package must retain
   automatic npm provenance for every automated release.

After setup, use owner-admin access out of band for a complete administrative
controls census: read back the exact Vercel production branch, environment,
variables, secret names, complete App installation, immutable-release setting,
and all GitHub ref rulesets. Refresh this census when control configuration or
workflow authority changes, when drift is detected, and during interrupted
authority recovery. Keep the reviewed evidence with that change or incident;
do not replay the historical bootstrap mutations to refresh it. Ordinary
releases do not repeat the complete owner-admin census. Never give that administrative
credential or evidence collector to the release workflow. Its narrowed App
token proves only its own effective identity, repository, permission, and
expiry closure. The Message Like Me post-control record must prove all of these
assertions together:

- `main` is the exact reviewed merge commit for this control change;
- `website-production` exists at that same commit before its rulesets become
  active;
- the no-bypass ruleset contains only creation, deletion, and
  non-fast-forward protection for that exact ref;
- the stable-tag ruleset targets only `refs/tags/v*`, contains only update and
  deletion restrictions, has no bypass actors, and reports
  `current_user_can_bypass=never`;
- the required-status-check ruleset targets only that exact ref, requires
  context `message-like-me/website-production-authority` from the dedicated
  App's numeric ID, and has no bypass actor;
- the App installation reports `repository_selection=selected`, account
  `hraness`, exactly `statuses:write` plus `metadata:read`, no `contents` or
  `workflows` authority, and an exhaustive
  `/installation/repositories` set of exactly
  `{hraness/textbutler}` with repository ID `1342143606`;
- `production-ref-writer-key` admits only `main`, has no required reviewers,
  wait timer, or custom deployment-protection rules, disables administrator
  bypass, and exposes only the expected key and checked variables;
- the Vercel project reads back
  `link.productionBranch=website-production`, while its project root, build,
  install, Git, domain, environment, and deployment settings remain identical
  to the pre-control snapshot; and
- a later `main` push creates no Vercel Production deployment.

Also read back the separate `main` ruleset and prove its pull-request,
code-owner, exact CI, deletion, and non-fast-forward requirements. The control
change deliberately retains version `0.8.0` and changes no product claim,
dependency, lockfile, or generated documentation.

Treat the production and canary ruleset IDs and their complete live readbacks as
an external release gate, not as inputs the promotion workflow may administer.
The workflow must not create, replace, patch, disable, or broaden a ruleset.
The administrative census establishes the existing IDs, targets, lifecycle
rules, App-pinned status context, integration ID, enforcement state, and empty
bypass sets. Every production attempt still validates the exact current
source and artifact, helper hashes and control epoch, effective App token
permissions and repository scope, live rules exposed to its scoped token,
App-sourced status, writer-denial proof, expected-old lease, and provider
outcome. These checks do not claim an administrator's complete controls view.
Observed drift blocks promotion until the controls are reviewed, repaired,
and admitted through a fresh administrative census.

For an existing environment that still requires a person, first merge this
admission policy after independent review and the required checks. Revalidate
the current workflow and helper hashes, the successful production and writer
canary evidence, exact ref rules, App scope, and provider state. Then remove
only the required-reviewer rule through the environment API, preserving its
main-only branch policy, disabled administrator bypass, key, and variables.
Read back the complete environment and the unchanged authority controls.
Existing machine gates remain required, including control-epoch admission and
interrupted-authority quarantine. An unrelated release failure is not a reason
to remove or bypass them.

### Review one workflow-control epoch

Routine promotion remains incapable of silently crossing a change to
`.github/workflows/**`. Its complete-history gate rejects that range before the
key environment. A reviewed workflow change uses the v2 control-epoch digest;
it does not use an out-of-band ref write or broaden either credential. The
permanent App remains exactly `statuses:write` plus `metadata:read`, and only the
job-scoped `GITHUB_TOKEN` may perform the existing explicit-lease ref move after
the pinned App status exists.

When an established protected ref predates reviewed workflow-control changes:

1. Keep the workflow disabled except during each separately bound dispatch. Record the
   exact protected-ref SHA, target SHA, current workflow-source SHA, repository
   ID, tag coordinate, ruleset readbacks, and public release admission. Dispatch
   the production or canary workflow once with an empty
   `control_epoch_digest`. That run must fail at the complete-history gate before
   the contents-writer environment is admitted and before any status-only App
   token is minted.
2. Preserve the failed step summary. It must contain the exact v2
   domain, protected ref, old SHA, target SHA, current workflow-source SHA, tag
   (or canary `no-tag` sentinel), ordered old-through-workflow-source commit inventory,
   every corresponding `.github/workflows` tree OID, the derived ordered change
   list, and the canonical lowercase SHA-256 digest. Independently reconstruct
   that inventory from only the governed refs and review every workflow-tree
   transition. Failed-step command-file outputs are not retrievable review
   evidence. Do not trust the digest without reviewing its complete preimage.
   In a disposable, complete, non-shallow clone populated only with the exact
   advertised `main`, protected branch, and (for production) stable annotated-tag
   refs, substitute the recorded values and reconstruct the ordered inventory:

   ```sh
   protected_ref=refs/heads/website-production # use the canary ref for a canary run
   old_sha=<40-hex-protected-ref-sha>
   target_sha=<40-hex-target-sha>
   workflow_sha=<40-hex-current-main-sha>
   tag=<stable-tag-or-no-tag>

   test "$(git rev-parse --is-shallow-repository)" = false
   test "$(git rev-parse --verify "${protected_ref}^{commit}")" = "$old_sha"
   test "$(git rev-parse --verify 'refs/heads/main^{commit}')" = "$workflow_sha"
   git merge-base --is-ancestor "$old_sha" "$target_sha"
   git merge-base --is-ancestor "$target_sha" "$workflow_sha"
   if [ "$tag" = no-tag ]; then
     test "$target_sha" = "$workflow_sha"
   else
     test "$(git rev-parse --verify "refs/tags/${tag}^{commit}")" = "$target_sha"
   fi
   test "$(git rev-list --count "$old_sha..$workflow_sha")" -le 250
   {
     printf '%s\n' "$old_sha"
     git rev-list --topo-order --reverse "$old_sha..$workflow_sha"
   } | while IFS= read -r commit_sha; do
     printf '%s %s\n' "$commit_sha" \
       "$(git rev-parse --verify "${commit_sha}:.github/workflows")"
   done
   ```

   Compare every printed commit/tree pair, in order, with the failed-run summary;
   adjacent rows with different tree OIDs must exactly match its changed-row
   markers. The target must appear in that inventory. Then use the reviewed
   helper from that same audited workflow-source checkout to reconstruct the
   canonical receipt and digest:

   ```sh
   MODE=production \
   PREVIOUS_SHA="$old_sha" \
   TARGET_SHA="$target_sha" \
   WORKFLOW_SHA="$workflow_sha" \
   PROTECTED_REF="$protected_ref" \
   VERIFIED_TAG="$tag" \
   node --input-type=module -e '
     import { describeControlEpoch } from "./scripts/release-workflow-range.mjs";
     const receipt = describeControlEpoch({
       currentMainSha: process.env.WORKFLOW_SHA,
       mode: process.env.MODE,
       previousSha: process.env.PREVIOUS_SHA,
       protectedRef: process.env.PROTECTED_REF,
       repository: "hraness/textbutler",
       repositoryId: 1342143606,
       tag: process.env.VERIFIED_TAG,
       targetSha: process.env.TARGET_SHA,
       workflowSha: process.env.WORKFLOW_SHA,
     });
     process.stdout.write(JSON.stringify(receipt) + "\n");
   '
   ```

   The resulting JSON's domain, ref, coordinates, ordered `inventory`, derived
   `changes`, and `digest` must exactly match the human-readable failed-step
   summary. Use `MODE=canary`, the canary ref, `tag=no-tag`, and a target equal to
   the workflow source for a canary review. Do not fetch an unbounded ref
   namespace, hand-assemble a digest, use a different checkout, or reorder the
   inventory.
3. Before dispatching the reviewed control-epoch transition, compare the tag,
   v2 domain, protected ref, old SHA, target SHA, workflow-source SHA, ordered
   inventory, change list, and digest with both the independently reviewed
   failed-run summary and the locally reconstructed receipt. Reject the
   dispatch if any field or ordered inventory row differs. Dispatch one fresh
   manual attempt 1 from exact current `main` with that exact
   digest. Automatic `workflow_run` events, rerun attempts, already-exact refs,
   and unchanged-workflow ranges must reject any digest. The gate recomputes the
   complete inventory and digest before environment admission; any source, tag,
   ref, target, ancestry, inventory, or digest drift fails closed.
4. The workflow enters `production-ref-writer-key` after its read-only
   admission jobs succeed, without a human approval. The hash-pinned helper
   recomputes and revalidates the same transition before reading the key. The
   normal split-authority sequence then applies unchanged: terminalize the status
   to the exact App-authored `error`, then prove the writer is denied with one exact
   `GH013: Repository rule violations found for refs/heads/website-production.`
   payload and one exact `remote: - Required status check "message-like-me/website-production-authority" is errored.`
   reason. Before exact comparison, normalize only one consistent known Git
   non-TTY display suffix: zero, one, or eight ASCII spaces on both semantic
   remote lines. Any other trailing byte, suffix length, or mixed framing is a
   rejection. Mutable
   Git progress, transport ordering, and helper-label framing are diagnostic
   only; the hash-pinned helper's fixed executable, remote, arguments, and
   refspec bind the operation.
   Post and read back one App-authored success,
   revoke that App token, make one exact non-force fast-forward with a nonempty
   expected-old lease, replace success with the terminal non-success status
   using a separately minted status-only token, revoke it, and complete the
   read-only provider outcome gate.
5. After provider success, read back the protected ref at the exact target and
   treat that target's `.github/workflows` tree OID as the baseline for the next
   routine range. Re-read the permanent App's exact `statuses:write` plus
   `metadata:read` permissions, absence of `contents` and `workflows` authority,
   singleton `{hraness/textbutler}` repository selection, and the terminal
   non-success status. A completed epoch requires no key rotation because it
   created or replaced no credential and every short-lived App token was revoked;
   an interrupted run still follows the separate quarantine and cleanup
   procedure.

The digest is scoped to one exact transition and is never permission to reuse a
stale run, skip fresh ref and source readbacks, expand the App, add a personal
token or deploy key, recreate a protected ref, force a move, or mutate a
ruleset. If a run is interrupted, follow the quarantine and cleanup procedure;
never treat the digest as retry authority. A later range with any different
coordinate or inventory requires a new no-digest rejection and independent
review.

### Prove the split status-and-writer boundary before product release

Do not infer the boundary from configuration alone. Before the first product
release, precreate persistent ref
`refs/heads/website-production-writer-canary` at the reviewed control commit.
Apply separate active rulesets with the same no-bypass protections and the same
App-pinned required status check to that exact canary ref. Prove every side of
the split credential contract:

1. The workflow-delta canary targets exact current `main`, which changes
   `.github/workflows/**`. First prove the empty-digest rejection before
   environment admission, independently review the complete v2 receipt, then
   prove that one fresh manual attempt 1 with its exact digest recomputes the
   transition before and after environment admission and advances only that
   target. Permission omission is not the gate: retain both runs and their exact
   receipts as evidence.
2. A later positive non-workflow canary targets a reviewed descendant for which
   every newly reachable commit preserves the baseline workflow-tree OID. Prove
   it accepts no digest and uses the unchanged v1 routine receipt. Prove
   the status-only App token cannot update the ref. After posting and reading
   back the App-authored terminal `error`, prove the job-scoped writer token is
   rejected with exactly one `GH013: Repository rule violations found for
   refs/heads/website-production-writer-canary.` payload and exactly one
   `remote: - Required status check "message-like-me/website-production-writer-canary-authority" is errored.`
   reason. Before exact comparison, normalize only one consistent known Git
   non-TTY display suffix: zero, one, or eight ASCII spaces on both semantic
   remote lines. Any other trailing byte, suffix length, or mixed framing is a
   rejection.
   Mutable Git progress, transport ordering, and helper-label framing are
   diagnostic only; the hash-pinned helper's fixed executable, remote,
   arguments, and refspec bind the operation.
   An `is expected` reason, a missing-status interpretation, another state,
   branch, context, duplicate GH013 payload, or multiple rule reasons is not
   this proof. The writer must remain unable to update until the exact
   App-sourced success exists.
3. Post one success status on the exact positive target under context
   `message-like-me/website-production-writer-canary-authority`, prove its exact
   readback, and revoke that short-lived status-only token. With the success
   current, use only the job-scoped writer token to make one fast-forward with
   an explicit nonempty expected-old `--force-with-lease`. Then mint a separate
   status-only token, post and read back the terminal non-success status, and
   revoke that second token.
4. Read the exact context back as the distinct terminal `error` after
   consumption, prove a stale lease cannot move the canary, and prove neither
   credential can perform the other credential's role. This evidence proves
   the observed target ended terminal; it does not claim an atomic
   post-consumption update denial that GitHub's status and ref APIs cannot
   express as one transaction.

A personal token or deploy key is not an acceptable probe. A bare lease,
remote-tracking lease, `--force`, empty expected-old, creation, deletion,
wildcard, or multi-ref push is not acceptable evidence.

Capture canonical ruleset, status, and rule-suite evidence that binds every
probe to the canary ref, status context, numeric App ID, App slug, installation
ID, before SHA, attempted or accepted after SHA, operation time, and originating
run. The accepted update must prove the required check came from the pinned App,
not a name-matching status from another actor, and used no bypass. The negative
records must prove missing authorization and direct App ref mutation. They must
also prove stale leases all fail without mutation; the final combined-status
read must prove the success was replaced by the exact App-authored terminal
status. Keep the canary ref and
its dedicated rulesets active after the proof so the evidence remains
reproducible. The no-bypass deletion rule deliberately forbids deleting it; do
not attempt deletion or temporarily remove protection.
Read back that the production rulesets still target only
`refs/heads/website-production` and the canary rulesets still target only the
persistent canary ref.

Keep the first later product release in a separate pull request based on this
exact control head. That product pull request must not change
`.github/workflows/`, `.github/CODEOWNERS`, the provider helpers, or these
controls. This separation keeps the reviewed control lineage intact.

## Publish a stable release

Prepare one stable version commit through a pull request. The root package,
site package, source version, README install target, and generated site content
must agree. Create its exact annotated `v<version>` tag only after that commit
has passed review and entered `main`; the tag commit must remain an ancestor of
current `main`, and the tag must be the newest stable semantic version. Later
reviewed `main` descendants do not invalidate the immutable release authority.
The first automated trusted-publisher version must be newer than the manual
`v0.8.0` bootstrap coordinate, whether npm currently maps only `legacy` or both
`legacy` and `latest` to `0.8.0`.

The tag-triggered Release workflow:

1. checks out only the requested tag at depth one with tags and persisted
   credentials disabled. Before importing anything else, the checkout must
   contain exactly that local tag ref. A dependency-free helper takes separate
   fixed-URL snapshots of exact `refs/heads/main` and canonical
   `git ls-remote --refs --tags ... refs/tags/v*` output. The combined governed
   inventory is at most 64 KiB and 500 rows and rejects malformed object IDs, non-fully-qualified
   or unexpected refs, duplicate rows, and noncanonical order. Historical
   lightweight stable tags participate in newest-version ordering, but the
   requested tag itself must be one direct annotated tag object whose embedded
   name is exact and whose target is the checked commit. The helper removes
   stale `FETCH_HEAD`, then fetches only fully qualified current `main` into
   `refs/remotes/origin/main` and the requested tag into its same-name local tag
   with `--no-tags`, no configured refspec, no force, no submodules, and no
   `FETCH_HEAD` write. A shallow checkout is unshallowed through only those two
   governed refspecs. The post-import ref set must be exactly those two names and
   both objects must equal the first remote advertisement. The helper rejects
   tag-of-tag and lightweight requested tags, proves the release commit is a
   reviewed ancestor of exact advertised current `main`, and requires an
   identical terminal remote snapshot. The workflow then runs
   the complete root, site, generated-file,
   packed-package, and synthetic macOS gates with read-only permissions;
2. creates one npm tarball and `SHA256SUMS`, preserves those exact bytes as a
   30-day workflow artifact, preserves separate numeric-ID-bound artifacts
   containing only the reviewed dependency-free npm writer and GitHub Release
   writer closures. Both closures are copied from regular non-symlink files into
   fresh runner-temporary roots and checked against exact file inventories before
   any repository code or dependency executes. Every local writer import names its
   `.ts` source explicitly. The workflow also installs the unchanged tarball on
   macOS and Linux;
3. gives only the GitHub publication job `contents: write`. That job performs no
   repository checkout or dependency install. Its SHA-pinned Bun and numeric-ID
   artifact actions are part of the privileged TCB. The GitHub token is scoped only to the final
   dependency-free publisher step. The writer artifact
   was assembled from the verified release source by the read-only verification
   job and is bound by its numeric ID and digest. That publisher revalidates the remote
   annotated tag object and reviewed-`main` ancestry, creates or safely resumes
   one deterministic draft, uploads only the tarball and checksum, publishes it
   as Latest, and requires the Release to read back immutable with exact names,
   sizes, digests, and bytes. An ambiguous or non-exact residual draft fails
   closed;
4. uses a separate read-only job with pinned Sigstore dependencies to prove the
   immutable Latest GitHub Release and workflow artifact are byte-identical.
   It records its actual run ID and attempt. If the npm version already exists,
   it must contain those exact bytes and its SLSA invocation plus Fulcio
   extension `.21` must bind the same workflow run ID at a positive attempt no
   later than that preflight attempt; and
5. gives only the no-checkout npm publication job `id-token: write`. Its
   SHA-pinned Bun, Node, and numeric-ID artifact actions are part of the
   privileged TCB; it installs no repository dependencies before invoking the
   reviewed dependency-free writer. Any later positive attempt of the same run
   may publish a still-absent
   version. If an earlier attempt made the exact version visible before its job
   completed, a later writer performs no mutation and defers acceptance to the
   final read-only provenance gate. A same-attempt absent-to-existing race fails
   closed. The writer records whether it published or observed existing bytes,
   plus its actual run ID and attempt. Final admission requires that exact
   attempt for a publication, or the same run at a positive attempt no later
   than the bounded observation attempt. It also verifies exact npm version and
   Latest integrity, MIT license, SHA-1, SHA-512, GitHub byte parity, and the
   Sigstore bundle's exact repository, workflow, tag, commit, run ID, attempt,
   Fulcio subject, certificate extensions, transparency log, and certificate
   transparency evidence.

The immutable annotated tag object, not mutable Release `target_commitish`
metadata or another branch hint, is the release authority once the tag exists.
Every reviewed-main comparison binds the exact base commit, merge base,
`status`, canonical integer `ahead_by` (zero only for identical, positive for
ahead), zero `behind_by`, and terminal `commits[-1].sha` for an ahead response
to a branch ref that is read before and after the comparison.
The workflow never treats an optional `head_commit` response field as authority.
Re-running or completing a failed workflow never retags,
deletes an immutable Release, changes tarball bytes, or accepts provenance from
another run. GitHub publication always precedes npm, preventing a mutable or
incomplete repository Release from stranding an npm version.

The tag workflow has no environment, App credential, provider baseline,
production-ref mutation, or provider-outcome job. A tag cannot enter
`production-ref-writer-key` because that environment admits only `main`.

After the full Release succeeds on any positive run attempt, its completed
`workflow_run` starts `Promote website production` from current default-branch
code. Every promotion checkout uses the exact current-main workflow SHA at
depth one with tags and persisted credentials disabled. Release content is
read from the separately imported and verified annotated-tag commit; tagged
workflow or helper code never executes. Treat the entire upstream payload as
untrusted. Require the exact
repository, checked numeric Release workflow ID, workflow name and path,
upstream event `push`, positive run ID and attempt, successful conclusion,
stable tag, annotated-tag target, downstream workflow SHA, and reviewed `main`
ancestry to agree. The current workflow source must still be exact current
`main`; the immutable release commit may be an earlier reviewed ancestor. A
manual `workflow_dispatch` with an untrusted release-tag input exists only for
recovery. Both paths use the same checks. That workflow:

1. runs the same fixed-URL, bounded, double-snapshot ref helper from an exact,
   depth-one, no-tag, no-credential current-`main` checkout whose initial local
   ref set is empty. The helper imports only exact main into
   `refs/remotes/origin/main` and the requested tag into its same-name local tag,
   requires `GITHUB_SHA` to equal advertised current main, and separately binds
   the direct annotated tag's peeled release commit to the successful Release
   run. Its post-import ref set must be exactly those two governed refs. It then
   proves the workflow file, `GITHUB_REF`, current default
   branch, annotated tag object, reviewed ancestry, root and site versions,
   exact npm
   version and Latest integrity, provenance, immutable artifact-complete Latest
   Release, checksum, and release authority all resolve to the same immutable
   release commit and tarball;
2. takes two stable, exhaustive GraphQL snapshots of at most 500 current
   `Production` deployments, including each deployment's current state and
   `latestStatus`, bracketed by authenticated GitHub server time and exact
   `website-production` ref reads;
3. enters `production-ref-writer-key` with `deployment:false` only when the
   baseline and a separate read-only preflight prove that the ref must advance.
   That preflight first imports complete exact governed history and enumerates
   every commit from the expected-old protected-ref SHA through the exact
   current workflow-source SHA, capped at 250 newly reachable commits. It proves
   the tagged release target is an advancing ancestor inside that range and
   rejects shallow or incomplete history, non-fast-forwards, and malformed or
   oversized inventories. Checking every ordered `.github/workflows` tree OID
   catches merge-side changes and an edit followed by a revert even when two
   endpoint trees match. If every tree preserves the baseline, any supplied
   digest is forbidden and the frozen v1 receipt binds the expected-old and
   release SHAs, transition commit count and digest, and baseline workflow-tree
   OID. If any tree changes, the empty-digest attempt publishes the full v2
   inventory, derived tree transitions, current workflow source, tagged target,
   and canonical digest, then rejects before the writer environment. Only a
   fresh manual attempt 1 carrying that independently reviewed exact digest may
   continue. The secret-bearing job installs no dependencies; in a step that
   does not receive the private key, it verifies hard-coded SHA-256 pins for the
   seven reviewed helpers and recomputes the selected v1 or v2 receipt before
   reading the key. The promotion helper validates that receipt before it may
   enter the App-token lifecycle. A checked local helper then signs a
   bounded RS256 App JWT, authenticates the exact App ID, client ID, slug, and
   organization owner, then reads the checked installation ID and requires its
   selected `hraness` account plus exact `statuses:write` and `metadata:read`
   permission closure. It then POSTs one token request with literal
   `repository_ids: [1342143606]` and only those permissions;
4. fails closed unless the mint response contains exactly that numeric
   repository, selected-repository scope, those two permissions, and a
   canonical expiry within the authenticated one-hour response window. It
   masks the token before use and keeps it out of workflow outputs. The checked
   attester posts one `success` status for the exact verified SHA under context
   `message-like-me/website-production-authority`, with no target URL and with
   the status source bound to the dedicated App, proves exact readback, and
   sends exactly one nonredirecting `DELETE /installation/token` for that
   admission token. Only after its bounded revocation convergence may the
   separate job-scoped GitHub Actions credential attempt the leased Git push.
   After that one writer process, a new status-only App token posts a terminal
   `error` under the same context, proves exact readback so the success cannot
   authorize a replay, and is independently revoked. Each DELETE
   requires an HTTP 204 with absent or canonical-zero `Content-Length` and zero
   body bytes, and then observes the exact selected-repository authority until
   two stable authenticated HTTP 401 authorization-denial responses prove
   convergence. A mutation failure and a revocation or convergence failure are
   both retained;
5. sandwiches the fresh writer job with separate read-only immutable Release,
   Latest, annotated-tag, reviewed-ancestry, public-artifact, and workflow-source
   admissions; proves `website-production` can fast-forward; then fetches only
   `refs/tags/<verified-tag>` from the fixed HTTPS repository at depth one,
   with tag following and submodule recursion disabled. It peels
   `FETCH_HEAD^{commit}` without checking out or executing tagged code and
   requires the result to equal `verified_sha` before using only the writer
   job's `GITHUB_TOKEN`, passed as `MLM_RELEASE_REF_TOKEN`, to push exactly
   `<verified-sha>:refs/heads/website-production` with
   `--force-with-lease=refs/heads/website-production:<expected-old-sha>`. The
   ref token stays out of URLs, argv, and Git config behind a bounded temporary
   `GIT_ASKPASS` helper. The job token is necessarily available to the hashed
   job code and is also named `GH_TOKEN` for its read-only REST and GraphQL
   calls; only the fixed ref writer reads `MLM_RELEASE_REF_TOKEN`. The status
   attester neither reads nor uses that name, and the App token is never passed
   to the ref writer. Prompting is disabled, global and system configuration
   are disabled, hooks and tags are disabled, cleanup is trapped, and a stale
   lease fails without mutation. The sterile bare repository requires
   `core.repositoryformatversion=0`, `core.bare=true`, and
   `core.filemode=true|false`. Beyond those core keys, it admits only Git's
   filesystem probes: `core.ignorecase=true` when emitted and optional
   `core.precomposeunicode=true|false`. Every other local configuration key is
   rejected before fetch or push. This keeps platform-specific Git
   initialization differences from being mistaken for inherited
   configuration. The exact production-ref
   post-read and independent current-`main` workflow-source revalidation do not
   begin until the terminal status is proven and the App-token wrapper returns
   after its `onRevoked` callback has accepted the sanitized convergence
   receipt. An indeterminate terminal status or revocation therefore prevents
   every post-read; and
6. uses a separate read-only job, bounded to 20 minutes, to require exactly one
   new Vercel Production deployment. The deployment and its exhaustive status
   history must bind Vercel bot `35613825`, the exact release SHA, task
   `deploy`, environment `Production`, and a
   `messagelikeme-<deployment>-hraness.vercel.app` URL. Stable terminal tag,
   Release, Latest, workflow-source, ref, inventory, and status readbacks close
   the workflow.

The successful DELETE and every accepted HTTP 200 or 401 observation
require a canonical GitHub `Date` strictly before the minted token's exact
`expires_at`.
The monotonic completion of the DELETE anchors a separate 30-second half-open
request-start window `[start, deadline)`: a response completing exactly at the
deadline remains eligible, while a later completion fails. The helper may read
`/installation/repositories` at no more than the ten absolute offsets 0, 250,
500, 1,000, 2,000, 4,000, 8,000, 16,000, 24,000, and 29,000 milliseconds. A
missed slot is skipped rather than retried or shifted, and request, body, and
sleep latency all consume the same window. App identity, installation, mint,
DELETE, and observation bodies are streamed under a 1 MiB cap and scrubbed
after parsing. Every HTTP 200 must still describe the exact singleton selected
`hraness/textbutler` repository with ID `1342143606`. Acceptance requires
two distinct scheduled HTTP 401 authorization-denial reads. An HTTP 403 is
indeterminate because GitHub can use it for rate limiting or policy denial; it
never proves revocation. A 200 after either denial, only one denial, any other
status, a redirect, malformed or oversized body, transport or timing
ambiguity, or failure to converge within the window fails closed. The exact
empty HTTP 204 DELETE response is the documented revocation success. The
scheduled reads are a defense-in-depth check and do not require GitHub to return
one unique post-revocation denial status. `propagationObserved=false` means the
first two probes were the stable denial pair; `true` means one or more exact
authorized 200 responses preceded the final two denials. This 30-second bound is
a Message Like Me operational ceiling, not a claim about GitHub's
revocation-propagation SLA. The action is never retried, the full App path is
capped at seventeen REST requests, and the exact production-ref post-read cannot
begin until convergence has been reported through the sanitized revocation
receipt.

A runner cancellation, host loss, or indeterminate status response after the
success POST is a quarantined authorization incident, never a retry signal.
Neither GitHub Actions nor a process signal handler can make the remote status
POST, readback, and token revocation atomic. A hard cancellation can therefore
end the runner before the status-only installation token is revoked; keep both
writers disabled and begin a fresh 65-minute quarantine from the newest
authenticated attempt update before any cleanup or writer is admitted.
Freeze promotion and read the exact target's App-sourced status plus the
production ref out of band. If the ref did not move, use a separately admitted
status-only cleanup to append and read back the terminal `error` before starting
a fresh run from a new baseline. If the ref did move, never move it backward;
require the exact provider outcome and use only the already-exact recovery path.
Do not dispatch another writer while the newest exact context is successful or
unknown.

### Terminalize an interrupted production authority

Use `Terminalize release authority` only for a failed `Promote website
production` attempt whose checked run title durably names the exact immutable
tag or release target. It is not a general status editor and it cannot clean up
an unbound historical run. If an older workflow lacks that target-bearing run
title, keep routine promotion disabled and resolve the target from owner-admin
evidence; do not treat the cleanup workflow as authority to restart.

Before dispatch, disable both `Promote website production` and `Prove
production ref writer canary`. Freeze workflow dispatches, reruns, Actions run
history deletion, ruleset administration, App installation changes, and key
rotation. Record owner-admin readbacks showing both production rulesets have no
bypass actors and `current_user_can_bypass=never`; the workflow token's rules
API is intentionally not trusted to prove those administrator-only fields.
Leave `Terminalize release authority` active, record the three exact workflow
IDs in `MLM_RELEASE_PRODUCTION_WORKFLOW_ID`,
`MLM_RELEASE_CANARY_WORKFLOW_ID`, and `MLM_RELEASE_CLEANUP_WORKFLOW_ID`, and
dispatch attempt 1 with the exact failed production run ID/attempt, immutable
tag and peeled target SHA, and unchanged production-ref SHA.

Treat an Actions run's `name` and `display_title` as presentation fields: a
workflow-level `run-name` can change them for each invocation. Stable workflow
identity is the exact numeric workflow ID plus its checked repository path;
exact run admission additionally binds the repository, run ID, event, attempt,
and source SHA. Cleanup separately requires the target-bearing `display_title`
defined by the checked workflow so it cannot select an unrelated failed run,
but that title is not a substitute for the numeric ID and path.

The cleanup inventories every attempt for all three credential-capable
workflows from one fixed authenticated GitHub `Date` minus 36 days. Thirty-six
days exceeds GitHub's 35-day maximum workflow lifetime, so a pre-freeze run
cannot remain runnable outside the inventory. It rejects 1,000 or more retained
runs for any workflow, more than 51 attempts for one run, more than 150 attempts
total, a missing attempt, another nonterminal attempt, or any workflow-state
change. The initial inventory lower bound and freeze anchor are reused
byte-for-byte through revalidation and postflight. Wait until the authenticated
completion time is at least 65 minutes after the latest disabled-workflow
update, inventoried prior-attempt update, and current App predecessor; this
exceeds the admitted one-hour App-token lifetime. A deleted history item,
recreated workflow, ambiguous newest failure for the target, changed run title,
or decreasing inventory digest fails closed. Because an administrator could
delete and recreate evidence between API reads, the owner freeze and
before/after admin readbacks remain part of admission.

After the main-only environment admission, the helper repeats the complete
snapshot before it may read the private key. The status-only App may then POST
only one distinct `error` for the exact failed target, prove that exact status
through the combined-status endpoint, and revoke the token through the same
bounded 401-convergence contract as routine promotion. A third complete
read-only snapshot must bind the exact terminal status, unchanged immutable
tag/Release and ancestry, unchanged production ref, workflow states, rules and
inventory. The final verifier then reads the exact terminal status, rules and
production ref in causal order. Its canonical receipt is written to the job
summary. If the runner remains available, every final-job bootstrap and
verification step is guarded with `always()` so an ordinary postflight or final
verification failure persists a canonical incomplete receipt. The receipt
retains every available validated initial, revalidated, terminal, and
postflight object (or its parse-failure digest), plus an independent exact
production-ref readback when available, and exits nonzero. A hard workflow
cancellation, runner loss, checkout failure, or platform termination can still
prevent any finalizer from executing; absence of a receipt is itself an
indeterminate incident. An incomplete or absent receipt is quarantine evidence,
never permission to retry.

After a complete receipt, repeat the owner-admin no-bypass/ruleset/App/key/run
inventory readbacks before re-enabling either routine workflow. A cancelled or
failed cleanup becomes a new externally recorded incident; keep both writers
disabled and wait a new 65-minute quarantine instead of blindly rerunning it.
Cleanup never moves or creates a ref, posts `success`, edits a Release, or
grants restart authority by itself.

Any ambiguity, concurrent production deployment, missing or changed baseline
item, provider error, terminal failure, identity mismatch, ref race, status
mutation, or timeout fails the promotion closed.

Public npm and GitHub artifact admission, including the cryptographic npm
provenance audit, is repeated before the provider baseline, immediately before
and after either production-ref path, and before and after the terminal provider
outcome. A moved npm Latest tag, missing provenance, changed registry integrity,
changed immutable Release coordinate, or byte mismatch fails the current phase
closed.

## Recover provider verification

Recovery uses the same `Promote website production` workflow dispatch from the
exact current reviewed `main` workflow source while the separately peeled
annotated release commit remains in `main` history. Current-main source and
release bytes are revalidated independently before and after provider work. It
requires the
exact existing npm version and immutable artifact-complete Latest Release. It
never creates, replaces, or edits an npm version or GitHub Release.

If `website-production` still precedes the release commit, recovery performs
the same checked explicit-lease fast-forward and requires one new provider
outcome. A baseline-preserving range uses the frozen v1 no-digest receipt; a
workflow-changing range requires the exact independently reviewed v2 digest and
recomputes its old-through-current-workflow-source inventory before authority.
The sterile writer fetches only the exact verified tag, with one more commit of
history than the admitted workflow range, and proves the expected production
commit is its ancestor before pushing. Missing ancestry or a non-fast-forward
target fails before the ref can move; the push receipt must still report one
ordinary fast-forward rather than a forced update. Because exactly one of the
advance and already-exact jobs is intentionally skipped, every job after path
selection has an explicit skip-aware status condition. The final public
admission runs as a terminal sentinel and fails unless verification and provider
admission both succeeded, so a skipped tail cannot make the workflow green.
If the ref is already exact, the baseline marks advancement false, skips the
entire `production-ref-writer-key` job, and mints no App token. A separate
read-only job accepts only the unique latest exact-SHA Production deployment in
the stable baseline that postdates the immutable Release, or, when the
separately admitted site route already advanced the ref to that exact commit
before the Release was published, that postdates the status App's admitted
`success` of the consumed site authority on that commit. That consumed
authority must already carry the App's terminal `error`; any other authority
shape, actor, or ordering keeps the Release publication as the boundary, so
this route can only admit a deployment that an admitted site promotion
created. That newest attempt itself must be provider-accepted. A newer terminal failure, error, or inactive
attempt blocks recovery instead of allowing an older success to be reused.
Recovery then repeats the terminal authority readbacks. A missing ref is a hard
failure and must not be recreated by the workflow. If the desired transition
crosses any workflow change, use the reviewed v2 control-epoch digest above.
The exact-digest attempt performs the normal checked lease advancement; it does
not externally advance the ref. A later already-exact recovery, if needed,
supplies only the provider proof and remains outside the key environment.

When a tag run fails after its exact draft or immutable Release exists, preserve
its evidence and rerun that same workflow. Re-running only failed jobs is
supported: successful preflight or publisher outputs retain their own actual
attempt coordinate, while a later writer may only publish still-absent bytes or
observe exact existing bytes without mutation. The run may safely complete only
the same tag, commit, deterministic draft, and tarball; npm provenance must bind
the same run ID and an allowed actual positive attempt. Correct only the failed
control and use the website recovery path after public admission succeeds. Do
not retag, delete the immutable Release or exact residual draft, manually move
`website-production`, reuse a stale control-epoch digest as retry authority,
redeploy from Vercel, or weaken a ruleset to make the run pass.
