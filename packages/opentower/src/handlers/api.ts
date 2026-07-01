import type { Context } from "hono"
import type { AppEnv } from "../handler"
import type { Allowlist } from "../matchers"
import { DEFAULT_RETENTION_DAYS } from "../storage"

export function apiStatsHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  return c.json(store.getStats())
}

export function apiGetRetentionHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const days = store.getRetentionDays() ?? DEFAULT_RETENTION_DAYS
  return c.json({ retention_days: days })
}

export async function apiSetRetentionHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const body = await c.req.json<{ retention_days?: unknown }>().catch((): { retention_days?: unknown } => ({}))
  const days = Number(body.retention_days)
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return c.json({ error: "retention_days must be between 1 and 365" }, 400)
  }
  store.setRetentionDays(Math.floor(days))
  return c.json({ retention_days: Math.floor(days) })
}

export function apiPruneHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const days = store.getRetentionDays() ?? DEFAULT_RETENTION_DAYS
  const result = store.pruneOlderThan(days)
  return c.json({ pruned: result, retention_days: days })
}

export function apiEntitiesHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const raw = Number(c.req.query("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = c.req.query("cursor") || undefined
  const repo = c.req.query("repo") || undefined
  return c.json(store.listEntities({ limit, cursor, repo }))
}

export function apiEntityDetailHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const key = decodeURIComponent(c.req.param("key") ?? "")
  if (!key) return c.json({ error: "missing entity key" }, 400)
  const entity = store.getEntity(key)
  if (!entity) return c.json({ error: "entity not found" }, 404)
  const dispatches = store.getEntityDispatches(key)
  const links = store.getEntityLinks(key)
  return c.json({ entity, dispatches, links })
}

export function apiDispatchesHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const raw = Number(c.req.query("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = c.req.query("cursor") || undefined
  const status = c.req.query("status") || undefined
  const event = c.req.query("event") || undefined
  if (status && !["started", "completed", "failed", "timeout"].includes(status)) {
    return c.json({ error: `invalid status filter: ${status}` }, 400)
  }
  return c.json(store.listDispatches({ limit, cursor, status, event }))
}

// --- Allowlist management ---

// Factory that closes over the mutable allowlist and the config persistence
// callback so handlers can read/write the in-memory list and persist changes.
export function makeAllowlistHandlers(opts: {
  allowlist: Allowlist
  persistAllowlist: (orgs: string[], repos: string[]) => Promise<void>
}) {
  const { allowlist, persistAllowlist } = opts

  return {
    get(c: Context<AppEnv>) {
      return c.json({ allowed_orgs: allowlist.orgs, allowed_repos: allowlist.repos })
    },

    async set(c: Context<AppEnv>) {
      const body = await c.req
        .json<{ allowed_orgs?: unknown; allowed_repos?: unknown }>()
        .catch((): { allowed_orgs?: unknown; allowed_repos?: unknown } => ({}))

      const rawOrgs = body.allowed_orgs
      const rawRepos = body.allowed_repos

      if (rawOrgs !== undefined && !Array.isArray(rawOrgs)) {
        return c.json({ error: "allowed_orgs must be an array of strings" }, 400)
      }
      if (rawRepos !== undefined && !Array.isArray(rawRepos)) {
        return c.json({ error: "allowed_repos must be an array of strings" }, 400)
      }

      // Normalize: lowercase, trim, filter empty strings.
      const orgs =
        (rawOrgs as string[] | undefined)?.map((s) => String(s).toLowerCase().trim()).filter(Boolean) ?? allowlist.orgs
      const repos =
        (rawRepos as string[] | undefined)?.map((s) => String(s).toLowerCase().trim()).filter(Boolean) ??
        allowlist.repos

      // Update in-memory allowlist (same object reference used by matchers).
      allowlist.orgs = orgs
      allowlist.repos = repos

      await persistAllowlist(orgs, repos)

      return c.json({ allowed_orgs: allowlist.orgs, allowed_repos: allowlist.repos })
    },
  }
}
