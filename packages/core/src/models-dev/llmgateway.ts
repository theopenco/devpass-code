export * as LLMGatewayCatalog from "./llmgateway.js"

/**
 * DevPass Code talks to a single upstream, the LLM Gateway OpenAI-compatible API, so the catalog is
 * built from the gateway's own `/v1/models` endpoint instead of models.dev. Two providers share it:
 *   - `llmgateway`         pay-as-you-go credits
 *   - `llmgateway-devpass` the DevPass coding subscription
 * models.dev metadata the gateway does not expose (reasoning options, release dates, output limits)
 * is merged in from the bundled snapshot when a model is present there.
 */
export const api = (process.env.LLMGATEWAY_API_URL ?? "https://api.llmgateway.io/v1").replace(/\/+$/, "")
export const providerIDs = ["llmgateway", "llmgateway-devpass"] as const
export const smartRouterID = "smart-router"
export const decisionHeader = "x-devpass-decision-model"
export const defaultDecisionModels = ["jev-1.13.0", "microsoft-decision-1", "gpt-6-luna-decisions"]
export const defaultSmartRouterTiers = {
  fast: "claude-haiku-5-5",
  balanced: "claude-sonnet-5-5",
  frontier: "claude-opus-5-5",
}

type Modality = "text" | "audio" | "image" | "video" | "pdf"
const modalities: readonly Modality[] = ["text", "audio", "image", "video", "pdf"]

export type GatewayModel = {
  readonly id: string
  readonly name?: string
  readonly family?: string
  readonly created?: number
  readonly architecture?: {
    readonly input_modalities?: readonly string[]
    readonly output_modalities?: readonly string[]
  }
  readonly providers?: ReadonlyArray<{ readonly reasoning?: boolean; readonly tools?: boolean }>
  readonly pricing?: {
    readonly prompt?: string
    readonly completion?: string
    readonly input_cache_read?: string
    readonly input_cache_write?: string
  }
  readonly context_length?: number
  readonly supported_parameters?: readonly string[]
  readonly deprecated_at?: string | null
  readonly deactivated_at?: string | null
}

export type CatalogModel = Record<string, unknown> & {
  readonly id: string
  readonly name: string
  readonly limit: { readonly context: number; readonly output: number }
}

export type CatalogProvider = {
  readonly id: string
  readonly name: string
  readonly api: string
  readonly npm: string
  readonly env: readonly string[]
  readonly models: Record<string, CatalogModel>
}

const asModalities = (values: readonly string[] | undefined, fallback: Modality[]) => {
  const filtered = (values ?? []).filter((value): value is Modality =>
    (modalities as readonly string[]).includes(value),
  )
  return filtered.length ? filtered : fallback
}

// Gateway pricing is USD per token as decimal strings; the catalog stores USD per million tokens.
const perMillion = (value: string | undefined) => {
  const parsed = Number(value)
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1e12) / 1e6 : undefined
}

function cost(pricing: GatewayModel["pricing"]) {
  const input = perMillion(pricing?.prompt)
  const output = perMillion(pricing?.completion)
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    ...(perMillion(pricing?.input_cache_read) !== undefined
      ? { cache_read: perMillion(pricing?.input_cache_read) }
      : {}),
    ...(perMillion(pricing?.input_cache_write) !== undefined
      ? { cache_write: perMillion(pricing?.input_cache_write) }
      : {}),
  }
}

export const isDecisionModel = (model: GatewayModel) =>
  !model.deactivated_at && (model.architecture?.output_modalities ?? []).includes("decision")

