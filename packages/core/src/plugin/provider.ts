import { DynamicProviderPlugin } from "./provider/dynamic.js"
import { LLMGatewayPlugin } from "./provider/llmgateway.js"
import type { PluginInternal } from "./internal.js"

// DevPass Code ships only the LLM Gateway providers. The upstream provider plugins stay in the
// tree so syncs merge cleanly, but are not registered.
export const ProviderPlugins: PluginInternal.InternalPlugin[] = [LLMGatewayPlugin, DynamicProviderPlugin]
