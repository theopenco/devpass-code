import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Effect, Option, Schema } from "effect"
import type { Server, ServerResponse } from "node:http"
import { App } from "../../app.js"
import { Credential } from "../../credential.js"
import { Hash } from "@opencode/util/hash"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { LLMGatewayCatalog } from "../../models-dev/llmgateway.js"
import { OauthCallbackPage } from "../../oauth/page.js"

const appURL = () =>
  (process.env.DEVPASS_APP_URL || process.env.LLMGATEWAY_APP_URL || "https://llmgateway.io").replace(/\/+$/, "")
const internalAPIURL = () =>
  (
    process.env.DEVPASS_INTERNAL_API_URL ||
    process.env.LLMGATEWAY_INTERNAL_API_URL ||
    "https://internal.llmgateway.io"
  ).replace(/\/+$/, "")
const browserMethodID = Integration.MethodID.make("browser")
// Keys with no expiry are stored with the latest representable Date; the gateway revokes them.
const maxExpiry = 8_640_000_000_000_000

const providers = [
  { id: "llmgateway", name: "LLM Gateway", org: "default" },
  { id: "llmgateway-devpass", name: "LLM Gateway DevPass", org: "devpass" },
] as const

const Token = Schema.Struct({
  api_key: Schema.String.check(Schema.isMinLength(1)),
  expires_at: Schema.NullOr(Schema.String),
})
const decodeToken = Schema.decodeUnknownOption(Schema.fromJsonString(Token))
const decodeTokenError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error_description: Schema.optional(Schema.String) })),
)

// The dashboard hands the loopback a one-time code, never the key; the CLI redeems it with its PKCE verifier.
const browser = (provider: (typeof providers)[number]) =>
  ({
    integrationID: provider.id,
    method: { id: browserMethodID, type: "oauth", label: "Log in with browser" },
    // The dashboard mints a regular API key; once it expires, the user logs in again.
    refresh: (value) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          value.expires > now
            ? Effect.succeed(value)
            : Effect.fail(new Error(`${provider.name} API key expired. Log in with browser again.`)),
        ),
      ),
    authorize: () =>
      Effect.gen(function* () {
        const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
        const challenge = Buffer.from(
          yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        ).toString("base64url")
        const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
        const received = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
        // Lazy so runtimes without a loopback listener never evaluate node:http.
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1")
          if (request.method !== "GET" || url.pathname !== "/callback") {
            response.writeHead(404).end("Not found")
            return
          }
          const code = url.searchParams.get("code")
          const error =
            url.searchParams.get("state") !== state
              ? "Invalid authorization response"
              : (url.searchParams.get("error") ?? (code ? undefined : "Missing authorization code"))
          if (error || !code) {
            const message = error ?? "Missing authorization code"
            response
              .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
              .end(OauthCallbackPage.error(message, { provider: "LLM Gateway" }))
            Effect.runSync(Deferred.fail(received, new Error(message)))
            return
          }
          if (!Effect.runSync(Deferred.succeed(received, { code, response })))
            response.writeHead(409).end("Authorization callback already received")
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.close()
            server.closeAllConnections()
          }),
        )
        const port = yield* listen(server)
        const params = new URLSearchParams({
          callback: `http://127.0.0.1:${port}/callback`,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          source: "devpass-code",
          org: provider.org,
          name: "DevPass Code CLI",
        })
        return {
          mode: "auto" as const,
          url: `${appURL()}/connect/cli?${params.toString()}`,
          instructions: "Approve DevPass Code in your browser, then return to your terminal.",
          expiresAt: Date.now() + 5 * 60 * 1000,
          callback: Effect.gen(function* () {
            const request = yield* Deferred.await(received)
            const respond = (error?: string) =>
              Effect.sync(() =>
                request.response
                  .writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" })
                  .end(
                    error
                      ? OauthCallbackPage.error(error, { provider: "LLM Gateway" })
                      : OauthCallbackPage.success({ provider: "LLM Gateway" }),
                  ),
              )
            return yield* exchangeCode(request.code, verifier).pipe(
              Effect.tap(() => respond()),
              Effect.tapError((error) => respond(error.message)),
              // Bun's server.closeAllConnections() leaves an unanswered callback response pending.
              Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
            )
          }),
        }
      }),
  }) satisfies IntegrationOAuthMethodRegistration

