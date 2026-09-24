# AI subscriptions through xcb

Textbutler uses [xcb (Excalibur)](https://github.com/hraness/xcb) to draft replies
through an explicitly connected Claude Code or Codex subscription. xcb owns
provider sign-in, runtime admission, operating-system confinement and account
custody. Textbutler owns contact context, response policy and every message send.
Textbutler is an MIT-licensed reference application for this separation.

The connection requires a verified Textbutler bundle with reviewed composition
admission and an xcb build with the native `generate` command. A source daemon
has no embedded Textbutler admission and keeps subscription inference unavailable.
A configured path, matching executable hash or signed-in account alone does not
establish readiness. Check the exact provider through Textbutler and verify the
selected messaging account before enabling replies. Synthetic tests do not
prove live inference, delivery or unattended operation on another installation.

## Connect an account

Install xcb and connect the subscription account using its
[native setup guide](https://github.com/hraness/xcb#native-xcb). xcb keeps its own
private state; the native default is `~/.local/share/xcb`. Copy the exact account
ID and full observed model key from `xcb accounts` and `xcb models`.

Build and install Textbutler with `bun run textbutler:install`. Start its daemon
through the installed command for AI replies. The build refuses absent or stale
composition evidence; source startup cannot waive that check.

Stop the Textbutler daemon before changing host configuration. Supply physical
absolute paths and replace the example account and model with your observations:

```sh
bun run textbutler setup \
  --xcb /absolute/path/to/xcb \
  --xcb-state /absolute/path/to/xcb-state \
  --xcb-account claude:ACCOUNT_ID \
  --xcb-model FULL_MODEL_KEY
```

Repeat setup with `--xcb-account codex:ACCOUNT_ID` or `--xcb-account devin:ACCOUNT_ID`
and the matching full model key to add a Codex or Devin account; one account per
provider. Setup records the xcb executable's SHA-256 and the explicit
account/model binding. It does not copy subscription credentials, create a
provider sign-in or enable a contact. Restart the installed daemon, run `providers list`,
and use the returned Textbutler account ID with `providers check ACCOUNT_ID`.
This reads current xcb capabilities and admission; it does not make a model turn
or prove reply quality. An unsent suggestion is the next inference check.

Setup preserves existing bindings and refuses a changed executable, hash, state
root, account or model. After upgrading xcb, stop the daemon and review the
private `state/host.json` xcb binding before updating its executable digest.
Retain account and custody state, then restart and check the account again.

Native subscription routing never substitutes Claude API or another account.
An unavailable, busy, stale or unsettled route remains unavailable until its
specific condition is resolved. See [getting started](getting-started.md) for
contact selection, reply review and explicit activation.

## The application boundary

Each inference step invokes the pinned native `xcb generate` process with a
bounded JSON request on stdin. Private prompt content does not enter command
arguments. This application command supplies no provider tools, workspace
access, inherited coding session or executable hooks. Textbutler does not invoke
`xcb run`, which is the workspace-oriented coding interface.

The model returns a final JSON result or a proposal naming one advertised
Textbutler operation. The contact-scoped broker validates proposals and performs
only admitted operations: conditional contact-memory edits, bounded public web
reads and staged reply actions. Classification advertises no operations. The
provider cannot choose another contact, file root, recipient or credential.

The next step contains only the bounded operation history Textbutler supplies.
The native step loop permits at most 16 steps, 12 operations, 512 KiB of prompt,
256 KiB per step and 1 MiB of transcript. Exceeding a bound stops the run. Failed
operations are not replayed because an effect may already have committed.

A proposed message never sends itself. Trusted Textbutler code applies
disclosure, human takeover, current enrollment, review or automation authority,
idempotency and the durable send journal immediately before dispatch.

## Custody and recovery

xcb retains subscription credentials and provider state outside Textbutler's
contact folders. It serializes use of an account and releases custody only after
its provider process and controllers have joined. Textbutler validates the
generation result and its settlement facts before accepting output. Cancelling
a request or observing the xcb parent exit alone does not prove provider cleanup.

Textbutler also preserves an uncertain application invocation for recovery.
Restarting, reinstalling or repeating setup must not clear that record. Inspect
the exact xcb run and Textbutler diagnostic before recovery; never delete
custody state simply to make the account appear ready.

## Evidence and distribution

The local Textbutler bundle contains its application code and pinned library
dependencies. Its build validates a separately reviewed composition receipt
against the exact source inventory and both contact capability profiles, then
embeds that admission. Missing evidence or source/profile drift rejects the
build; hashes and xcb sign-in cannot create this evidence. xcb and provider executables are installed separately. Its
`external-xcb` manifest value identifies this connection capability; it is not
a provider qualification, a signed release or a live messaging receipt.

xcb independently checks the selected provider's exact runtime and confinement
on each invocation. Its provider-specific readiness may differ by build and
host; consult the [xcb readiness table](https://github.com/hraness/xcb#readiness).
Textbutler must also prove its classifier/reply parsing, cancellation and broker
boundaries. Before relying on automatic replies, exercise one agreed recipient,
pause, owner takeover, transport loss, restart and grant expiry. The
[readiness page](readiness.md) separates these acceptance requirements from
source tests. The separately billed Claude API route retains its own trusted
runtime admission requirement in [provider setup](../../packages/textbutler/PROVIDERS.md).
