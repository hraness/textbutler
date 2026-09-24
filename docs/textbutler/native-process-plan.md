# AgentMixer native process boundary

AgentMixer owns provider policy and account leases. A shared native process
transport owns an exact admitted process scope and byte streams. Applications
own durable custody records, credentials, workspaces, artifact admission and
recovery. Sharing the process implementation must preserve those owners.

This plan starts from `a878d72d37ed86fd0cb3a3b78924a1221ce0135a`. AgentMixer now
lives in the standalone `hraness/agentmixer` repository as the published
`@hraness/agentmixer` package; `agentmixer/` paths below refer to that
repository's layout. This change does not activate a provider backend.

## Invariants

- Root exit, native scope join, consumer delivery and operation success are
  separate facts. A failed RPC or output delivery can coexist with proven
  physical join. An expired deadline, destroyed JavaScript stream, successful
  `kill`, PID probe or rejected launch cannot create join evidence.
- Account identity, lease generation and process generation bind the provider
  adapter. A separate version, nonce and scope bind the native invocation. The
  trusted host must persist their association before provider execution.
- Every byte write has a full, refused, partially accepted or indeterminate
  result. There is no automatic replay. Admission occurs immediately before the
  host write, with no backend queue behind an outstanding write. Cancellation
  invalidates queued product work before it can reach that fence.
- Account shutdown retains custody while its writes, requests, consumer streams,
  callbacks or earlier stop calls remain unsettled. Native join may discharge
  physical custody despite failed delivery; it does not discharge pending
  application work or turn the operation into success.
- The existing contact task profile still requires `noCommandTools`, exact tool
  inventory, read/write isolation, isolated configuration, authentication outside
  the workspace and `hostBrokerOnly`. xcb's persistent coding session is a
  separate explicit profile. It cannot reuse the contact task policy unchanged.

## 1. Package-local process seam

Implemented and independently reviewed source; repository integration remains
pending:

- `agentmixer/src/process-port.ts` declares an in-memory
  `ProviderProcessPort`: readiness, root observation, exact native settlement,
  operation completion, bounded backend byte streams, explicit write outcomes,
  input closure and synchronous stop fences. It is not another wire protocol,
  launch API, runtime qualification or saved-PID signaling API.
- `agentmixer/src/codex-account-process.ts` binds that port to the
  existing account controller. It preserves native settlement independently of
  delivery success and joins delivery before reporting successful operation
  completion. Matching native `not-started` evidence needs no invented root
  event. The trusted host supplies the settlement; stored JSON alone is not an
  evidence issuer. A required synchronous `assertWriteAuthority` callback checks
  the current account/process binding and daemon authority immediately before
  each host write. An immutable binding alone cannot establish current authority.
  Rejected or asynchronous checks admit no bytes; any accidentally started
  promise remains owned until settlement. Late readiness after stop rejects.
- `agentmixer/src/codex-account-transport.ts` consumes explicit byte
  outcomes instead of Node writable callbacks. RPC success requires both the
  matched response and full write acceptance within the caller's deadline.
  Failed or uncertain writes close admission. Node `end`/`close` settle local
  consumer work; only the injected host receipt proves native EOF.
- `agentmixer/src/codex-account.ts` publishes its shared close attempt
  before synchronously aborting the active request. Reentrant cleanup remains
  single-owned and an already queued write cannot run before that invalidation.
- Synthetic tests cover pre-readiness cancellation, stale invocation and account
  binding, root exit without join, damaged streams without join, damaged streams
  with join, not-started cleanup, uncertain writes, early replies and queued
  writes whose request deadline expires.

The account RPC surface remains closed: initialization, account read, supported
managed login/cancel/logout and bounded model discovery. This seam adds no raw
RPC, provider token input, thread/turn command or model-visible process tool.

## 2. Shared artifact and trusted host composition

Proposed integration; the storage changes, host factory and packaged wiring
below are not implemented or activated. Consume one admitted
`@hraness/native-process` artifact and remove the temporary package-local process
contract during migration. Keep one Rust kernel and one wire implementation.
Package, installation, platform and provenance evidence must bind the exact
distributed bytes.

### Store and daemon ownership

Extend Textbutler's existing `state/runs.sqlite`, owned by
[`RunJournal`](../../packages/textbutler/src/journal.ts). Its account leases
already use that same SQLite connection. A Textbutler-owned `AccountLeaseStore`
wrapper for native controllers must acquire the lease and reserve its invocation
in one synchronous transaction. Reservation inside the later transport factory
would leave a crash interval with an owned lease but no invocation record.
Existing API-only consumers retain their current lease behavior.

Add versioned invocation records containing the daemon generation, account lease
owner and generation, process generation, invocation nonce, profile and artifact
digests, host/boot context, revision, Prepared/Ready identities and release
evidence. Bind recovery to the physical store identity so a copied database
cannot authorize release of another installation's account. Preserve run and
grant history. Records contain no credentials, login challenges, RPC bodies or
provider output, and remain outside contact workspaces and activity responses.
Cap unreleased invocations at 256, with a partial index and a recovery query
limited to 257 rows so overflow refuses new native work without an unbounded
scan or deletion of unresolved custody.

