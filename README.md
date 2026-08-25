# Cobalt CLI

The official open-source command-line client for [Cobalt](https://cobaltcode.ai). It talks only to the versioned Cobalt External API and is distributed as a normal npm package—there are no platform executables.

## Install

Node.js 22 or newer is required.

```bash
npx @amaretto-software-labs/cobalt-cli --help
npm install --global @amaretto-software-labs/cobalt-cli
cobalt auth login
```

OAuth sessions are stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Credential storage fails closed; the CLI never falls back to a plaintext token file. For automation, provide one scoped token through `COBALT_TOKEN`.

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

Environments are selected with `--environment prod|dev|demo` or `COBALT_ENVIRONMENT`. Select a workspace with `--workspace`, `COBALT_WORKSPACE`, or the saved per-environment workspace context.

## Commands

```text
auth login|logout|status
workspace list|use|current
repo list
agent list
task list|get|search|create|messages|message-search|events
task send|steer|cancel|suspend|resume|wait|follow|open
interactive
completion bash|zsh|fish|powershell
version
```

All mutations accept `--idempotency-key <uuid>`. Message input uses exactly one of `--message`, `--message-file`, or `--stdin`. Output defaults to human-readable text; use `--json` for one envelope or `--jsonl` for streams and pagination.

Interactive mode retains an ambiguous mutation's idempotency key and directs you to `/retry`, which safely replays the same operation with that key. Read-only inspection remains available, while another mutation or context change waits for the replay.

Exit codes are stable: `0` success, `2` usage, `3` authentication, `4` authorization, `5` not found, `6` conflict, `7` rate limited, `8` unavailable, `9` admission, `10` configuration, and `130` interrupted.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

[`openapi/v1.json`](openapi/v1.json) is the canonical Cobalt External API schema copied from the product repository. `pnpm openapi:check` fails if its 16-operation catalog drifts from the client mapping.

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
