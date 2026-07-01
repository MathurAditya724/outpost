// Shared types for the opentower plugin.

export type TriggerSource = "github_webhook" | "github_app" | "email" | "cron" | "mcp"

export type Trigger = {
  name: string
  source?: TriggerSource
  event: string | string[]
  action?: string | null
  agent: string
  prompt_template: string
  cwd?: string | null
  enabled?: boolean
  ignore_authors?: string[]
}

export type WebhookConfig = {
  port?: number
  secret?: string
  email_secret?: string
  timeout_ms?: number
  max_concurrent?: number
  batch_window_ms?: number
  default_cwd?: string
  triggers?: Trigger[]

  // Repository allowlist. When either list is non-empty, an event is only
  // dispatched if its repository matches. `allowed_repos` matches
  // "owner/repo" exactly; `allowed_orgs` matches the owner segment. Both
  // are case-insensitive. When both are empty/unset, all repos are allowed.
  // Applies to all event sources (github_webhook, github_app, email).
  allowed_orgs?: string[]
  allowed_repos?: string[]

  // Data retention in days. Dispatches and entities older than this are
  // pruned on startup and then periodically. Defaults to 30 days.
  retention_days?: number

  // GitHub App configuration (optional — enables the GitHub App handler)
  github_app?: GithubAppConfig
}

export type GithubAppConfig = {
  app_id: string
  private_key: string
  webhook_secret: string
}

export type NormalizedTrigger = Omit<Trigger, "action" | "enabled" | "source" | "event"> & {
  source: TriggerSource
  action: string | null
  enabled: boolean
  events: string[]
}

export type SkippedDispatch = {
  name: string
  reason: string
}
