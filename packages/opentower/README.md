# 🏮 opentower

OpenCode plugin: receive GitHub webhooks (or Cloudflare-forwarded GitHub notification emails) and dispatch them to OpenCode agent sessions running in the same process.

When a configured webhook arrives, the plugin verifies the HMAC signature, deduplicates by delivery id, applies the self-loop guard (`ignore_authors`), renders a prompt template against the payload, and starts a new OpenCode agent session via the in-process SDK client.

Two ingest sources are supported:

- **`source: "github_webhook"`** (default) — classic GitHub webhook deliveries to `POST /webhooks/github`. Standard event/action matching against `X-GitHub-Event`.
- **`source: "email"`** — GitHub notification emails relayed by a Cloudflare Email Worker. The worker forwards a small JSON event (the headers we care about — `from`, `to`, `subject`, `message_id`, `in_reply_to`, `references`, `list_id`, `x_github_reason`, `x_github_sender`) to `POST /webhooks/email`. The plugin identifies the referenced issue/PR from `message_id`/`in_reply_to`/`references`, fetches canonical state from the GitHub API via `gh`, and dispatches the synthesized payload — same shape an actual webhook would produce, so existing agents work unchanged.

> **Runtime: Bun ≥ 1.2.** Uses `Bun.serve`, `Bun.spawn`, and `bun:sqlite`. Hono for HTTP routing; optional `@sentry/bun` for error tracking.

## Install

