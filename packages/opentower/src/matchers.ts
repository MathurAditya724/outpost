// Per-trigger filters + the shared evaluate-and-dispatch loop used by
// both the GitHub and email handlers. The agent handles identity gates
// and payload filtering; the plugin only handles event matching,
// self-loop guard (ignore_authors), and dispatch via the pipeline.

import * as Sentry from "@sentry/bun"
import { extractEntityKey } from "./entity"
import type { EntityResolver } from "./entity-resolver"
import type { GitHubFetcher } from "./github-api"
import type { Pipeline } from "./pipeline"
import { lookupString, renderTemplate } from "./template"
import type { NormalizedTrigger, SkippedDispatch } from "./types"

// Normalized repository allowlist. Both lists hold lowercased entries.
// Empty lists mean "not configured" -> allow everything.
export type Allowlist = { orgs: string[]; repos: string[] }

// Decide whether an event for `repo` (in "owner/repo" form) is allowed.
// Fail-closed: when the allowlist is configured but no repo can be
// resolved, the event is rejected.
export function isRepoAllowed(repo: string | null, allowlist: Allowlist): boolean {
  if (allowlist.orgs.length === 0 && allowlist.repos.length === 0) return true
  if (!repo) return false
  const lc = repo.toLowerCase()
  if (allowlist.repos.includes(lc)) return true
  const owner = lc.split("/")[0]
  return owner.length > 0 && allowlist.orgs.includes(owner)
}

// Match an event pattern against an incoming event + action.
// Supported pattern forms:
//   "issues"                — matches event "issues" with any action
//   "workflow_run:completed" — matches event "workflow_run" only when action is "completed"
//   "email.*"               — prefix wildcard (matches "email.received", etc.)
//   "*"                     — matches everything
function eventMatches(pattern: string, event: string, action: string | null): boolean {
  if (pattern === "*") return true

  // "event:action" — per-event action filter
  const colon = pattern.indexOf(":")
  if (colon !== -1) {
    const evPart = pattern.slice(0, colon)
    const actPart = pattern.slice(colon + 1)
    return evPart === event && actPart === action
  }

  if (pattern === event) return true
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1)
    return event.startsWith(prefix)
  }
  return false
}

export function findMatching(triggers: NormalizedTrigger[], event: string, action: string | null): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.events.some((e) => eventMatches(e, event, action))
    if (!eventOk) return false
    return t.action === null || t.action === action
  })
}

export function evaluateIgnoreAuthors(ignoreAuthors: string[] | undefined, sender: string | null): string | null {
  if (!ignoreAuthors || ignoreAuthors.length === 0 || !sender) return null
  const lower = sender.toLowerCase()
  if (ignoreAuthors.some((a) => a.toLowerCase() === lower)) {
    return `ignored sender '${sender}'`
  }
  return null
}

export async function evaluateAndDispatch(opts: {
  triggers: NormalizedTrigger[]
  event: string
  action: string | null
  payload: unknown
  sender: string | null
  botLogin: string | null
  deliveryId: string
  templateContext: Record<string, unknown>
  pipeline: Pipeline
  entityResolver?: EntityResolver | null
  githubFetcher?: GitHubFetcher | null
  allowlist?: Allowlist
}): Promise<{ dispatched: string[]; skipped: SkippedDispatch[] }> {
  const dispatched: string[] = []
  const skipped: SkippedDispatch[] = []

  const entityKey = await extractEntityKey(opts.event, opts.payload, opts.entityResolver, opts.githubFetcher)

  const matched = findMatching(opts.triggers, opts.event, opts.action)
  if (matched.length === 0) {
    Sentry.logger.warn("trigger.no_match", {
      event: opts.event,
      action: opts.action,
      delivery_id: opts.deliveryId,
      trigger_count: opts.triggers.length,
    })
  }

  // Repository allowlist gate. Applies to every source. When configured
  // and the event's repo isn't allowed (or can't be resolved), skip all
  // matched triggers before any dispatch. Repo is taken from the resolved
  // entity key first, falling back to the raw payload for events that
  // don't map to a trackable entity.
  const allowlist = opts.allowlist
  if (allowlist && (allowlist.orgs.length > 0 || allowlist.repos.length > 0)) {
    const repo = entityKey?.repo ?? lookupString(opts.payload, "repository.full_name")
    if (!isRepoAllowed(repo, allowlist)) {
      for (const t of matched) {
        skipped.push({ name: t.name, reason: "repo_not_allowed" })
      }
      Sentry.logger.info("trigger.repo_not_allowed", {
        event: opts.event,
        action: opts.action,
        delivery_id: opts.deliveryId,
        repo: repo ?? "",
        matched_count: matched.length,
      })
      return { dispatched, skipped }
    }
  }

  for (const t of matched) {
    const reason = evaluateIgnoreAuthors(t.ignore_authors, opts.sender)
    if (reason) {
      skipped.push({ name: t.name, reason })
      Sentry.logger.info("trigger.skipped", {
        trigger_name: t.name,
        event: opts.event,
        reason,
        delivery_id: opts.deliveryId,
      })
      continue
    }

    const prompt = renderTemplate(t.prompt_template, opts.templateContext)

    if (entityKey) {
      opts.pipeline.dispatch(entityKey, t, prompt, opts.deliveryId, opts.event)
    } else {
      opts.pipeline.dispatchNoAffinity(t, prompt, opts.deliveryId, opts.event)
    }
    dispatched.push(t.name)
  }

  return { dispatched, skipped }
}
