# Cobalt CLI

The official open-source command-line client for Cobalt. It talks only to the versioned Cobalt External API and is distributed as a normal npm package—there are no platform executables.

Website: [cobaltcode.ai](https://cobaltcode.ai) · Built by [Amaretto Software Labs](https://amarettosoftware.com)

## Install

Node.js 22 or newer is required.

```bash
npx @amaretto-software-labs/cobalt-cli --help
npm install --global @amaretto-software-labs/cobalt-cli
cobalt auth login
```

OAuth sessions are stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Credential storage fails closed; the CLI never falls back to a plaintext token file. For automation, provide one scoped token through `COBALT_TOKEN`.

If browser sign-in fails or you cancel consent, keep the CLI running. The branded
recovery page offers **Try again** and **Use another account** (which signs out of
the web app before returning to sign-in). You can also press **Enter** in an
interactive terminal to start a fresh attempt, or open the recovery URL printed
by the CLI if you closed the browser. Each attempt uses new OAuth state and PKCE
values. Attempts time out after five minutes; the retry page remains available
for another ten minutes. **Ctrl+C** stops login and closes the local listener.
The success page is shown only after credentials are validated and securely saved.

## Quick start

```bash
cobalt auth login
cobalt workspace list
cobalt workspace use "My Workspace"
cobalt repo list --eligible-only
cobalt agent list --available

cobalt task create \
  --repo my-repository \
  --message "Fix the failing tests and open a PR"

cobalt task list --created-by-me
cobalt task follow <task-id> --jsonl
```

Environments are selected with `--environment prod|dev|demo|local` or `COBALT_ENVIRONMENT`. Select a workspace with `--workspace`, `COBALT_WORKSPACE`, or the saved per-environment workspace context.

The `local` environment targets the standard Cobalt Aspire endpoints (`https://localhost:7295/v1`, `https://localhost:7270`, and `https://localhost:7250`) and reuses the development OAuth client registration. It adds the operating-system trust store to Node's default roots when the runtime supports that API. On older Node 22 builds, use `NODE_OPTIONS=--use-system-ca` after trusting the ASP.NET Core development certificate. Certificate verification remains enabled.

## Commands

```text
auth login|logout|status
workspace list|use|current
repo list
agent list
task list|get|search|create|messages|message-search|events
task send|steer|cancel|suspend|resume|auto-wake|delete|wait|follow|open
task queue list|hold|release|cancel|retry|move
loop list|get|create|update|enable|disable|delete|run|rerun
loop runs|decisions|lanes|descriptors|preview
role list|get|create|update|delete
interactive
completion bash|zsh|fish|powershell
version
```

All mutations accept `--idempotency-key <uuid>`. Message input uses exactly one of `--message`, `--message-file`, or `--stdin`. Output defaults to human-readable text; use `--json` for one envelope or `--jsonl` for streams and pagination.

Interactive mode retains an ambiguous mutation's idempotency key and directs you to `/retry`, which safely replays the same operation with that key. Read-only inspection remains available, while another mutation or context change waits for the replay.

Exit codes are stable: `0` success, `2` usage, `3` authentication, `4` authorization, `5` not found, `6` conflict, `7` rate limited, `8` unavailable, `9` admission, `10` configuration, and `130` interrupted.

## Loops and worker roles

Read the current definition before replacing it. Updates require its observed
version/revision and one complete file; creates start no work. Enabling a Loop
authorizes its future unattended runs as your current identity.

```bash
cobalt loop list --all
cobalt loop get <loop-id> --json
cobalt loop update <loop-id> --document-file review.md --expected-version 7
cobalt loop enable <loop-id> --expected-version 8
cobalt loop runs <loop-id> --all
cobalt loop descriptors --json

cobalt role list --all
cobalt role get pr-reviewer --json
cobalt role update pr-reviewer --name "PR Reviewer" --description "Review PRs" \
  --instructions-file reviewer.md --expected-revision 2

cobalt task create --repo <repository-id> --pull-request 184 \
  --title "[PR Review 184] Review current revision" --retention persistent \
  --default-role pr-reviewer --role pr-reviewer --no-auto-wake \
  --computer-idle-policy suspend_after_turn --message "Review the exact head/base."
cobalt task send <task-id> --role pr-reviewer --message "Review the next revision."
cobalt task auto-wake <task-id> off
```

Task creation supports `--on-hold`; inspect and release admission through
`cobalt task queue`. Role selection belongs to task creation or message send.
`task resume` restores compute and does not accept a role. Auto-wake controls
generic environment restoration on resume; it is separate from automatic
suspension after a turn. Server-side permissions, capacity, and immutable role
snapshots apply to every command.

## Reuse the branded OAuth callback in an MCP client

Desktop MCP clients can use the same renderer and response headers as the CLI:

```js
import {
  oauthCallbackResponseHeaders,
  renderOAuthCallbackPage,
} from "@amaretto-software-labs/cobalt-cli/oauth-callback";

// Only after the client's OAuth state/PKCE and token validation succeed:
response.writeHead(200, oauthCallbackResponseHeaders);
response.end(renderOAuthCallbackPage("success", undefined, "mcp"));
```

The shared renderer supports `success`, `cancelled`, `waiting`, `invalid`,
`timeout`, and `failed` states. The MCP variant directs the user back to their
desktop app. It performs no OAuth operations and never receives tokens or raw
provider error details. The client owns validation, token storage, and listener
cleanup. Pass a local retry path only when the client implements that route.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

[`openapi/v1.json`](openapi/v1.json) is the canonical Cobalt External API schema copied from the product repository. `pnpm openapi:check` fails if its 39 CLI operations drift from the client mapping. The five OAuth browser-session operations are accounted for separately because they belong to the browser extension.

## Releasing

The release workflow uses Node 24, pnpm 10.14.0, npm provenance, and npm trusted publishing through GitHub OIDC. Main-branch releases publish a generated `0.1.0-dev.<run>.<attempt>` version under the `dev` tag. Manual runs support `dev`, `demo`, and stable `prod` channels.

Create GitHub environments named `dev`, `demo`, and `prod` before enabling releases, and configure `prod` with required reviewers. Both package creation and publishing are bound to the selected environment so a production release cannot bypass its approval policy.

The package must exist before npm allows a trusted publisher to be configured. Bootstrap publishing once from an npm account protected by 2FA:

1. Run `pnpm verify`, then generate the chosen initial version with `COBALT_CLI_PACKAGE_VERSION=<version> pnpm pack:check`.
2. Authenticate with npm and run `npm publish release/npm/*.tgz --access public`, completing the 2FA prompt.
3. In the npm package settings, add the GitHub Actions trusted publisher for `Amaretto-Software-Labs/cobalt-cli` and workflow `release.yml`.
4. Set the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED` to `true`.

Until that variable is enabled, main pushes still run CI and build the release artifact, while the publish job is intentionally skipped.

## Security

Please report vulnerabilities privately through GitHub Security Advisories. Do not include access tokens, refresh tokens, task messages, or repository content in public issues.

## License

Apache-2.0.