Reuse [`DaemonCustody`](../../packages/textbutler/src/daemon-custody.ts)'s
exclusive SQLite lock. Add a generation when the lock is acquired and a private
capability bound to the exact open journal. Revoke launch and write authority
synchronously when closing begins. Keep separate authority for settling existing
invocations until their callbacks are joined or permanently fenced from storage.
The journal and daemon lock must not close while a late callback can still write
to the database or reopen admission. An unknown native scope remains recorded
and keeps its account unavailable.

### Launch, writes and settlement

The managed account factory stays synchronous: it returns an owner handle before
asynchronous runtime admission or launch. The provider host retains that handle
immediately, including failed and cancelled launches. Its public readiness
promise cannot succeed after shutdown. The launch sequence is:

1. Commit the account lease and reserved invocation together before starting a
   helper. A failed reservation rolls back acquisition.
2. Persist exact Prepared identities before sending Activate. Immediately before
   Activate, synchronously check the current daemon, lease, process generation,
   invocation revision, profile and cancellation state.
3. Commit the observed Ready identity before admitting provider RPCs. Every byte
   write then checks current authority synchronously through the existing account
   process bridge. Failed or uncertain writes retain their outcome without replay.
4. Revoke writes before stopping. Persist exact native settlement independently
   of operation success; a failed Prepared or Ready commit can still be followed
   by proven physical join without inventing a successful commit.
5. Release the matching lease and invocation atomically only after native
   settlement and outstanding factory, write, request, notification and authority
   work have settled. A failed compare-and-swap retains custody.

The controller's in-memory authentication/request generation remains distinct
from the durable lease and process generations. Existing account invalidation
continues to reject stale queued requests. Neither a deadline nor an expired
lease grants permission to replace a potentially live provider process.

### Recovery and first packaged consumer

Recover native records after acquiring daemon custody and opening the journal,
before admitting native account factories. Capture exact row and lease revisions
before bounded native observations, then compare them again in the release
transaction. A reserved predecessor can be fenced as activation never admitted;
that releases the provider-writer barrier without claiming an unrecorded helper
or anchor physically joined. Prepared scopes require exact native absence on the
same host and boot, or verified same-host evidence that the prior boot ended.
Foreign hosts, replaced stores and unknown observations retain custody. Observe
at most 16 scopes per request. Legacy owned leases without invocation records
keep their existing independent recovery requirement.

Message-run recovery stays separate: an abandoned run or indeterminate send does
not prove provider closure. Socket recovery, root exit and successful signals
also cannot release a native account. Recovery failure affects the unresolved
native account; independently qualified API routes retain their behavior.

The first consumer is managed Codex **account administration only**:
initialization, account read, supported login/cancel/logout and bounded model
discovery. Contact reply execution stays unavailable until its exact tool,
configuration and filesystem restrictions qualify. Credentials remain outside
contact workspaces; signing in does not enable replies or message delivery.

Wire the factory through the actual packaged Textbutler runtime and CLI into
`startDaemon`, with the admitted helper image preserved in the signed application
resources. A test-only `startDaemon({ managedCodex })` injection is insufficient.
Acceptance requires installed-artifact execution through that real composition,
crash and shutdown evidence at each durable boundary, and an exact account-profile
qualification decision. Synthetic ports, this design and artifact publication
alone do not activate the backend.

## 3. Provider execution adapters

Consumer refactor implemented and independently reviewed; shared artifact
admission and application factory wiring remain pending:

- `src/claude-sdk.ts` now accepts a trusted host process factory behind its
  existing runtime, broker, workspace and credential checks. The default
  `src/provider-process.ts` owner remains available. The adapter checks the
  handle's stopped state independently of a returned stopped receipt; a
  throwing factory or false stop claim retains custody uncertainty.
- `src/codex-process.ts`, `src/codex-session.ts` and
  `src/codex-managed-session.ts` now use explicit byte-write outcomes. A full
  acknowledgement is required before session execution advances. The native
  task bridge joins outstanding writes, authority and physical custody before
  calling the application's journal/configuration/scratch finalizer. A late
  uncertain write remains failed even after physical cleanup. Runtime snapshot,
  confinement, relay and account-generation checks retain their existing owners.
- Keep the current unqualified task paths unavailable until each exact runtime,
  configuration and effective tool inventory has relevant evidence. Add a
  separate persistent coding profile for xcb, with its own application
  authority and lifecycle, rather than widening contact task capabilities.

Acceptance requires migration of actual consumers and removal of replaced
process ownership, with no fallback that equates root exit with scope join.
The migrated source passed 339 focused tests with 2016 assertions across 11 files,
followed by the relay-receipt regression suite (86 tests,836 assertions) and a
final strict package typecheck. These checks use synthetic providers. They do
not establish shared artifact installation or live runtime qualification.

## Validation and delivery

Worker checks for phase 1 use synthetic streams only:

```sh
bun test agentmixer/test/codex-account-process.test.ts agentmixer/test/codex-account-transport.test.ts agentmixer/test/codex-account.test.ts
bun x --no-install tsc --noEmit -p agentmixer/tsconfig.json
git diff --check
```

The integration owner runs the complete repository `bun run check` gate,
including `check:textbutler`, after convergence. Use the installed host
scheduler for the repository gate, process custody/recovery checks and native
work; native qualification needs the applicable platform lane. Preserve the
documented reviewed branch and artifact delivery gates. This private package
change supplies no live provider, Mac/Windows support or daily-driver claim.
