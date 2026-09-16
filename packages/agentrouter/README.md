# Agentrouter

Agentrouter is a provider-neutral foundation for applications that give an agent
a small, explicit tool surface. This first consumer is Textbutler. The package's
public contract and provider qualification are still being developed; see the
qualification limits below before relying on any provider adapter.

It provides:

- A Codex/Claude adapter interface with explicit runtime qualification.
- Shared SQLite account custody, generation fencing and process-aware recovery.
- A tool broker bound to one workspace and run, with closed file, public-web and
  messaging operations. There is no shell, executable or arbitrary RPC operation.
- Strict classifier output validation and selection from a fresh, host-observed
  model catalog. The cost comparison uses a 2,000-input / 128-output-token request.

`src/index.ts` exports the complete current interface. `createPublicWeb()` provides bounded public HTTPS GETs with address pinning, redirect checks, no ambient authentication, a 15-second deadline, and a 256 KiB maximum text response. Run `bun test
packages/agentrouter` from the repository root.

## Standalone package

`bun pm pack` produces a self-contained tarball after `bun
scripts/build-agentrouter-dist.ts` emits `dist/`: the `files` allowlist ships
only `dist` (a bundled ESM entry plus TypeScript declarations) and
`MANAGED-CODEX.md`, and the manifest pins every registry dependency to an exact
version. The package has no cross-package source imports, so a consumer
installs it with only its declared dependencies. Runtime facilities sit behind
small ports — `loopback-server.ts` uses `node:http` and `sqlite-port.ts` lazily
opens `bun:sqlite` or `node:sqlite` — so the built entry runs under both Bun
≥1.3.14 and Node ≥22.13 (the first release where `node:sqlite` loads
unflagged). Under Node, the first account-database open may emit Node's
`ExperimentalWarning` for `node:sqlite` on stderr; the API and file semantics
are pinned to match `bun:sqlite`. The managed native Codex launch path still
requires its pinned Bun 1.3.14 runtime and fails closed anywhere else — runtime
pinning is an admission invariant, not a portability gap. The repository gate
`bun run check:agentrouter-package` builds and
packs the tarball, scans its contents, verifies the manifest contract and
dependency completeness, installs it into an isolated consumer, and executes
the public entry — including an account-lease custody round trip — under both
runtimes. Releases are published through the repository's
`agentrouter-v<version>` tag channel: an immutable GitHub Release tarball is the
canonical artifact and `@hraness/agentrouter` on npm is an exact-byte mirror
published with OIDC provenance. See `docs/publishing.md` for the release
contract.

## Application-owned capability profiles

An application can define its own tools with `createCapabilityProfile()` and
bind them to one host-selected workspace and run with `createCapabilityBroker()`.
The host supplies every descriptor, input parser and handler. Model arguments
cannot replace the bound workspace, credentials or handler implementation. This
separate interface leaves Textbutler's existing contact broker and
`AgentRouter.run()` path unchanged.

For example, this host stores bounded notes in memory:

```ts
import { createCapabilityProfile, createCapabilityBroker } from "@hraness/agentrouter";

const notes = new Map<string, unknown>();
const hostState = { active: true };
const profile = createCapabilityProfile({
  id: "notes", version: 1,
  tools: [{
    name: "notes.write", description: "Replace the bound workspace's note.",
    inputSchema: {
      type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
      required: ["text"], additionalProperties: false,
    },
    parseInput(input) {
      if (typeof input.text !== "string" || !input.text.length
        || Buffer.byteLength(input.text) > 4096) throw new Error("INVALID_NOTE");
      return input;
    },
    execute(input, context) {
      context.assertActive();
      notes.set(context.workspaceId, input);
      return { stored: true };
    },
  }],
});
const broker = createCapabilityBroker({
  profile, workspaceId: "workspace-1", runId: "run-1",
  isActive: () => hostState.active,
});
await broker.invoke("notes.write", { text: "First note." });
await broker.close();
```

