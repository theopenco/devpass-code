import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Schedule } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { LLMGatewayCatalog } from "@opencode/core/models-dev/llmgateway"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { LLMGatewayPlugin, smartRouterInput, smartRouterTiers } from "@opencode/core/plugin/provider/llmgateway"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const realFetch = globalThis.fetch
const json = (request: Request) => Effect.promise(() => request.json() as Promise<{ model: string; stream?: boolean }>)

afterEach(() => {
  globalThis.fetch = realFetch
})

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* LLMGatewayPlugin.effect(host)
})

const chatRequest = (body: object, headers: Record<string, string> = {}) =>
  new Request(`${LLMGatewayCatalog.api}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer llmgtwy_test", ...headers },
    body: JSON.stringify(body),
  })

const route = (input: { kind?: "primary" | "title"; sessionID?: string; request: Request }) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    return yield* hooks.trigger("session", "http.request", {
      sessionID: Session.ID.make(input.sessionID ?? "ses_router"),
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make("llmgateway"), id: Model.ID.make("smart-router") }),
      kind: input.kind ?? "primary",
      request: input.request,
    })
  })

const decisions = (choice: string) => {
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    })
    return Response.json({ answers: [{ type: "choice", name: "tier", choice }] })
  }) as typeof fetch
  return calls
}

describe("LLMGatewayCatalog", () => {
  const gateway: LLMGatewayCatalog.GatewayModel[] = [
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      providers: [{ reasoning: true, tools: true }],
      pricing: { prompt: "2e-6", completion: "10e-6", input_cache_read: "0.1e-6" },
      context_length: 1_000_000,
      supported_parameters: ["reasoning_effort", "tools"],
    },
    { id: "gpt-image-2", architecture: { output_modalities: ["image"] } },
    { id: "old-model", deactivated_at: "2026-01-01" },
    { id: "jev-1.13.0", architecture: { input_modalities: ["text"], output_modalities: ["decision"] } },
    { id: "microsoft-decision-1", architecture: { input_modalities: ["text"], output_modalities: ["decision"] } },
  ]

  test("builds both providers from the gateway's text models", () => {
    const catalog = LLMGatewayCatalog.fromGateway(gateway)
    expect(Object.keys(catalog)).toEqual(["llmgateway", "llmgateway-devpass"])
    expect(catalog.llmgateway.api).toBe("https://api.llmgateway.io/v1")
    expect(Object.keys(catalog.llmgateway.models)).toEqual(["claude-sonnet-5-5", "smart-router"])
    expect(catalog.llmgateway.models["claude-sonnet-5-5"]).toMatchObject({
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: false,
      cost: { input: 2, output: 10, cache_read: 0.1 },
      limit: { context: 1_000_000, output: 32_000 },
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    })
  })

  test("offers each decision model as a Smart Router variant", () => {
    const router = LLMGatewayCatalog.fromGateway(gateway).llmgateway.models["smart-router"]
    expect(router).toMatchObject({
      name: "Smart Router",
      tool_call: true,
      reasoning_options: [{ type: "effort", values: ["jev-1.13.0", "microsoft-decision-1"] }],
    })
  })

  test("keeps models.dev metadata the gateway does not expose", () => {
    const base = {
      "claude-sonnet-5-5": {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        release_date: "2026-09-28",
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
        limit: { context: 1_000_000, output: 128_000 },
      },
    }
    expect(LLMGatewayCatalog.fromGateway(gateway, base).llmgateway.models["claude-sonnet-5-5"]).toMatchObject({
      release_date: "2026-09-28",
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
      limit: { context: 1_000_000, output: 128_000 },
      cost: { input: 2, output: 10 },
    })
  })

  test("always exposes the Smart Router from a stored catalog", () => {
    const catalog = LLMGatewayCatalog.fromSnapshot({ llmgateway: { models: {} } })
    expect(catalog["llmgateway-devpass"].models["smart-router"]).toMatchObject({
      reasoning_options: [{ type: "effort", values: LLMGatewayCatalog.defaultDecisionModels }],
    })
  })
})

describe("smart router helpers", () => {
  test("tiers default to the Claude 5.5 family and accept overrides", () => {
    expect(smartRouterTiers(undefined)).toEqual(LLMGatewayCatalog.defaultSmartRouterTiers)
    expect(smartRouterTiers("gpt-6-luna, ,gpt-6-astra")).toEqual({
      fast: "gpt-6-luna",
      balanced: LLMGatewayCatalog.defaultSmartRouterTiers.balanced,
      frontier: "gpt-6-astra",
    })
  })

  test("reads the latest non-empty user turn", () => {
    expect(
      smartRouterInput([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "refactor auth" }, { type: "image_url" }] },
        { role: "tool", content: "result" },
      ]),
    ).toBe("refactor auth")
    expect(smartRouterInput([{ role: "system", content: "rules" }])).toBe("")
  })
})

describe("LLMGatewayPlugin", () => {
  test("is the only registered provider plugin besides dynamic SDK loading", () => {
    expect(ProviderPlugins.map((item) => item.id)).toEqual([
      "opencode.provider.llmgateway",
      "opencode.provider.dynamic",
    ])
  })

  it.effect("tags both LLM Gateway providers and leaves others alone", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      yield* catalog.transform((editor) => {
        for (const id of ["llmgateway", "llmgateway-devpass"])
          editor.update(Provider.ID.make(id), (provider) => {
            provider.package = "@opencode/ai/providers/openai-compatible"
            provider.settings = { baseURL: LLMGatewayCatalog.api }
            provider.headers = { Existing: "value" }
          })
        editor.update(Provider.ID.openrouter, () => {})
      })
      yield* addPlugin()
      for (const id of ["llmgateway", "llmgateway-devpass"])
        expect((yield* catalog.get(Provider.ID.make(id)))?.headers).toMatchObject({
          Existing: "value",
          "X-Source": "devpass-code",
          "X-Title": "DevPass Code",
        })
      expect((yield* catalog.get(Provider.ID.openrouter))?.headers).toBeUndefined()
    }),
  )

  it.effect("registers browser login and API key methods for both providers", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      for (const [id, name] of [
        ["llmgateway", "LLM Gateway"],
        ["llmgateway-devpass", "LLM Gateway DevPass"],
      ]) {
        const integration = yield* integrations.get(Integration.ID.make(id))
        expect(integration?.name).toBe(name)
        expect(integration?.methods as unknown).toEqual([
          { id: "browser", type: "oauth", label: "Log in with browser" },
          { type: "key", label: "Paste an API key" },
        ])
      }
    }),
  )

  it.live("stores the key the dashboard hands back to the loopback server", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("llmgateway-devpass")
      const attempt = yield* integrations.oauth.connect({
        integrationID,
        methodID: Integration.MethodID.make("browser"),
        label: "DevPass",
      })
      const url = new URL(attempt.url)
      expect(url.origin + url.pathname).toBe("https://llmgateway.io/connect/cli")
      expect(url.searchParams.get("org")).toBe("devpass")
      expect(url.searchParams.get("source")).toBe("devpass-code")
      const callback = new URL(url.searchParams.get("callback") ?? "")
      expect(callback.hostname).toBe("127.0.0.1")

      const forged = new URL(callback)
      forged.searchParams.set("state", "wrong")
      forged.searchParams.set("key", "llmgtwy_forged")
      expect((yield* Effect.promise(() => fetch(forged, { headers: { Connection: "close" } }))).status).toBe(400)
      expect((yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).status).toBe("failed")

      const retry = yield* integrations.oauth.connect({
        integrationID,
        methodID: Integration.MethodID.make("browser"),
        label: "DevPass",
      })
      const next = new URL(retry.url)
      const ok = new URL(next.searchParams.get("callback") ?? "")
      ok.searchParams.set("state", next.searchParams.get("state") ?? "")
      ok.searchParams.set("key", "llmgtwy_minted")
      expect((yield* Effect.promise(() => fetch(ok, { headers: { Connection: "close" } }))).status).toBe(200)
      const status = yield* integrations.oauth.status({ integrationID, attemptID: retry.attemptID }).pipe(
        Effect.repeat({
          until: (value) => value.status !== "pending",
          schedule: Schedule.spaced("1 millis"),
          times: 100,
        }),
      )
      expect(status.status).toBe("complete")
      const saved = (yield* credentials.list(integrationID)).find((item) => item.label === "DevPass")?.value
      expect(saved).toMatchObject({ type: "oauth", access: "llmgtwy_minted", refresh: "" })
    }),
  )

  it.effect("turns each Smart Router variant into a decision model header", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      yield* providers.transform((editor) => {
        editor.update(Provider.ID.make("llmgateway"), (provider) => {
          provider.package = "@opencode/ai/providers/openai-compatible"
          provider.activation = "enabled"
        })
        editor.models.update(Provider.ID.make("llmgateway"), Model.ID.make("smart-router"), (model) => {
          model.variants = [
            { id: Model.VariantID.make("jev-1.13.0"), settings: { reasoningEffort: "jev-1.13.0" } },
            { id: Model.VariantID.make("gpt-6-luna-decisions"), settings: { reasoningEffort: "gpt-6-luna-decisions" } },
          ]
        })
      })
      yield* addPlugin()
      const model = yield* (yield* Model.Service).get(Provider.ID.make("llmgateway"), Model.ID.make("smart-router"))
      expect(model?.variants as unknown).toEqual([
        { id: "jev-1.13.0", headers: { "x-devpass-decision-model": "jev-1.13.0" } },
        { id: "gpt-6-luna-decisions", headers: { "x-devpass-decision-model": "gpt-6-luna-decisions" } },
      ])
    }),
  )

  it.effect("routes a turn to the tier the selected decision model picks", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const calls = decisions("frontier")
      const event = yield* route({
        request: chatRequest(
          { model: "smart-router", stream: true, messages: [{ role: "user", content: "Redesign the storage layer" }] },
          { "x-devpass-decision-model": "microsoft-decision-1" },
        ),
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        url: "https://api.llmgateway.io/v1/decisions",
        authorization: "Bearer llmgtwy_test",
        body: { model: "microsoft-decision-1", input: "Redesign the storage layer" },
      })
      const body = yield* json(event.request)
      expect(body).toMatchObject({ model: "claude-opus-5-5", stream: true })
      expect(event.request.headers.has("x-devpass-decision-model")).toBe(false)
      expect(event.request.headers.get("authorization")).toBe("Bearer llmgtwy_test")
    }),
  )

  it.effect("keeps every tool step of a turn on the same model", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const calls = decisions("fast")
      const messages = [{ role: "user", content: "What does this function do?" }]
      const first = yield* route({ request: chatRequest({ model: "smart-router", messages }) })
      const step = yield* route({
        request: chatRequest({
          model: "smart-router",
          messages: [...messages, { role: "assistant", content: "" }, { role: "tool", content: "source" }],
        }),
      })
      expect(calls).toHaveLength(1)
      expect((yield* json(first.request)).model).toBe("claude-haiku-5-5")
      expect((yield* json(step.request)).model).toBe("claude-haiku-5-5")
    }),
  )

  it.effect("uses the fast tier for titles and the balanced tier when the decision fails", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const calls = decisions("not-a-tier")
      const title = yield* route({
        kind: "title",
        request: chatRequest({ model: "smart-router", messages: [{ role: "user", content: "hi" }] }),
      })
      expect(calls).toHaveLength(0)
      expect((yield* json(title.request)).model).toBe("claude-haiku-5-5")
      const turn = yield* route({
        sessionID: "ses_other",
        request: chatRequest({ model: "smart-router", messages: [{ role: "user", content: "hi" }] }),
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].body.model).toBe("jev-1.13.0")
      expect((yield* json(turn.request)).model).toBe("claude-sonnet-5-5")
    }),
  )
})
