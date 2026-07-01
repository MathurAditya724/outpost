// Hono app for the opentower HTTP listener. Routes: healthz, webhook
// ingest (delegated to WebhookHandlers), JSON API, and static
// dashboard serving. Per-route logic lives under ./handlers/.

import { createHmac, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { StreamableHTTPTransport } from "@hono/mcp"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as Sentry from "@sentry/bun"
import { type Context, Hono, type Next } from "hono"
import { serveStatic } from "hono/bun"
import { cors } from "hono/cors"
import type { CronScheduler } from "./cron"
import {
  apiDispatchesHandler,
  apiEntitiesHandler,
  apiEntityDetailHandler,
  apiGetRetentionHandler,
  apiPruneHandler,
  apiSetRetentionHandler,
  apiStatsHandler,
  makeAllowlistHandlers,
} from "./handlers/api"
import { makeCronHandlers } from "./handlers/cron"
import type { HandlerContext, WebhookHandler } from "./interfaces"
import { formatError, logger } from "./logger"
import type { Allowlist } from "./matchers"
import type { LifecycleStore } from "./storage"

export type AppEnv = {
  Variables: {
    store: LifecycleStore
  }
}

function safeTokenCompare(a: string, b: string): boolean {
  // HMAC-based comparison avoids leaking length information. Both
  // inputs are hashed to a fixed-size digest before comparing, so
  // the comparison is always constant-time regardless of input length.
  // Static key is intentional — the HMAC only serves to normalize both
  // inputs to fixed-length digests for timingSafeEqual.
  const key = Buffer.from("opentower-token-compare")
  const ha = createHmac("sha256", key).update(a).digest()
  const hb = createHmac("sha256", key).update(b).digest()
  return timingSafeEqual(ha, hb)
}

// Bearer-token auth shared by the JSON API and the MCP endpoint. Returns
// 503 when no token is configured, 401 on a missing/invalid token.
// `label` only customizes the "not configured" message.
function createBearerAuth(apiToken: string, label: string) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (!apiToken) {
      return c.json({ error: `${label} not configured (OPENTOWER_API_TOKEN not set)` }, 503)
    }
    const authHeader = c.req.header("authorization") ?? ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!token || !safeTokenCompare(token, apiToken)) {
      return c.json({ error: "unauthorized" }, 401)
    }
    await next()
  }
}

