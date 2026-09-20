# Set up an agent account

Textbutler keeps **Claude API**, **Claude Code** and **Codex** as separate account
choices. Claude Code and Codex use an explicitly configured
[xcb](https://github.com/hraness/xcb) native runtime. Selecting either never
borrows an API credential or starts separately billed API work. xcb owns
subscription sign-in, confinement and provider custody; Textbutler owns contact
policy and the broker that interprets operation proposals.

## Connect a subscription with xcb

Use a verified Textbutler bundle with reviewed composition admission and an
xcb build with native `generate` support. `bun run textbutler:install` validates
the recorded source/profile evidence before building; absent or stale evidence
blocks the build. Run its installed daemon for AI replies. A source daemon
remains unadmitted even when the xcb account is ready. Complete the selected provider's
sign-in and admission in xcb, then copy the exact account ID and full observed
model key from `xcb accounts` and `xcb models`. With Textbutler stopped, run:

```sh
bun run textbutler setup \
  --xcb /absolute/path/to/xcb \
  --xcb-state /absolute/path/to/xcb-state \
  --xcb-account claude:ACCOUNT_ID \
  --xcb-model FULL_MODEL_KEY
```

Use `codex:ACCOUNT_ID` for a Codex subscription. Setup pins the executable hash,
keeps credentials in xcb and preserves paused settings. After restarting the
installed daemon, run `providers list`, then `providers check TEXTBUTLER_ACCOUNT_ID` using
the listed ID. This reads xcb capabilities and admission without making a model
turn. Select that account for a contact after its readiness check succeeds, then
try an unsent suggestion. Contact enablement and global resume remain separate
owner actions. Setup preserves existing account/model and binary bindings;
changed bindings require review of private host configuration while stopped.

Account metadata and executable integrity do not prove live inference or message
delivery. Consult [the subscription contract](../../docs/textbutler/native-subscription.md)
for generation limits, custody, recovery and the exact-runtime acceptance
requirements. Textbutler's MIT source is the application example; each host
still supplies its own admitted xcb/provider installation.

## Claude API: separate trusted runtime required

The Claude API route uses a host-interpreted tool loop. It exposes contact files,
bounded public HTTPS reads and staged messaging intentions. It starts no agent
process, shell, plugin or provider-side tool. The classifier receives no tools.
The trusted packaged host must supply the reviewed compiled runtime identity;
`state/host.json` cannot supply or waive that identity. A source checkout reports
this route unavailable unless a trusted embedding integration supplies it.

### Configure the private API account reference

Under the Textbutler data directory, create `state/provider-credentials` as an
owner-only physical directory with mode `0700`. Put the chosen Anthropic API key
in one mode-`0600` regular file there, without links or executable permission.
Use the owner's secure editor or credential provisioning tool; do not put the
key in command arguments, shell history, contact memory or this repository.
The application does not search environment files, native agent homes or
subscription sessions for credentials.

Add an entry to `providerAccounts` in the existing mode-`0600` `state/host.json`.
The fields are:

| Field | Meaning |
| --- | --- |
| `id` | Stable local account ID, up to 80 letters, digits, `_` or `-`; start with a letter or digit. |
| `label` | The account name shown in the menu. |
| `route` | Exactly `claude-api`. |
| `credentialFile` | The filename inside `state/provider-credentials`, with no directory components. |
| `replyModel` | Exact model ID available to this account. |
| `prices.observedAt` | Time the owner verified the supplied prices, as Unix milliseconds. |
| `prices.models` | Rows with exact `id`, positive `inputUsdPerMillion`, positive `outputUsdPerMillion`, and boolean `classifierEligible`. |
| `maxBudgetUsd` | Optional conservative per-run reservation, default `0.25`, maximum `5`. This is not an invoice cap. |

Supply current prices from the provider's published pricing for the selected
models. Price observations expire after 30 days; no guessed or bundled price
table is used. Include the response model and at least one model eligible for
classification. Textbutler checks actual model access and structured-output
support, then chooses the lowest estimated classification cost for a
2,000-input / 128-output-token request. The response remains pinned to
`replyModel` unless the contact explicitly selects another available model.
At most eight owner-configured accounts are accepted. Restart the daemon after
changing host configuration.

### Check and select the API account

With the daemon running, run:

```sh
bun run textbutler providers list
bun run textbutler providers check ACCOUNT_ID
```

The check verifies the exact runtime and credential, and queries Anthropic's
Models API. It does not send a user prompt or make a paid model turn. A successful
check lists the response and classifier models; it does not enable any contact
or grant messaging authority. Select an account in the guided terminal, in the menu for a disabled contact,
or with `contacts account CONTACT ACCOUNT`. Enable the contact separately.
Source-mode setup cannot turn an unavailable engine into a qualified one. API usage is billed
separately from coding-agent subscriptions.

Model availability expires after 24 hours and is refreshed within the same
credential generation. If the credential file changes, existing account proof
is retired, affected work is cancelled, and another explicit provider check
is required before the replacement can be used. The menu shows only account
metadata, never key bytes or their private generation fingerprint. Shared
account leases serialize use; unrelated contacts cannot inspect credentials or
each other's folders.
