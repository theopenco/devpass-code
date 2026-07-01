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
 * API — so the model catalog is baked in rather than fetched from models.dev.
 * Two providers are exposed:
 *   - `llmgateway`         — pay-as-you-go / credits (bring your own API key)
 *   - `llmgateway-devpass` — the DevPass coding subscription
 * Both point at the same endpoint; the gateway decides how a request is billed
 * from the account behind the API key.
 */
const LLMGATEWAY_API = "https://api.llmgateway.io/v1"

function codingModel(input: {
  id: string
  name: string
  reasoning?: boolean
  attachment?: boolean
  context: number
  output: number
}): Model {
  return {
    id: input.id,
    name: input.name,
    release_date: "",
    attachment: input.attachment ?? false,
    reasoning: input.reasoning ?? false,
    temperature: true,
    tool_call: true,
    cost: { input: 0, output: 0 },
    limit: { context: input.context, output: input.output },
    modalities: {
      input: input.attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  }
}

const CODING_MODELS: Model[] = [
  codingModel({ id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, attachment: true, context: 200_000, output: 64_000 }),
  codingModel({ id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, attachment: true, context: 200_000, output: 64_000 }),
  codingModel({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", attachment: true, context: 200_000, output: 32_000 }),
  codingModel({ id: "gpt-5.5", name: "GPT-5.5", reasoning: true, attachment: true, context: 400_000, output: 128_000 }),
  codingModel({ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", reasoning: true, context: 400_000, output: 128_000 }),
  codingModel({ id: "gpt-5.2-codex", name: "GPT-5.2 Codex", reasoning: true, context: 400_000, output: 128_000 }),
  codingModel({ id: "gemini-3-pro-preview", name: "Gemini 3 Pro", reasoning: true, attachment: true, context: 1_000_000, output: 65_536 }),
  codingModel({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", reasoning: true, attachment: true, context: 1_000_000, output: 65_536 }),
  codingModel({ id: "grok-4", name: "Grok 4", reasoning: true, context: 256_000, output: 64_000 }),
  codingModel({ id: "grok-code-fast-1", name: "Grok Code Fast", context: 256_000, output: 64_000 }),
  codingModel({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, context: 128_000, output: 32_000 }),
  codingModel({ id: "glm-4.7", name: "GLM 4.7", reasoning: true, context: 200_000, output: 32_000 }),
]

const MODELS: Record<string, Model> = Object.fromEntries(CODING_MODELS.map((m) => [m.id, m]))

const CATALOG: Record<string, Provider> = {
  llmgateway: {
    id: "llmgateway",
    name: "LLM Gateway",
    api: LLMGATEWAY_API,
    npm: "@ai-sdk/openai-compatible",
    env: ["LLMGATEWAY_API_KEY"],
    models: MODELS,
  },
  "llmgateway-devpass": {
    id: "llmgateway-devpass",
    name: "LLM Gateway DevPass",
    api: LLMGATEWAY_API,
    npm: "@ai-sdk/openai-compatible",
    env: ["LLMGATEWAY_API_KEY"],
    models: MODELS,
  },
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    get: () => Effect.succeed(CATALOG),
    refresh: () => Effect.void,
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export * as ModelsDev from "./models-dev"