function exchangeCode(code: string, verifier: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${internalAPIURL()}/public/cli-auth/token`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier }),
        }),
      catch: () => new Error("LLM Gateway token exchange request failed"),
    })
    const body = yield* Effect.promise(() => response.text().catch(() => ""))
    if (!response.ok) {
      const detail = Option.getOrUndefined(decodeTokenError(body))?.error_description
      return yield* Effect.fail(
        new Error(detail ? `LLM Gateway login failed: ${detail}` : `LLM Gateway login failed (${response.status})`),
      )
    }
    const token = Option.getOrUndefined(decodeToken(body))
    const expires = token?.expires_at ? Date.parse(token.expires_at) : maxExpiry
    if (!token || !Number.isSafeInteger(expires))
      return yield* Effect.fail(new Error("Invalid LLM Gateway token response"))
    return Credential.OAuth.make({
      type: "oauth",
      methodID: browserMethodID,
      access: token.api_key,
      refresh: "",
      expires,
    })
  })
}

function listen(server: Server) {
  return Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") return resume(Effect.fail(new Error("Missing callback port")))
      resume(Effect.succeed(address.port))
    })
  })
}

const ChatBody = Schema.Struct({
  model: Schema.String,
  messages: Schema.optional(
    Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optional(Schema.Unknown) })),
  ),
})
const decodeChatBody = Schema.decodeUnknownOption(Schema.fromJsonString(ChatBody))
const Decision = Schema.Struct({
  answers: Schema.Array(Schema.Struct({ type: Schema.String, choice: Schema.optional(Schema.String) })),
})
const decodeDecision = Schema.decodeUnknownOption(Decision)

type Tier = keyof typeof LLMGatewayCatalog.defaultSmartRouterTiers

/** `DEVPASS_SMART_ROUTER_MODELS=fast,balanced,frontier` overrides the model behind each tier. */
export function smartRouterTiers(env = process.env.DEVPASS_SMART_ROUTER_MODELS): Record<Tier, string> {
  const [fast, balanced, frontier] = (env ?? "").split(",").map((item) => item.trim())
  const defaults = LLMGatewayCatalog.defaultSmartRouterTiers
  return {
    fast: fast || defaults.fast,
    balanced: balanced || defaults.balanced,
    frontier: frontier || defaults.frontier,
  }
}

/** The text the decision model reads: the latest user turn, which is what changes between turns. */
export function smartRouterInput(messages: ReadonlyArray<{ role: string; content?: unknown }>) {
  const text = (content: unknown): string => {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
      )
      .filter(Boolean)
      .join("\n")
  }
  const latest = messages.findLast((message) => message.role === "user" && text(message.content).trim())
  return latest ? text(latest.content).slice(-8000) : ""
}

const smartRouterQuestion = {
  type: "choice",
  name: "tier",
  instructions: "A coding agent is about to work on this request. Pick the cheapest model tier that will do it well.",
  choices: [
    { value: "fast", description: "Questions, explanations, lookups, small single-file edits, simple commands" },
    { value: "balanced", description: "Typical multi-step coding: features, bug fixes, tests across a few files" },
    {
      value: "frontier",
      description: "Hard work: large refactors, deep debugging, architecture, subtle concurrency or security issues",
    },
  ],
}

export const LLMGatewayPlugin = define({
  id: "opencode.provider.llmgateway",
  effect: Effect.fn(function* (ctx) {
    const userAgent = App.useragent(ctx.app)
    const ids = new Set<string>(LLMGatewayCatalog.providerIDs)
    // One verdict per user turn, so every tool step of a turn stays on the same model and prompt cache.
    const verdicts = new Map<string, string>()

    yield* ctx.integration.transform((editor) => {
      for (const provider of providers) {
        editor.update(provider.id, (integration) => {
          integration.name = provider.name
        })
        editor.method.update(browser(provider))
        editor.method.update({ integrationID: provider.id, method: { type: "key", label: "Paste an API key" } })
      }
    })

    yield* ctx.provider.transform((evt) => {
      for (const item of evt.list()) {
        if (!ids.has(item.provider.id)) continue
        evt.update(item.provider.id, (provider) => {
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": "https://llmgateway.io/devpass",
            "X-Title": "DevPass Code",
            "X-Source": "devpass-code",
            "User-Agent": userAgent,
          }
        })
      }
    })

    yield* ctx.model.transform((models) => {
      for (const providerID of ids) {
        const router = models.get(providerID, LLMGatewayCatalog.smartRouterID)
        if (!router) continue
        // Smart Router is the default until the user or their config picks a model.
        if (!models.default.get()) models.default.set(providerID, LLMGatewayCatalog.smartRouterID)
        models.update(providerID, LLMGatewayCatalog.smartRouterID, (model) => {
          model.variants = model.variants.map((variant) => ({
            id: variant.id,
            headers: { [LLMGatewayCatalog.decisionHeader]: variant.id },
          }))
        })
      }
    })

    const decide = Effect.fn("LLMGateway.smartRouter")(function* (request: Request, input: string) {
      const tiers = smartRouterTiers()
      const decisionModel =
        request.headers.get(LLMGatewayCatalog.decisionHeader) ??
        process.env.DEVPASS_SMART_ROUTER_DECISION_MODEL ??
        LLMGatewayCatalog.defaultDecisionModels[0]
      if (!input) return tiers.balanced
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${LLMGatewayCatalog.api}/decisions`, {
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            headers: {
              authorization: request.headers.get("authorization") ?? "",
              "content-type": "application/json",
              "user-agent": userAgent,
              "x-source": "devpass-code",
            },
            body: JSON.stringify({ model: decisionModel, input, questions: [smartRouterQuestion] }),
          }).then((res) => (res.ok ? res.json() : undefined)),
        catch: (cause) => cause,
      }).pipe(Effect.orElseSucceed(() => undefined))
      const choice = decodeDecision(response).pipe((option) =>
        option._tag === "Some" ? option.value.answers.find((answer) => answer.type === "choice")?.choice : undefined,
      )
      const model = choice && choice in tiers ? tiers[choice as Tier] : tiers.balanced
      yield* Effect.logInfo("smart router picked a model", { decisionModel, tier: choice ?? "fallback", model })
      return model
    })

    for (const providerID of ids) {
      yield* ctx.session.hook(
        "http.request",
        (evt) =>
          Effect.gen(function* () {
            if (evt.model.providerID !== providerID) return
            if (evt.model.id !== Model.ID.make(LLMGatewayCatalog.smartRouterID)) return
            const text = yield* Effect.promise(() => evt.request.clone().text())
            const body = decodeChatBody(text)
            if (body._tag === "None" || body.value.model !== LLMGatewayCatalog.smartRouterID) return
            const input = smartRouterInput(body.value.messages ?? [])
            const key = `${evt.sessionID}:${Hash.fast(input)}`
            const model =
              evt.kind !== "primary"
                ? smartRouterTiers().fast
                : (verdicts.get(key) ?? (yield* decide(evt.request, input)))
            if (evt.kind === "primary") {
              verdicts.delete(key)
              verdicts.set(key, model)
              if (verdicts.size > 256) verdicts.delete(verdicts.keys().next().value!)
            }
            const headers = new Headers(evt.request.headers)
            headers.delete(LLMGatewayCatalog.decisionHeader)
            headers.delete("content-length")
            evt.request = new Request(evt.request.url, {
              method: evt.request.method,
              headers,
              body: JSON.stringify({ ...JSON.parse(text), model }),
            })
          }),
        { providerID },
      )
    }
  }),
})