Profiles and their descriptors are immutable. Their SHA-256 digest binds the
profile ID, version and ordered tool descriptors, including each input schema.
It does not identify handler code or prove runtime confinement; the host must
establish that provenance and qualify the adapter for the exact profile separately.
The broker checks a closed outer input object; trusted parsers enforce the full
semantic contract. Schema descriptors do not fetch references or execute code.

Calls are serialized, and inputs are copied before queuing. JSON inputs and
outputs are bounded to 256 KiB, with structural limits; schemas are limited to
32 KiB per tool and profiles to 64 tools. Unknown tools are denied. Revocation or
an aborted signal prevents queued work and withholds late results. A trusted
handler must call `context.assertActive()` immediately before every effect,
including after its own awaits, and retain the application's conditional-write
and authorization checks. Revocation cannot undo an effect already performed.
`revoke()` stops admission immediately; `close()` also waits for admitted handlers
to settle. Neither proves that an external provider process has stopped.

Use `AgentRouter.runTask(request, broker)` with explicitly supplied `taskAdapters`
for application profiles. The request selects the exact route, authentication
kind, account, profile, model, reasoning effort, service tier and run limits.
The adapter needs current qualification for that exact route, runtime and profile.
No live task adapter is bundled, and a selected subscription route is never
replaced with an API route. Registering a capability profile does not enable a
provider or establish account availability.

## Opt-in Claude API route

`createClaudeApiAdapter()` is an additional, explicitly selected **Claude API**
route. It does not run Claude Code, use a coding-agent subscription, discover
accounts, or substitute itself for a selected Codex/Claude Code route. The host
executes its tool loop: API responses can invoke only the supplied broker's six
operations. No shell, subprocess, native configuration, plugin or server-side
tool is exposed. Unknown tool names receive a denied result; unexpected response
capabilities fail the run. Classification sends an empty tool array.

This adapter admits its code-enforced execution profile after checking the pinned
Anthropic SDK 0.125.0 and verifying the compiled runtime's exact bytes. The
24-hour runtime qualification describes that local authority boundary; it does
not attest live account availability or messaging delivery. Recreate an expired
adapter and refresh model availability before continuing. Native fixture receipts
play no part in API admission.

The trusted embedding host supplies `runtimeArtifact: {entrypoint, sha256}` from
its reviewed compiled distribution. The adapter verifies the physical regular
file and exact bytes, then binds the runtime identity to that digest and pinned SDK
version. A colocated self-authored manifest is not proof of authenticity: the host
must establish its distribution signature or reviewed build provenance separately.
This input must never come from contact settings or an untrusted plugin.

The host must explicitly bind a credential and supply observed prices:

```ts
const credentials = createFileClaudeApiKeyResolver({
  directory: privateCredentialDirectory,
  bindings: { "owner-api-account": "anthropic-api-key" },
});
const modelCatalog = await discoverClaudeModels({
  credentials,
  accountId: "owner-api-account",
  priceCatalog: ownerReviewedPrices,
  signal,
});
const adapter = await createClaudeApiAdapter({
  runtimeArtifact: verifiedCompiledRuntime,
  credentials,
  modelCatalog: async () => modelCatalog,
});
```

The credential directory must be physical, owned by the current user and mode
0700. Each selected file must be a single-link regular file with private read/write
permissions; it contains only the API key, optionally followed by one newline.
Files are read through bounded, checked descriptors on each use. The application
owns credential creation/removal and keeps this directory outside contact memory.
The existing explicit environment-variable resolver remains available.

Model discovery calls only the authenticated Models API. It does not send a
prompt or execute an agent. `ClaudePriceCatalog` contains `observedAt` and exact
`id`, `inputUsdPerMillion`, `outputUsdPerMillion`, `classifierEligible` entries;
prices older than 30 days are rejected. The API supplies availability and structured
output capability, not prices. Unknown/unpriced models remain excluded. The
classifier selects the lowest estimated cost from the eligible observed entries.

