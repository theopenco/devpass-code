#!/usr/bin/env bun
/**
 * Refreshes the bundled LLM Gateway catalog snapshot at src/models-dev/snapshot.txt.
 * Models come from the gateway's /v1/models; models.dev metadata the gateway does not
 * expose (reasoning options, release dates, output limits) is merged in where present.
 * The snapshot is the boot-time floor for the catalog; live fetch still refreshes on top.
 */
import { LLMGatewayCatalog } from "../src/models-dev/llmgateway"

const metadata = await fetch(`${process.env.OPENCODE_MODELS_URL || "https://models.dev"}/api.json`)
  .then((res) =>
    res.ok
      ? (res.json() as Promise<{ llmgateway?: { models?: Record<string, LLMGatewayCatalog.CatalogModel> } }>)
      : undefined,
  )
  .then((catalog) => catalog?.llmgateway?.models)
  .catch(() => undefined)
const response = await fetch(`${LLMGatewayCatalog.api}/models?exclude_deprecated=false`)
if (!response.ok) {
  console.error(`Failed to fetch ${LLMGatewayCatalog.api}/models: ${response.status} ${response.statusText}`)
  process.exit(1)
}
const body = (await response.json()) as { data?: LLMGatewayCatalog.GatewayModel[] }
const catalog = LLMGatewayCatalog.fromGateway(body.data ?? [], metadata)
// A floor, not equality: guards against committing an error page or a truncated body.
const MINIMUM_MODELS = 50
const count = Object.keys(catalog.llmgateway.models).length
if (count < MINIMUM_MODELS) {
  console.error(`Fetched catalog has fewer than ${MINIMUM_MODELS} models; refusing to write snapshot`)
  process.exit(1)
}
const text = JSON.stringify({ llmgateway: catalog.llmgateway })
const target = new URL("../src/models-dev/snapshot.txt", import.meta.url)
await Bun.write(target, text)
console.log(`Wrote ${count} models (${text.length} bytes) to ${Bun.fileURLToPath(target)}`)
