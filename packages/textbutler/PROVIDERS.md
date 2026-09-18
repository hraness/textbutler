# Set up an agent account

Textbutler keeps **Claude API**, **Claude Code** and **Codex** as separate account
choices. Selecting Claude Code or Codex never borrows an API credential or starts
separately billed API work. Native coding-agent choices currently report
unavailable while their execution confinement is being qualified.

The Claude API route uses a host-interpreted tool loop. It exposes contact files,
bounded public HTTPS reads and staged messaging intentions. It starts no agent
process, shell, plugin or provider-side tool. The classifier receives no tools.
The trusted packaged host must supply the reviewed compiled runtime identity;
`state/host.json` cannot supply or waive that identity. A source checkout reports
this route unavailable unless a trusted embedding integration supplies it.

## Configure the private account reference

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

## Check and select the account

With the daemon running, run:

```sh
bun run textbutler providers list
bun run textbutler providers check ACCOUNT_ID
```

The check verifies the exact runtime and credential, and queries Anthropic's
Models API. It does not send a user prompt or make a paid model turn. A successful
check lists the response and classifier models; it does not enable any contact
or grant messaging authority. Account selection and contact activation require an explicit owner control
client; they are not currently available in the menu. API usage is billed
separately from coding-agent subscriptions.

Model availability expires after 24 hours and is refreshed within the same
credential generation. If the credential file changes, existing account proof
is retired, affected work is cancelled, and another explicit provider check
is required before the replacement can be used. The menu shows only account
metadata, never key bytes or their private generation fingerprint. Shared
account leases serialize use; unrelated contacts cannot inspect credentials or
each other's folders.