Requests go only to the fixed Anthropic HTTPS origin, with explicitly reconstructed
headers, no cookies, redirects, retries, custom endpoints or ambient proxy
configuration. Responses are bounded before SDK parsing. Defaults are eight
turns, 4,096 output tokens (512 for classification), a 120-second deadline and
a $0.25 conservative local reservation using supplied prices. That reservation
is not a provider billing cap. Cancellation prevents subsequent tool calls and
releases account custody once all awaited local work has stopped. Errors omit
provider response bodies and credentials.

## Native coding-agent execution status

Managed Codex account controls are separate from agent execution.
`createManagedCodexAccountController()` provides subscription sign-in, cancellation,
sign-out, account checks and bounded model discovery through a host-supplied
account-only transport. `createCodexAccountStdioTransport()` implements the
supported app-server account protocol over an explicitly supplied process port.
Neither function launches a production process or qualifies a response adapter.
See [managed Codex account integration](MANAGED-CODEX.md) for the host contract.

`createClaudeSdkAdapter()` implements the pinned Claude Agent SDK subprocess
protocol with API-key authentication. Its execution gate requires a trusted host
qualification for the exact native executable and SDK digest. No production
qualification receipt is bundled. The default provider adapters continue to refuse
execution. `createProviderLaunchPlan()` is descriptive configuration, not a sandbox.

The installed versions are Claude Agent SDK **0.3.268**, bundled native Claude Code
**2.1.268**, Anthropic SDK **0.125.0**, MCP SDK **1.30.0**, and Zod **4.6.2**.
`inspectClaudeSdkRuntime()` checks the installed SDK version, native binary owner,
mode, link count and SHA-256, and returns the composite qualification identity.
Every run verifies and copies executable bytes from a checked file descriptor into
its private run directory before resolving credentials. The subprocess runs that
snapshot, so replacing the configured source path cannot replace the admitted
credential-bearing executable.

The adapter creates separate private working, home, configuration and temporary
directories outside contact memory. It supplies an explicit environment, removes
all built-in tools, disables inherited settings, hooks, automatic memory, connectors,
plugins, bundled skills, workflow triggers and persistence, and configures only its in-process MCP broker. It checks the
native initialization model, version, tools, MCP servers, skills, plugins and API-key
source before admitting broker calls. A fixed plain-text prompt header prevents task text from entering native slash or bang command dispatch. Classification has no tools. The contact
folder is accessed only by host broker methods; it is never the native process cwd.

Native processes use a detached process group. Raw stdout is bounded to 1 MiB per
frame and 8 MiB total before SDK parsing; stderr is discarded and capped at 256 KiB.
Cancellation terminates the group, escalates to kill if needed, and waits for root
exit and group absence before releasing account custody. A joined failure uses
`AgentStoppedError`; an unproven exit keeps its lease and private state. These
controls do not prove confinement of a malicious native process or a descendant
that escapes its process group. Runtime qualification must cover the trusted
executable, host policy and relevant descendant behavior independently.

The host can bind an account to one explicit environment variable:

```ts
const credentials = createEnvironmentClaudeApiKeyResolver({
  "owner-api-account": "TEXTBUTLER_ANTHROPIC_API_KEY",
});
const adapter = createClaudeSdkAdapter({
  runtime: { executablePath: pinnedNativePath, executableSha256: reviewedBinarySha256 },
  stateRoot: privateProviderStateDirectory,
  credentials,
  qualification: independentlyVerifiedHostQualification,
});
```

Those paths, digest and qualification are host inputs, never contact or plugin
configuration. The resolver reads only the selected variable at invocation time;
it does not discover personal accounts, parse dotenv files, use ambient provider
keys, or borrow subscription tokens. It admits the pinned API-key format and
rejects OAuth tokens. A host Keychain integration can implement the same
`ClaudeApiKeyResolver.withApiKey()` interface without changing the broker. API keys
must remain outside contact folders, settings responses and logs. The adapter's
per-run default budget is $0.25 and deadline is 120 seconds; neither is a claim of
account-wide spend control.