function model(input: GatewayModel, base: CatalogModel | undefined): CatalogModel | undefined {
  if (input.id === "custom" || input.deactivated_at) return undefined
  // Chat models only: skip image and audio generation, realtime voice, embeddings, decision and speech-to-text models.
  const declared = input.architecture?.output_modalities
  if (declared && (declared.length !== 1 || declared[0] !== "text")) return undefined
  const output = asModalities(declared, ["text"])
  const inputs = asModalities(input.architecture?.input_modalities, ["text"])
  const providers = input.providers ?? []
  if (inputs.includes("audio") && providers.length && !providers.some((provider) => provider.tools)) return undefined
  const context =
    input.context_length && input.context_length > 0 ? input.context_length : (base?.limit.context ?? 128_000)
  const reasoning = providers.some((provider) => provider.reasoning)
  const supportsEffort = input.supported_parameters?.includes("reasoning_effort") ?? false
  return {
    release_date: input.created ? new Date(input.created * 1000).toISOString().slice(0, 10) : "",
    ...(reasoning && supportsEffort
      ? { reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] }
      : {}),
    ...base,
    id: input.id,
    // The gateway's own smart route uses the classifier configured in the dashboard, not a decision model picked here.
    name: input.id === "smart" ? "Smart Route (dashboard config)" : (input.name ?? base?.name ?? input.id),
    ...(input.family ? { family: input.family } : {}),
    attachment: inputs.includes("image"),
    reasoning: reasoning || base?.reasoning === true,
    temperature: input.supported_parameters ? input.supported_parameters.includes("temperature") : true,
    tool_call: providers.length ? providers.some((provider) => provider.tools) : true,
    cost: cost(input.pricing) ?? base?.cost,
    limit: { context, output: Math.min(context, base?.limit.output ?? 32_000) },
    modalities: { input: inputs, output },
    ...(input.deprecated_at ? { status: "deprecated" } : {}),
  }
}

export function smartRouter(models: Record<string, CatalogModel>, decisionModels: readonly string[]): CatalogModel {
  const tiers = Object.values(defaultSmartRouterTiers)
    .map((id) => models[id])
    .filter((item): item is CatalogModel => item !== undefined)
  return {
    id: smartRouterID,
    name: "Smart Router",
    family: smartRouterID,
    release_date: "2026-10-13",
    attachment: true,
    reasoning: false,
    // Each variant is a decision model that picks which tier serves a turn.
    reasoning_options: [{ type: "effort", values: [...decisionModels] }],
    temperature: true,
    tool_call: true,
    limit: {
      context: tiers.length ? Math.min(...tiers.map((item) => item.limit.context)) : 200_000,
      output: tiers.length ? Math.min(...tiers.map((item) => item.limit.output)) : 32_000,
    },
    modalities: { input: ["text", "image"], output: ["text"] },
  }
}

export function providers(models: Record<string, CatalogModel>): Record<string, CatalogProvider> {
  const provider = (id: string, name: string): CatalogProvider => ({
    id,
    name,
    api,
    npm: "@ai-sdk/openai-compatible",
    env: ["LLMGATEWAY_API_KEY"],
    models,
  })
  return {
    llmgateway: provider("llmgateway", "LLM Gateway"),
    "llmgateway-devpass": provider("llmgateway-devpass", "LLM Gateway DevPass"),
  }
}

/** Builds the catalog from a live `/v1/models` response, keeping snapshot metadata where it exists. */
export function fromGateway(data: readonly GatewayModel[], base: Record<string, CatalogModel> = {}) {
  const models: Record<string, CatalogModel> = {}
  for (const item of data) {
    const next = model(item, base[item.id])
    if (next) models[next.id] = next
  }
  if (Object.keys(models).length === 0) throw new Error("LLM Gateway returned no text models")
  const decisions = data.filter(isDecisionModel).map((item) => item.id)
  models[smartRouterID] = smartRouter(models, decisions.length ? decisions : defaultDecisionModels)
  return providers(models)
}

/** Normalizes a stored catalog so both LLM Gateway providers and the Smart Router are always present. */
export function fromSnapshot(input: Record<string, { readonly models?: Record<string, CatalogModel> }>) {
  const models = { ...(input.llmgateway?.models ?? input["llmgateway-devpass"]?.models ?? {}) }
  if (!models[smartRouterID]) models[smartRouterID] = smartRouter(models, defaultDecisionModels)
  return providers(models)
}