Once published to npm, add the package name to your OpenCode config's `plugin` array — OpenCode will install it into `~/.cache/opencode/node_modules/` automatically at startup:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opentower"
  ]
}
```

> Until the package is published to npm, install it manually: add `"opentower": "file:/path/to/this/repo/packages/opentower"` to a `package.json` in your OpenCode config directory (`~/.config/opencode/package.json`), run `bun install` there, and reference the resolved path:
>
> ```jsonc
> {
>   "plugin": [
>     "file:///home/<user>/.config/opencode/node_modules/opentower"
>   ]
> }
> ```

## Configure

The plugin reads `opentower.config.json` from `~/.config/opencode/opentower.config.json` by default. Override with the `OPENTOWER_CONFIG` env var.

Minimal config:

```jsonc
{
  "max_concurrent": 2,
  "timeout_ms": 1800000,
  "retention": 1000,
  "triggers": [
    {
      "name": "github-event",
      "event": ["issues", "pull_request"],
      "agent": "jared",
      "prompt_template": "Event: {{ event }}\nAction: {{ action }}\n\nPayload:\n{{ payload }}"
    }
  ]
}
```

### Top-level fields

| Field | Default | Description |
|---|---|---|
| `port` | `5050` (or `WEBHOOK_PORT`) | TCP port for the listener. |
| `secret` | `GITHUB_WEBHOOK_SECRET` env | GitHub HMAC secret. Without it, `/webhooks/github` rejects every delivery with 503. |
| `email_secret` | `EMAIL_WEBHOOK_SECRET` env | Shared HMAC secret with the Cloudflare email worker. Without it, `/webhooks/email` rejects every delivery with 503. Only required if you have at least one `source: "email"` trigger. |
| `email_allowed_senders` | `[]` | Defense-in-depth re-check of the email worker's `ALLOWED_SENDERS` list. Array of exact strings (case-insensitive) or `/regex/` patterns, e.g. `["notifications@github.com", "/^.*@github\\.com$/"]`. When non-empty, the email handler rejects requests whose JSON `from` field doesn't match. |
| `timeout_ms` | `1800000` (30 min) | Per-session abort budget. |
| `max_concurrent` | `2` | Concurrency cap across all triggers. |
| `default_cwd` | OpenCode project root | Fallback session cwd when a trigger doesn't override. |
| `allowed_orgs` | `[]` | Repository allowlist by owner. When `allowed_orgs`/`allowed_repos` are both empty, all repos are allowed. When either is set, an event is only dispatched if its repo's owner is listed here. Case-insensitive. Applies to all sources (`github_webhook`, `github_app`, `email`). |
| `allowed_repos` | `[]` | Repository allowlist by full name (`owner/repo`, exact match, case-insensitive). Combined with `allowed_orgs` (OR). When the allowlist is configured and no repo can be resolved from an event, it is skipped (fail-closed) with reason `repo_not_allowed`. |
| `db_path` | `${XDG_DATA_HOME or ~/.local/share}/opentower/deliveries.sqlite` | SQLite path for delivery dedup. |
| `retention` | `1000` | Max deliveries kept in dedup DB; oldest pruned. |
| `batch_window_ms` | `5000` | How long to wait for additional events before flushing the pipeline queue as a batched follow-up prompt. Allows coalescing rapid-fire events (e.g. CI failure + review comment) into a single prompt. |
| `triggers` | `[]` | Array of trigger objects (see below). |

### Trigger fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique per-config; used in logs. |
| `source` | no | `"github_webhook"` (default) or `"email"`. Selects which listener path the trigger fires from. |
| `event` | yes | For `source=github_webhook`: GitHub event header (`issues`, `pull_request`, `*` for any). For `source=email`: synthetic event of the form `email.<reason>` where `<reason>` is the `X-GitHub-Reason` header value (lowercased), e.g. `email.mention`, `email.review_requested`, `email.assign`, `email.comment`. Accepts a single string or an array of strings (OR-matched). Supports trailing wildcards (e.g. `email.*`). |
| `action` | no | If set, must match `payload.action` exactly. Omit/`null` = any action. Email triggers always have `action=null`. |
| `agent` | yes | OpenCode agent name to invoke. |
| `prompt_template` | yes | Mustache-ish template. `{{ payload.foo.bar }}` looks up paths; missing renders empty. |
| `cwd` | no | Override session cwd. Falls back to `default_cwd`. |
| `enabled` | no | Set `false` to disable a trigger without removing it. |
| `ignore_authors` | no | Skip if `payload.sender.login` matches any entry (case-insensitive). The literal `"$BOT_LOGIN"` is substituted with the resolved bot login. |

## Bot identity

The plugin resolves "the bot" via `gh api user --jq .login` at boot. `gh` reads `GH_TOKEN` from the environment. The resolved login is used for:

- The `"$BOT_LOGIN"` placeholder substitution in `ignore_authors` (self-loop prevention).

If `gh` isn't installed or `GH_TOKEN` isn't set, the `$BOT_LOGIN` placeholder is silently dropped — the self-loop guard is degraded but triggers still fire.

> **Soft dependency.** `gh` is the GitHub CLI: <https://cli.github.com>. Install it on the host running OpenCode.

## Environment variables

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `X-Hub-Signature-256` verification on `/webhooks/github`. Same value you set in GitHub's webhook config. |
| `EMAIL_WEBHOOK_SECRET` | Shared HMAC secret with the Cloudflare email worker, verified against `X-Email-Signature-256` on `/webhooks/email`. |
| `GH_TOKEN` | GitHub PAT, read by `gh` CLI for `gh api user` (bot identity for `$BOT_LOGIN` substitution) and for synthesizing email payloads via `gh api`. Required for self-loop prevention and all email triggers. |
| `WEBHOOK_PORT` | Override listener port (default 5050). |
| `OPENTOWER_API_TOKEN` | Bearer token gating the dashboard JSON API (`/api/*`) **and** the MCP endpoint (`/mcp`). When unset, both reject with 503 (the `/mcp` endpoint is not mounted at all). |
| `OPENTOWER_CORS_ORIGIN` | Allowed CORS origin for browser clients (e.g. a dev dashboard). Also used to validate the `Origin` header on `/mcp`. Set to `*` to allow all (not recommended in production). |
| `OPENTOWER_CONFIG` | Path to `opentower.config.json` (default `~/.config/opencode/opentower.config.json`). |
| `SENTRY_DSN` | Sentry DSN for error tracking. If set, `Sentry.init()` is called at plugin startup and unhandled rejections are captured. |
| `SENTRY_TRACES_SAMPLE_RATE` | Fraction of requests traced (0.0–1.0). Default 0.1. Set to 1.0 for debugging, 0 to disable tracing. |

## Health check

```
GET /healthz → 200 { ok: true, plugin: "opentower" }
```

## Webhook endpoints

### `POST /webhooks/github`

Required headers:

- `X-GitHub-Event` — event name (e.g. `issues`).
- `X-GitHub-Delivery` — UUID for dedup.
- `X-Hub-Signature-256` — `sha256=<hex>` HMAC of the raw body using `GITHUB_WEBHOOK_SECRET`.

Body: GitHub event JSON.

### `POST /webhooks/email`

Posted by the Cloudflare email worker.

- Header `X-Email-Signature-256` — `sha256=<hex>` HMAC of the raw body using `EMAIL_WEBHOOK_SECRET`.
- `Content-Type: application/json`.

Body: a small JSON event with the headers the plugin actually uses:

```json
{
  "from": "notifications@github.com",
  "to": "gh@yourdomain.com",
  "subject": "Re: [owner/repo] feat: ...",
  "message_id": "<owner/repo/pull/12@github.com>",
  "in_reply_to": "<owner/repo/pull/12@github.com>",
  "references": ["<...>", "<...>"],
  "list_id": "<repo.owner.github.com>",
  "x_github_reason": "mention",
  "x_github_sender": "octocat"
}
```

The body of the email itself is never sent — canonical state for the referenced issue/PR/comment is fetched from the GitHub API via `gh`. Eliminates prompt-injection from email content.

Both endpoints return 200 on accept (including drops/duplicates with a `dropped` or `duplicate` field), 400 on a malformed event body, 401 on bad signature, 403 on email allowlist mismatch, 404 on path mismatch, 413 on oversized body, 503 if the corresponding secret is unconfigured.

## MCP endpoint

### `ALL /mcp`

An authenticated [Model Context Protocol](https://modelcontextprotocol.io) endpoint (Streamable HTTP transport) that lets a remote client — e.g. your local machine — start agent sessions in this outpost. It is only mounted when `OPENTOWER_API_TOKEN` is set.

Auth and safety:

- **Bearer auth** — send `Authorization: Bearer $OPENTOWER_API_TOKEN` (the same token as `/api/*`). Missing/invalid token → 401.
- **Origin validation** — requests with an `Origin` header must match `OPENTOWER_CORS_ORIGIN` (or be localhost); requests without an `Origin` (native MCP clients, curl) are allowed and rely on the bearer token. Mismatch → 403.

Add it to an MCP client like any remote server:

```jsonc
{
  "mcpServers": {
    "outpost": {
      "url": "https://your-outpost.example.com/mcp",
      "headers": { "Authorization": "Bearer <OPENTOWER_API_TOKEN>" }
    }
  }
}
```

Tools:

| Tool | Arguments | Description |
|---|---|---|
| `start_agent_session` | `prompt` (string, required), `repo` (`owner/repo`, required), `branch` (string, optional), `agent` (string, optional — defaults to the configured default agent) | Starts a remote OpenCode agent session. Fire-and-forget: dispatched through the pipeline (so `max_concurrent`, dispatch audit rows, and Sentry spans stay consistent) and returns a `delivery_id` immediately. The session starts in `~/dev/<owner>/<repo>`; the agent's repo-setup skill handles the clone/fetch and per-branch worktree. |

## Limitations

- Single-process plugin; shares the OpenCode server's process. An unhandled rejection inside the dispatcher could crash the host server. The plugin installs a top-level `unhandledRejection` handler, but consumers should still pin OpenCode versions.
- Every matching enabled trigger fires per delivery — there's no first-match-only mode. Use `enabled: false` or tighter filters to suppress overlap.
- No built-in rate limiting beyond `max_concurrent`. A burst of 200 deliveries in a second will queue at the semaphore but not be dropped.
- `bun:sqlite` is required for delivery dedup. The plugin won't run on Node.
- Email ingestion only covers what GitHub already sends to your inbox: mentions, review requests, assignments, comments on PRs/issues you're involved in. It is not a substitute for `push` / `check_suite` / `release` events — those still need a real GitHub webhook (or App).

## License

MIT — see [LICENSE](./LICENSE).
