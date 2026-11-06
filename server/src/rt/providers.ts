// Live or mock, decided from the model refs the world actually uses ("<provider>/<model>" or a
// reinloop alias). The mock provider runs only when asked (--mock / SIM_MOCK=1) or when one of
// those models resolves to a provider that needs an API key that is not set; local providers
// (ollama, lmstudio, vllm) need none. The key names come from reinloop's presets.
import { MODEL_ALIASES, missingCredentials, PRESETS, splitModel } from 'reinloop';
import type { SimConfig } from '../config.ts';

export interface ProviderMode {
  mock: boolean;
  /** Providers of the models in use (e.g. ["anthropic"], ["ollama"]). */
  providers: string[];
  /** Why the mock runs: "--mock", or the keys that are missing. */
  reason?: string;
}

const providerOf = (ref: string): string => splitModel(MODEL_ALIASES[ref] ?? ref)?.provider ?? ref;

/** Every model the world may run: SIM_MODEL_OVERRIDE alone, else the tier models, the roster's own and `allowedModels`. */
export function modelRefs(cfg: Pick<SimConfig, 'modelOverride' | 'models' | 'allowedModels' | 'roster'>): string[] {
  if (cfg.modelOverride) return [cfg.modelOverride];
  return [...Object.values(cfg.models), ...cfg.roster.flatMap((e) => (e.model ? [e.model] : [])), ...(cfg.allowedModels ?? [])];
}

export function providerMode(refs: string[], forceMock: boolean, env: NodeJS.ProcessEnv = process.env): ProviderMode {
  const models = [...new Set(refs.filter(Boolean))];
  const providers = [...new Set(models.map(providerOf))];
  if (forceMock) return { mock: true, providers, reason: '--mock' };
  const missing = new Map<string, string[]>();
  for (const model of models) {
    if (missingCredentials({ agents: { [model]: { model } } }, env).length === 0) continue;
    const keyEnv = PRESETS[providerOf(model)]?.apiKeyEnv ?? providerOf(model);
    missing.set(keyEnv, [...(missing.get(keyEnv) ?? []), model]);
  }
  if (!missing.size) return { mock: false, providers };
  const reason = [...missing].map(([key, ms]) => `${key} not set for ${ms.join(', ')}`).join('; ');
  return { mock: true, providers, reason };
}

/** Banner and status label: "mock (<reason>)" or the live providers. */
export function providerLabel(mode: ProviderMode): string {
  return mode.mock ? `mock (${mode.reason})` : mode.providers.join(', ');
}
