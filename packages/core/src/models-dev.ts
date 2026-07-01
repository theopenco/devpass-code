import { Context, Effect, Layer, Schema } from "effect"
import { ModelsDev } from "@opencode-ai/schema/models-dev"
import { makeGlobalNode } from "./effect/app-node"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = ModelsDev.Event

/**
 * devpass-code talks to a single upstream — the LLM Gateway OpenAI-compatible
 * API — so the catalog is built from LLM Gateway's own `/v1/models` endpoint
 * (all text models it supports) rather than models.dev. Two providers are
 * exposed, both pointing at the same endpoint:
 *   - `llmgateway`         — pay-as-you-go / credits (bring your own API key)
 *   - `llmgateway-devpass` — the DevPass coding subscription
 * The gateway decides how a request is billed from the account behind the key.
 */
const LLMGATEWAY_API = (process.env.LLMGATEWAY_API_URL ?? "https://api.llmgateway.io/v1").replace(/\/+$/, "")

type Modality = "text" | "audio" | "image" | "video" | "pdf"
const MODALITIES: Modality[] = ["text", "audio", "image", "video", "pdf"]
const asModalities = (values: string[] | undefined, fallback: Modality[]): Modality[] => {
  const filtered = (values ?? []).filter((v): v is Modality => (MODALITIES as string[]).includes(v))
  return filtered.length ? filtered : fallback
}

interface GatewayPricing {
  prompt?: string
  completion?: string
  input_cache_read?: string
  input_cache_write?: string
}

interface GatewayModel {
  id: string
  name?: string
  family?: string
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  providers?: Array<{ reasoning?: boolean; tools?: boolean; vision?: boolean }>
  pricing?: GatewayPricing
  context_length?: number
  supported_parameters?: string[]
  deprecated_at?: string
  deactivated_at?: string
}

// Gateway pricing is USD per token as decimal strings ("3.0e-6"); the catalog
// stores USD per million tokens.
const perMillion = (value: string | undefined) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined
}

function fromGatewayPricing(pricing: GatewayPricing | undefined): Model["cost"] {
  const input = perMillion(pricing?.prompt)
  const output = perMillion(pricing?.completion)
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cache_read: perMillion(pricing?.input_cache_read),
    cache_write: perMillion(pricing?.input_cache_write),
  }
}

function fromGatewayModel(m: GatewayModel): Model | undefined {
  if (m.id === "custom" || m.deactivated_at) return undefined
  const output = asModalities(m.architecture?.output_modalities, ["text"])
  // Text models only — skip image-gen, embeddings, audio-only, etc.
  if (!output.includes("text")) return undefined
  const input = asModalities(m.architecture?.input_modalities, ["text"])
  const providers = m.providers ?? []
  const context = m.context_length && m.context_length > 0 ? m.context_length : 128_000
  return {
    id: m.id,
    name: m.name ?? m.id,
    family: m.family,
    release_date: "",
    attachment: input.includes("image"),
    reasoning: providers.some((p) => p.reasoning),
    temperature: m.supported_parameters ? m.supported_parameters.includes("temperature") : true,
    tool_call: providers.length ? providers.some((p) => p.tools) : true,
    cost: fromGatewayPricing(m.pricing),
    limit: { context, output: Math.min(context, 32_000) },
    modalities: { input, output },
    status: m.deprecated_at ? "deprecated" : undefined,
  }
}

function makeCatalog(models: Record<string, Model>): Record<string, Provider> {
  return {
    llmgateway: {
      id: "llmgateway",
      name: "LLM Gateway",
      api: LLMGATEWAY_API,
      npm: "@ai-sdk/openai-compatible",
      env: ["LLMGATEWAY_API_KEY"],
      models,
    },
    "llmgateway-devpass": {
      id: "llmgateway-devpass",
      name: "LLM Gateway DevPass",
      api: LLMGATEWAY_API,
      npm: "@ai-sdk/openai-compatible",
      env: ["LLMGATEWAY_API_KEY"],
      models,
    },
  }
}

// Small offline fallback so the CLI still works if the models endpoint is
// unreachable. The live fetch supersedes this whenever it succeeds.
function fallbackModel(input: {
  id: string
  name: string
  reasoning?: boolean
  attachment?: boolean
  context: number
  cost?: Model["cost"]
}): Model {
  return {
    id: input.id,
    name: input.name,
    release_date: "",
    attachment: input.attachment ?? false,
    reasoning: input.reasoning ?? false,
    temperature: true,
    tool_call: true,
    cost: input.cost,
    limit: { context: input.context, output: Math.min(input.context, 32_000) },
    modalities: { input: input.attachment ? ["text", "image"] : ["text"], output: ["text"] },
  }
}

// Fallback costs are USD per million tokens, snapshotted from the gateway's
// live pricing; the live fetch supersedes them whenever it succeeds.
const FALLBACK_MODELS: Record<string, Model> = Object.fromEntries(
  [
    fallbackModel({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      attachment: true,
      context: 200_000,
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    }),
    fallbackModel({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      attachment: true,
      context: 200_000,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    }),
    fallbackModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      attachment: true,
      context: 200_000,
      cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
    }),
    fallbackModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
      attachment: true,
      context: 400_000,
      cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
    }),
    fallbackModel({
      id: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      reasoning: true,
      context: 400_000,
      cost: { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 },
    }),
    fallbackModel({
      id: "gemini-3-pro-preview",
      name: "Gemini 3 Pro",
      reasoning: true,
      attachment: true,
      context: 1_000_000,
      cost: { input: 2, output: 12, cache_read: 0.2, cache_write: 0 },
    }),
    fallbackModel({
      id: "grok-4",
      name: "Grok 4",
      reasoning: true,
      context: 256_000,
      cost: { input: 3, output: 15, cache_read: 0.75, cache_write: 0 },
    }),
    fallbackModel({
      id: "grok-code-fast-1",
      name: "Grok Code Fast",
      context: 256_000,
      cost: { input: 0.2, output: 1.5, cache_read: 0.02, cache_write: 0 },
    }),
  ].map((m) => [m.id, m]),
)

async function fetchGatewayModels(): Promise<Record<string, Model>> {
  const res = await fetch(`${LLMGATEWAY_API}/models?exclude_deprecated=false`, {
    headers: { "User-Agent": "devpass-code" },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`models fetch failed: ${res.status}`)
  const body = (await res.json()) as { data?: GatewayModel[] }
  const models: Record<string, Model> = {}
  for (const gm of body.data ?? []) {
    const model = fromGatewayModel(gm)
    if (model) models[model.id] = model
  }
  if (Object.keys(models).length === 0) throw new Error("models fetch returned no text models")
  return models
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const populate = Effect.tryPromise(fetchGatewayModels).pipe(
      Effect.tapError((cause) => Effect.logDebug("Failed to fetch LLM Gateway models", { cause })),
      Effect.orElseSucceed(() => FALLBACK_MODELS),
      Effect.map(makeCatalog),
    )
    const cached = yield* Effect.cached(populate)
    return Service.of({
      get: () => cached,
      refresh: () => Effect.void,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export * as ModelsDev from "./models-dev"