// Origin validation for the MCP endpoint (guards against DNS-rebinding
// per the MCP spec). Requests without an Origin header (native MCP
// clients, curl) are allowed — Bearer auth still applies. When an Origin
// is present it must match the configured CORS origin, or be localhost.
function isMcpOriginAllowed(origin: string | undefined, corsOrigin: string | null): boolean {
  if (!origin) return true
  if (corsOrigin === "*") return true
  if (corsOrigin && origin === corsOrigin) return true
  try {
    const host = new URL(origin).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}

export function createApp(opts: {
  handlers: WebhookHandler[]
  handlerContext: HandlerContext
  store: LifecycleStore
  apiToken: string
  cronScheduler: CronScheduler | null
  mcpServer?: McpServer | null
  allowlist?: Allowlist
  persistAllowlist?: (orgs: string[], repos: string[]) => Promise<void>
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // CORS -- restrict to configured origins. In production the dashboard
  // is served from the same origin so CORS isn't needed, but during
  // development (e.g. Vite on localhost:5173) a configured origin is
  // required. Set OPENTOWER_CORS_ORIGIN to allow a specific origin, or
  // "*" to allow all origins (not recommended in production).
  const corsOrigin = process.env.OPENTOWER_CORS_ORIGIN || null
  if (corsOrigin) {
    app.use(
      "*",
      cors({
        origin: corsOrigin,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "MCP-Protocol-Version"],
        exposeHeaders: ["Mcp-Session-Id"],
        maxAge: 86400,
      }),
    )
  }

  app.onError((err, c) => {
    Sentry.captureException(err)
    logger.error("unhandled route error", { error: formatError(err) })
    return c.json({ error: "internal server error" }, 500)
  })

  app.get("/healthz", (c) => {
    return c.json({ ok: true, plugin: "opentower" })
  })

  // Sentry middleware: isolate each request into its own scope.
  app.use("*", async (c, next) => {
    await Sentry.withIsolationScope(async (scope) => {
      const method = c.req.method
      const path = new URL(c.req.url).pathname

      scope.setTag("http.method", method)
      scope.setTag("http.route", path)

      const deliveryId = c.req.header("x-github-delivery")
      if (deliveryId) scope.setTag("delivery.id", deliveryId)
      const event = c.req.header("x-github-event")
      if (event) scope.setTag("github.event", event)

      await Sentry.startSpan(
        {
          op: "http.server",
          name: `${method} ${path}`,
          attributes: {
            "http.method": method,
            "http.route": path,
            ...(deliveryId ? { "delivery.id": deliveryId } : {}),
            ...(event ? { "github.event": event } : {}),
          },
        },
        async (span) => {
          await next()
          const status = c.res.status
          span.setAttribute("http.status_code", status)
          span.setStatus({ code: status >= 400 ? 2 : 1 })
        },
      )
    })
  })

  // Register all webhook handlers. Each handler adds its own routes.
  for (const handler of opts.handlers) {
    handler.register(app, opts.handlerContext)
  }

  // --- Dashboard JSON API ---

  const apiAuth = createBearerAuth(opts.apiToken, "API")
  app.use("/api/*", apiAuth)
  app.use("/api/*", async (c, next) => {
    c.set("store", opts.store)
    await next()
  })

  app.get("/api/stats", apiStatsHandler)
  app.get("/api/entities", apiEntitiesHandler)
  app.get("/api/entities/:key", apiEntityDetailHandler)
  app.get("/api/dispatches", apiDispatchesHandler)
  app.get("/api/retention", apiGetRetentionHandler)
  app.put("/api/retention", apiSetRetentionHandler)
  app.post("/api/retention/prune", apiPruneHandler)

  // Allowlist management routes
  if (opts.allowlist && opts.persistAllowlist) {
    const allowlistHandlers = makeAllowlistHandlers({
      allowlist: opts.allowlist,
      persistAllowlist: opts.persistAllowlist,
    })
    app.get("/api/allowlist", allowlistHandlers.get)
    app.put("/api/allowlist", allowlistHandlers.set)
  }

  // Cron job management routes
  if (opts.cronScheduler) {
    const cronHandlers = makeCronHandlers(opts.cronScheduler)
    app.get("/api/cron", cronHandlers.list)
    app.post("/api/cron", cronHandlers.create)
    app.get("/api/cron/:id", cronHandlers.get)
    app.put("/api/cron/:id", cronHandlers.update)
    app.delete("/api/cron/:id", cronHandlers.delete)
    app.post("/api/cron/:id/trigger", cronHandlers.trigger)
    app.get("/api/cron/:id/executions", cronHandlers.executions)
  }

  // --- MCP endpoint ---
  // Authenticated Streamable HTTP transport for remote agent control.
  // Only mounted when an MCP server is provided (which requires a token).
  if (opts.mcpServer) {
    const mcpServer = opts.mcpServer
    const transport = new StreamableHTTPTransport()
    // Connect the server to the transport exactly once. Memoizing the
    // promise avoids a double-connect race when concurrent requests
    // arrive before the first connection settles.
    let connectPromise: Promise<void> | null = null
    app.use("/mcp", createBearerAuth(opts.apiToken, "MCP"))
    app.use("/mcp", async (c, next) => {
      if (!isMcpOriginAllowed(c.req.header("origin"), corsOrigin)) {
        return c.json({ error: "forbidden origin" }, 403)
      }
      await next()
    })
    app.all("/mcp", async (c) => {
      if (!connectPromise) connectPromise = mcpServer.connect(transport)
      await connectPromise
      return transport.handleRequest(c)
    })
  }

  // --- Static dashboard serving ---
  // Serve bundled dashboard from ./public if it exists
  const publicDir = resolve(import.meta.dirname, "../public")
  if (existsSync(publicDir)) {
    app.use("/assets/*", serveStatic({ root: publicDir }))
    app.get("*", serveStatic({ root: publicDir, path: "index.html" }))
  }

  return app
}
