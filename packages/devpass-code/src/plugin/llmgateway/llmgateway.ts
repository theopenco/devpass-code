import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { createServer } from "http"
import os from "os"
import open from "open"

/**
 * LLM Gateway login for devpass-code.
 *
 * Two providers share this flow — `llmgateway` (pay-as-you-go) and
 * `llmgateway-devpass` (the DevPass coding subscription). Both authenticate the
 * same way: either a Claude-Code-style "click a link" browser flow, or pasting
 * an API key. The browser flow starts a throwaway loopback server, opens the
 * LLM Gateway dashboard, and the dashboard hands the freshly minted key back to
 * the loopback so it never leaves the machine.
 */

const DEFAULT_APP_URL = "https://llmgateway.io"

function appUrl(): string {
  return (process.env.DEVPASS_APP_URL || process.env.LLMGATEWAY_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "")
}

const USER_AGENT = `devpass-code/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

interface LoopbackLogin {
  url: string
  wait: () => Promise<string>
}

async function startLoopbackLogin(source: string, org: "default" | "devpass"): Promise<LoopbackLogin> {
  let resolveKey!: (key: string) => void
  let rejectKey!: (error: Error) => void
  const keyPromise = new Promise<string>((resolve, reject) => {
    resolveKey = resolve
    rejectKey = reject
  })

  const state = randomState()

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname !== "/callback") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const key = url.searchParams.get("key")
    const returnedState = url.searchParams.get("state")
    const error = url.searchParams.get("error")

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.error(error, { provider: "LLM Gateway" }))
      rejectKey(new Error(error))
      return
    }

    if (!key || returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.error("Invalid authorization response", { provider: "LLM Gateway" }))
      rejectKey(new Error("Invalid callback state"))
      return
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.success({ provider: "LLM Gateway" }))
    resolveKey(key)
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new Error("Failed to bind loopback server"))
    })
  })

  const callback = `http://127.0.0.1:${port}/callback`
  const params = new URLSearchParams({
    callback,
    state,
    source,
    org,
    name: "DevPass Code CLI",
  })
  const url = `${appUrl()}/connect/cli?${params.toString()}`

  const timeout = setTimeout(() => rejectKey(new Error("Login timed out after 5 minutes")), 5 * 60 * 1000)

  const wait = async () => {
    try {
      return await keyPromise
    } finally {
      clearTimeout(timeout)
      try {
        server.close()
      } catch {}
    }
  }

  return { url, wait }
}

interface LlmGatewayPluginConfig {
  providerID: string
  label: string
  source: string
  /**
   * Which LLM Gateway org the minted key lives in: "devpass" bills the DevPass
   * subscription (personal org), "default" bills pay-as-you-go credits on the
   * user's default dashboard org.
   */
  org: "default" | "devpass"
}

export function makeLlmGatewayPlugin(config: LlmGatewayPluginConfig) {
  return async function (_input: PluginInput): Promise<Hooks> {
    return {
      auth: {
        provider: config.providerID,
        methods: [
          {
            type: "oauth",
            label: "Log in with browser",
            authorize: async () => {
              const { url, wait } = await startLoopbackLogin(config.source, config.org)
              open(url).catch(() => {})
              return {
                url,
                instructions:
                  "A browser window has been opened to authorize devpass-code. Once you approve, return to your terminal.",
                method: "auto" as const,
                callback: async () => {
                  try {
                    const key = await wait()
                    return { type: "success" as const, key }
                  } catch {
                    return { type: "failed" as const }
                  }
                },
              }
            },
          },
          {
            type: "api",
            label: "Paste an API key",
          },
        ],
      },
      "chat.headers": async (input, output) => {
        if (input.model.providerID !== config.providerID) return
        output.headers["x-source"] = config.source
        output.headers["User-Agent"] = USER_AGENT
      },
    }
  }
}

export const LlmGatewayAuthPlugin = makeLlmGatewayPlugin({
  providerID: "llmgateway",
  label: "LLM Gateway",
  source: "devpass-code",
  org: "default",
})

export const LlmGatewayDevPassAuthPlugin = makeLlmGatewayPlugin({
  providerID: "llmgateway-devpass",
  label: "LLM Gateway DevPass",
  source: "devpass-code",
  org: "devpass",
})
