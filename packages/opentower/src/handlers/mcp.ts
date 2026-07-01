// MCP server exposing opentower's remote-session controls over the
// Model Context Protocol. Mounted at /mcp by the Hono app (see handler.ts)
// behind the same Bearer auth as the JSON API.
//
// The single tool, `start_agent_session`, lets an authenticated caller
// (e.g. a local machine) start a remote OpenCode agent session for a
// given repo/branch. It is fire-and-forget: it goes through the pipeline
// (dispatchNoAffinity) so concurrency limits, dispatch audit rows, and
// Sentry spans stay consistent, then returns a delivery id immediately.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as Sentry from "@sentry/bun"
import { z } from "zod"
import { type Pipeline, repoCwd } from "../pipeline"
import type { NormalizedTrigger } from "../types"

export type McpServerOptions = {
  pipeline: Pipeline
  defaultAgent: string
  version: string
}

// "owner/repo" with no whitespace or extra slashes.
const REPO_RE = /^[^/\s]+\/[^/\s]+$/

export function makeMcpServer(opts: McpServerOptions): McpServer {
  const { pipeline, defaultAgent, version } = opts

  const server = new McpServer({ name: "opentower", version })

  server.registerTool(
    "start_agent_session",
    {
      title: "Start agent session",
      description:
        "Start a remote OpenCode agent session in this outpost. The agent clones the " +
        "repository and checks out the branch (via its repo-setup skill), then works the " +
        "prompt. Fire-and-forget: returns a delivery id immediately without waiting for the " +
        "session to finish.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        repo: z
          .string()
          .regex(REPO_RE, "must be in 'owner/repo' form")
          .describe("Target repository as 'owner/repo', e.g. 'MathurAditya724/outpost'."),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("Branch to work on. Defaults to the repository's default branch."),
        agent: z.string().min(1).optional().describe("Agent to run. Defaults to the configured default agent."),
      },
    },
    async (args) => {
      const repo = args.repo.trim()
      const branch = args.branch?.trim() || null
      const agent = args.agent?.trim() || defaultAgent
      const deliveryId = `mcp:${crypto.randomUUID()}`

      const prompt = [
        "A remote agent session was requested via MCP.",
        "",
        `Repository: ${repo}`,
        `Branch: ${branch ?? "(default branch)"}`,
        "",
        "Load the repo-setup skill first to clone the repo and prepare a worktree for the",
        "branch above, then complete the task below.",
        "",
        "Task:",
        args.prompt.trim(),
      ].join("\n")

      const trigger: NormalizedTrigger = {
        name: "mcp:start_agent_session",
        source: "mcp",
        action: null,
        enabled: true,
        agent,
        prompt_template: "{{ prompt }}",
        // Session starts in ~/dev/<owner>/<repo>; repo-setup handles the
        // clone/fetch and per-branch worktree from there.
        cwd: repoCwd(repo),
        events: ["mcp"],
        ignore_authors: undefined,
      }

      pipeline.dispatchNoAffinity(trigger, prompt, deliveryId, "mcp")

      Sentry.logger.info("mcp.session_started", {
        delivery_id: deliveryId,
        repo,
        branch: branch ?? "",
        agent,
      })

      const summary = `Started agent session (delivery ${deliveryId}) for ${repo}${branch ? `@${branch}` : ""} with agent ${agent}.`

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { ok: true, delivery_id: deliveryId, repo, branch, agent },
      }
    },
  )

  return server
}