`test/claude-sdk.test.ts` runs the real SDK against synthetic subprocess peers to
verify option isolation, MCP routing, zero-tool classification, output validation,
revocation and process custody. `test/provider-process.test.ts` also proves
termination of a surviving process-group descendant and raw output bounds. On
2026-09-11 the actual macOS ARM64 native CLI completed a separate control
initialization with a fresh synthetic home and no user message: the configuration
was accepted and the MCP inventory was empty. That control response contains no
built-in tool inventory and is insufficient for execution qualification.
`qualification/claude-native.ts` is the explicit adversarial native fixture with a
local synthetic Anthropic endpoint and temporary contact folders. It uses the same
restricted launch-option builder as production; the production adapter does not
accept custom API endpoints. Its receipt describes the exact fixture/runtime
boundary and never automatically enables production. The seven native scenarios
passed on macOS ARM64 on 2026-09-11, including explicit `doctor` / `checkup` Skill
denials, literal command-shaped prompts, 11 forbidden tool calls, six file escape
or stale-write denials, and a successful conditional edit and staged reply.

The [SDK skills reference](https://code.claude.com/docs/en/agent-sdk/skills)
distinguishes the discovered skill catalog from invocation permission. An empty
allowlist alone does not empty that catalog, and direct command dispatch bypasses
the allowlist. The pinned profile explicitly turns `doctor` and `checkup` off,
denies the Skill tool, wraps task text, and retains strict empty-catalog checks as
a configuration-drift guard. Native evidence checks every API request's tool
manifest and actual denied results; catalog absence alone is not a scope proof.

Codex remains unavailable in the app. The experimental `codex-config.ts`,
`codex-process.ts`, `codex-relay.ts` and `codex-session.ts` modules implement a
pinned **0.153.4** app-server driver. They have no credential discovery, live
provider transport or production adapter registration. The launcher copies the
verified executable into a private runtime directory, keeps contact folders
outside native scratch, and records process custody before protocol startup.
The trusted host must also supply an independently admitted SHA-256 for its
actual Bun 1.3.14 executable. The launcher checks that identity before startup
and after joined shutdown. Before spawning, it verifies the private scratch
directory's closed inventory, permissions, link counts and exact configuration
bytes. Version 2 custody records bind the parent runtime and scratch digests;
older records cannot supply those proofs. Runtime drift retains the run's state.
The relay checks the exact ordered tool inventory on every model request, using
the pinned native schema representation. Codex omits string-length and numeric
range hints on the wire; the broker still enforces those limits. Each result
stays bound to its native call, exact broker output and stable history identity.
The relay bounds native client metadata and removes
it before forwarding, including that field's workspace and installation
identifiers. Classification has no tools. Unsupported
response shapes fail closed; the current relay accepts a deliberately small
Responses SSE contract and is not a general provider streaming implementation.
Remote control is explicitly disabled at CLI startup. Its disabled-state
notification and bounded native timestamps carry no authority; active states and
unreviewed notifications fail the session.

The internal `codex-api-response.ts` module admits a narrow, buffered OpenAI
Responses JSON result and translates it into that three-event contract. It binds
one dated model snapshot, exact broker descriptors and an output-token cap,
preserves measured usage, and rejects incomplete responses, reasoning, duplicate
JSON keys and extra effects. It makes no HTTP request and is not an API adapter.
The host still needs credential and account custody, request construction,
billing admission, response-body cleanup and cross-response call-ID checks. No
Codex API account or model route is registered by importing it.

On 2026-09-12 the actual pinned native executable completed a scripted response
through all six broker tools and a separate zero-tool classification through
these modules. Every request carried the expected inventory; contact memory,
staged actions, process exit and listener cleanup matched the fixture. The model,
web responses and contacts were synthetic; nothing was sent or billed. These
checks establish runtime compatibility, not production qualification. Direct
filesystem and process confinement, adversarial runtime custody, and
account/model transport admission remain required. Session receipts always
report `productionQualified: false`.
Nine scripted native rejection cases also passed: foreign paths and file aliases,
stale writes, forbidden shell/skill/input tools, duplicate calls, cancellation,
an upstream deadline and malformed SSE. They verified unchanged protected
fixtures, no staged sends, and joined process, broker and listener cleanup.
An adversarial kernel helper also demonstrated that host-supplied ordinary file
descriptors and preexisting hard links retain access across sandbox startup.
Production admission must prove the launcher's clean descriptor and scratch
setup; the profile alone cannot undo authority supplied by the host.
A separate helper test under pinned Bun 1.3.14 passed on 2026-09-12: the child
had exactly three communication sockets, all four deliberately inheritable
parent descriptors were absent, and process and listener cleanup joined. That
test substituted a descriptor-inspection helper for Codex and does not qualify
the native agent itself.
See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [App Server documentation](https://learn.chatgpt.com/docs/app-server).

The [Claude custom-tools documentation](https://code.claude.com/docs/en/agent-sdk/custom-tools)
documents selecting built-ins with `tools`; `tools: []` removes that surface.
The [permissions documentation](https://code.claude.com/docs/en/agent-sdk/permissions)
explains why `allowedTools` alone only pre-approves calls. A production qualification
must also establish that managed host policy has not introduced configuration,
hooks or other authority that cannot be disabled by application settings.

## Ownership boundaries

The account and task consumers accept a structural `ProviderProcessPort` through
`bindCodexAccountProcess()` and `bindCodexTaskProcess()`. Codex sessions serialize
explicit write receipts: only `accepted-full` advances the protocol. Refused,
partial, unknown or timed-out writes fail the operation without replay; cleanup
retains any outstanding write and authority work. Task finalization requires the
matching physical join plus settled transport and delivery. The host's finalizer
still owns its configuration, confinement, scratch and durable custody receipt.
Physical join alone does not prove those product facts or qualify a provider.

A trusted `CodexProcessLauncher` or `CodexManagedProcessLauncher` can return that
task bridge after preparing its exact account, task, profile and launch intent.
The Claude SDK adapter also accepts an optional synchronous `processFactory`
behind its existing runtime, credential and tool checks; omission preserves the
current bounded process owner. Factories must return an owned handle even when
readiness later fails, and may not discard a process after a launch effect. The
factory owns artifact admission, native event persistence and complete stop/join
semantics. These are source integration seams: no shared native artifact, native
managed launcher or new production qualification is bundled or implicitly enabled.

The application owns its daemon, contact enrollment, message classification policy,
conversation history, memory format, prefix formatting and Ghostget/Linq access.
Agentrouter owns the execution seam. The model cannot choose a workspace or contact
in broker input. `WorkspaceFiles` and `PublicWeb` are trusted host ports. Textbutler supplies its confined file implementation and uses `createPublicWeb()` by default. Custom replacements must preserve file confinement and public-network policy across DNS and every redirect. URL syntax validation alone is insufficient. The supplied web client admits public unicast addresses, rejects mixed public/private DNS answers, pins the selected address while preserving TLS hostname verification, and validates each redirect anew. It fetches bounded UTF-8 text only; it does not carry account cookies or authorization headers.

Messaging ports only stage proposed actions and return an intent ID. They must never
submit a message during composition. The application must recheck current enrollment, exact recipient/message ownership,
capability support, idempotency and authorization at its final dispatch boundary.
It must add the configured butler envelope itself. Arbitrary rich payloads,
stickers and mini apps are not admitted until a transport contract proves support.

The web client refuses ambient proxy environment variables because Bun can route
HTTPS through them despite a disabled connection pool. Its 16 KiB header limit
applies to accepted headers; Bun buffers headers before that check. The local TLS
fixture proves address pinning and certificate/hostname enforcement under Bun
1.3.14. A bounded live GET to `https://example.com/` also passed on 2026-09-11
(559 bytes with the expected page title). Tests generate their own temporary
certificate with OpenSSL and remove it afterward.

Accounts are opaque host bindings. Keep provider authentication and native runtime
state out of contact folders. Do not copy credentials into a second app or let a
contact edit provider configuration. One shared lease database can coordinate
applications only when all of them use its custody contract; this package does
not alter an existing application's running sessions or account authority.

Lease expiry indicates a missed heartbeat and never authorizes takeover. A failed
or ambiguous adapter call retains its lease. Recovery needs independent proof that
the old process/controller stopped, followed by an exact generation-conditional
release. `AbortSignal` alone does not prove process exit. A successful adapter result
must assert `processStopped: true` only after obtaining that evidence.

The current AI Charts CLI collects usage and does not execute agents, so its likely
future shared interface is sanitized usage/account metadata, not this execution
port. Account sign-in and product-provider terms need separate qualification;
[Anthropic's SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) directs
third-party product integrations to supported API authentication unless approved.

`createCodexTaskAdapter()` is the relay-backed task adapter for application
capability profiles. It requires a host `CodexResponsesUpstream`; selecting a
subscription route does not provide subscription authentication. It maps the
exact `CapabilityBroker` inventory into one Codex session, passes only host-supplied instructions and task settings, and
retains the process receipt until `AgentRouter.runTask()` has joined the adapter
stop and broker close. Constructing the adapter does not discover credentials,
select an account, or qualify the installed native runtime; those remain explicit
host and qualification inputs.

Each admitted execution owns its stop receipt. A busy adapter returns a failed
completion for the new request without stopping the active account. Stop requests
must match the original execution; the same or a shorter cleanup deadline is accepted.
Failures before session startup carry explicit no-session evidence. Once startup
begins, an uncertain launch or missing process-stop receipt retains account custody.

The task runtime acquires one account lease and includes its immutable
`accountLease` snapshot in the execution request. Completion and stop evidence
must match its provider, account, owner, generation and expiry. Managed adapters
and sessions also require runtime provenance through `assertAgentTaskAccountLease()`:
copying a request must preserve the original lease object and `signal`, with all
other request values unchanged. Only stop may narrow the cleanup deadline.
Reconstructing the lease from its values does not grant admission. The runtime
retires this authority when the run settles, even if uncertain cleanup retains
the account lease. A managed launcher receives that same lease and must preserve
the separate native account-lock and process-generation checks.

Task run and cleanup allowances share the task runtime's one-hour ceiling;
the legacy contact session keeps its 120-second run and 10-second cleanup limits.
IO, request-count and byte limits remain bounded separately. Unsupported task
budgets fail before session startup. Cleanup is still joined even when late;
`runTask()` reports a missed cleanup deadline instead of claiming timely closure.

Non-null reasoning effort and service tier are sent as explicit turn overrides.
The relay requires those exact selections in the model request, including when
reasoning is absent. Null settings leave the native defaults in place. Generic
task effort names follow the pinned protocol's bounded string contract, including
`ultra`; the older six-tool driver keeps its existing effort inventory.

`createCodexManagedTaskAdapter()` adds an experimental task transport for the
official Codex app-server's managed ChatGPT authentication. The host must supply
a `CodexManagedProcessLauncher` that owns the native process and keeps its
authentication state outside application workspaces. Codex owns sign-in, token
refresh and provider traffic. This adapter has no API upstream or token input.
The launcher receives the original
runtime request, including its original signal and account lease, plus a separate
`cancellationSignal`. It must revalidate request authority before preparation and
native launch; the mirrored IDs and lease grant no separate authority.

`createCodexManagedProcessLauncher()` in `src/codex-managed-process.ts` supplies
internal process candidates. Its trusted admission maps the adapter runtime
identity to native executable, schema and parent-runtime hashes. The existing
`managed-task-offline-candidate-v1` profile remains byte-for-byte unchanged and
cannot perform provider turns. Missing profile selection is refused.

The separate `managed-task-provider-tcp443-dns-candidate-v1` selection appends
only outbound access to the system resolver socket and TCP port 443, plus
metadata access to `/var` for resolver path traversal. It grants general TCP
443 access, including local or private destinations; it enforces neither TLS
nor a hostname allowlist. Native Codex remains responsible for authenticating
its provider connection. Model-requested public web access still uses the
separate bounded host broker. No additional file contents, Mach services,
listeners, forks or model tools are admitted by this profile.

Profile selection is copied before asynchronous work, and custody receipts
retain its exact tag and generated policy digest. The provider candidate records
`general-tcp443-system-resolver-var-metadata-candidate`; both candidates retain
`productionQualified: false`. Account device-code admission does not authorize
task networking. These candidates remain absent from the public barrel and
default host, and neither matching pins nor successful sign-in creates task
qualification. Native provider transport is still unproven, including the
unresolved account login request-send failure. Activation requires separate
evidence for authenticated turns, effective tool inventory, filesystem isolation
and cleanup using the exact selected task profile.

The host must first close and join account controls, then let `runAgentTask`
acquire its account lease. The process owner uses that exact lease and the
existing account marker, fixed configuration and `active.json` lock under the
same private account state root. It neither creates an account nor acquires a
second lease. Each run gets a verified immutable executable snapshot, empty
scratch HOME and cwd, closed environment and durable custody journal. Persistent
Codex state survives cleanup; contact files remain available only through the
host broker. Missing or changed configuration is preserved and refused.

Cancellation and the original execution deadline initiate joined cleanup.
An uncertain launch, process group or descriptor close retains custody. Cleanup
never signals a numeric process group after its root has been observed exiting.
The first cleanup deadline is retained across retries; later observed closure
may complete cleanup without granting another native wait budget. Filesystem
sync and removal can outlast that deadline, so the retained cleanup promise
must still join before any lease release. Receipt hash fields remain empty
until the corresponding snapshots are completed. These synthetic
custody checks do not prove native tool inventory or auth-home confinement.

`runCodexManagedOfflineDiagnostic()` in the same internal module exercises the
shared process owner without fabricating task qualification. Its separate
`managed-offline-lifecycle-diagnostic-v1` admission binds declared native, schema
and parent-runtime hashes. Each call creates a fresh synthetic account in a
private child directory and acquires real SQLite leases. The offline account
helper initializes that empty home, sends no RPC, and joins before releasing its
lease. A second lease then owns the same managed process core used by tasks.
The diagnostic sends only `initialize`, `initialized` and `config/read`, checks
the fixed baseline projection and disabled remote-control notice, and closes.
It accepts no account, model, prompt, configuration map or RPC selection and
returns no process, stream, credential or task-admission authority.

One captured 60-second deadline bounds admission and native waits across both
processes; the last 15 seconds are reserved for cleanup. Filesystem cleanup may
outlast that deadline, with its raw promise still owned. Timeouts never prove closure.
Unjoined cleanup retains the actual process owners, open lease database and
journal in memory, with durable custody evidence in the returned private root.
The diagnostic does not automatically retry, release expired custody or remove
that state. Both native processes, their streams and protocol writes must join
before lease release. Journal and database closure precede a successful returned
or on-disk receipt. Its separate receipt always reports
`productionQualified: false` and `network: "denied"`; it supplies lifecycle and
configuration observations, not task execution, model-tool or auth-home isolation
qualification. It is absent from default wiring and the public barrel.

Account helpers and managed tasks share one fixed persistent configuration from
`codex-managed-baseline.ts`. Its version-one bytes remain unchanged across tasks;
the native owner must refuse a different existing file instead of overwriting it.
The task session sends its selected model, service tier and instructions through
dedicated `thread/start` fields. A closed, host-generated `config` overlay keeps
all task capability denials and supplies a non-null reasoning effort. It accepts
no caller configuration map. Non-null effort and tier also use explicit turn
overrides; null values leave native defaults in place.

The adapter defaults to unqualified. `AgentRouter.runTask()` refuses it before
account acquisition or process launch unless the trusted host supplies current
qualification for the exact route, runtime and capability profile. Direct
adapter calls also require qualification and a runtime-admitted request. Synthetic fixtures are not
qualification evidence and do not enable the route in Textbutler or another app.

The managed session checks ChatGPT account type, the public baseline configuration
projection and native thread settings before sending the task. `config/read`
precedes the thread overlay and does not prove the requested task selections.
Those selections must match `ThreadStartResponse` before `turn/start`; a mismatch
stops the session. The requested capability flags still require separate effective
tool-inventory evidence. Its bounded callback ledger binds tool starts, broker calls,
results and completions to one thread and turn, rejects duplicates and unsupported
native operations, and records native token usage with unknown monetary cost.
A turn-start settings notification is accepted only while that start request is
pending and must match the admitted thread controls. Repeated notifications must
be identical and remain bounded; resolved defaults are recorded only after the
matching reply, without changing the requested settings.
Cancellation revokes the broker and joins the process and admitted handlers;
uncertain stop evidence retains account custody.

An observed ChatGPT account does not distinguish native-managed storage from
externally supplied tokens. The trusted launcher must establish the authentication
mode and configuration isolation independently. Likewise, dynamic tools add a
broker surface; they do not prove that built-in tools are absent. Callback
filtering cannot prevent an unobserved built-in operation. Session receipts
therefore report `productionQualified: false` and
`exactToolInventoryObserved: false`. Live activation still requires evidence of
the effective tool inventory and host read/write confinement. The existing
relay-only process launcher's network policy is unchanged.

On 2026-09-13, Codex **0.154.0-alpha.6.2** accepted the initial managed configuration
and an empty ephemeral thread in separate native diagnostics with fresh private
state and network access denied. Configuration and thread-setting readback
passed, and root exit, process-group absence and stdio closure were verified.
The diagnostics made no account, login or turn requests. They establish
configuration and thread-response compatibility for that binary, not
authenticated execution or tool confinement.
Those diagnostics predate the shared-baseline task overlay. The combined path
still requires native validation against the exact admitted runtime.

`codexManagedStaticCatalog({ model, catalog })` prepares a single-model static
catalog for a trusted native host. Supply public `ModelsResponse` metadata for
the exact runtime and select an exact model slug. The helper refuses duplicate
slugs, missing models and non-JSON values, then returns a deeply immutable
snapshot, canonical JSON and its SHA-256. It preserves the selected model's
protocol and capability metadata while selecting direct tools and disabling
shell, patch, experimental tools, search, experimental context, subagents and
Node REPL. It performs no discovery, authentication or file I/O.

The host owns the catalog file outside model-writable workspaces and binds its
digest to the selected executable, configuration and exact model. The catalog
alone does not establish the effective tool inventory: native extensions can
register additional handlers. Managed configuration separately disables context,
token-budget/history, time, deferred-execution and permission-request tools, and
both subagent switches. These declarative controls remain subject to exact-build
native validation and do not activate the managed subscription route.

With a fixed `gpt-6-astra` catalog, local scripted-provider diagnostics on the
same binary verified empty and one-tool manifests in every request's Responses
Lite `additional_tools` input prefix. One permitted callback returned its exact
text result; nine forged built-in function calls each returned the exact
unsupported-call response. Native process, stdio and listener joins passed, and
an independent audit matched the retained binary, catalog, configuration and
wire evidence. These no-authentication diagnostics leave managed sign-in,
provider egress and production profile qualification outstanding.
