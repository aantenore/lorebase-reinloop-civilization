// Text rewriting for compaction. `AnthropicClient` is a plain-fetch Messages API client that
// counts calls and tokens; `AnthropicRewriter` blurs/merges memories with it and degrades to the
// deterministic heuristic on any error, missing key or exhausted per-pass call budget.
import type { MnemoConfig } from './config.ts';
import { heuristicBlur, heuristicMerge } from './heuristic.ts';

export interface Rewriter {
  blur(texts: string[]): Promise<string[]>;
  merge(texts: string[]): Promise<string>;
  /** Resets the per-pass call budget. */
  beginPass(): void;
}

export interface LlmStats {
  provider: 'anthropic' | 'heuristic';
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Minimal text-completion capability shared by rewriter, concept embedder and reranker. */
export interface TextModel {
  complete(prompt: string, opts: { model: string; maxTokens: number; system?: string }): Promise<string>;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class AnthropicClient implements TextModel {
  readonly stats: LlmStats = { provider: 'anthropic', calls: 0, inputTokens: 0, outputTokens: 0 };
  private readonly key: string;
  private readonly workspace: string | undefined;
  private readonly timeoutMs: number;

  constructor(key: string, workspace: string | undefined, timeoutMs: number) {
    this.key = key;
    this.workspace = workspace;
    this.timeoutMs = timeoutMs;
  }

  async complete(prompt: string, opts: { model: string; maxTokens: number; system?: string }): Promise<string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.key,
      'anthropic-version': API_VERSION,
    };
    if (this.workspace) headers['anthropic-workspace-id'] = this.workspace;
    const body: Record<string, unknown> = { model: opts.model, max_tokens: opts.maxTokens, messages: [{ role: 'user', content: prompt }] };
    if (opts.system) body.system = opts.system;
    this.stats.calls++;
    const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    this.stats.inputTokens += json.usage?.input_tokens ?? 0;
    this.stats.outputTokens += json.usage?.output_tokens ?? 0;
    return (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }
}

export function parseJsonArray(raw: string): unknown[] | undefined {
  const a = raw.indexOf('[');
  const b = raw.lastIndexOf(']');
  if (a < 0 || b <= a) return undefined;
  try {
    const v = JSON.parse(raw.slice(a, b + 1));
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const BLUR_SYSTEM =
  'Simuli lo sfumare dei ricordi umani. Ricevi un array JSON di ricordi. Riscrivi ogni ricordo un po\' più vago, come succede quando la memoria si affievolisce: ' +
  'arrotonda i numeri, elimina i dettagli minori (coordinate, orari precisi, nomi secondari), conserva il senso generale, ' +
  'mantieni la stessa lingua e la prima persona. Rispondi SOLO con un array JSON di stringhe, della stessa lunghezza e nello stesso ordine.';
const MERGE_SYSTEM =
  'Ricevi un array JSON di ricordi simili e ormai sbiaditi. Fondili in un unico ricordo vago, una sola frase che ne conservi il senso generale, ' +
  'nella stessa lingua e in prima persona, che inizi con "Ricordo vagamente che". Rispondi SOLO con quella frase.';

export class AnthropicRewriter implements Rewriter {
  readonly client: AnthropicClient;
  private readonly cfg: MnemoConfig;
  private passCalls = 0;

  constructor(client: AnthropicClient, cfg: MnemoConfig) {
    this.client = client;
    this.cfg = cfg;
  }

  beginPass(): void {
    this.passCalls = 0;
  }

  private budgetLeft(): boolean {
    return this.passCalls < this.cfg.compaction.maxLlmCallsPerPass;
  }

  private clip(texts: string[]): string[] {
    const per = Math.max(1, Math.floor(this.cfg.compaction.maxInputChars / Math.max(1, texts.length)));
    return texts.map((t) => t.slice(0, per));
  }

  async blur(texts: string[]): Promise<string[]> {
    if (texts.length === 0 || !this.budgetLeft()) return texts.map(heuristicBlur);
    this.passCalls++;
    try {
      const raw = await this.client.complete(JSON.stringify(this.clip(texts)), { model: this.cfg.llm.model, maxTokens: this.cfg.llm.maxOutputTokens, system: BLUR_SYSTEM });
      const arr = parseJsonArray(raw);
      if (arr && arr.length === texts.length && arr.every((s) => typeof s === 'string' && s.trim() !== '')) return arr as string[];
    } catch {
      // fall through to the heuristic
    }
    return texts.map(heuristicBlur);
  }

  async merge(texts: string[]): Promise<string> {
    if (!this.budgetLeft()) return heuristicMerge(texts, this.cfg.llm.heuristicMergeChars);
    this.passCalls++;
    try {
      const raw = (await this.client.complete(JSON.stringify(this.clip(texts)), { model: this.cfg.llm.model, maxTokens: this.cfg.llm.maxOutputTokens, system: MERGE_SYSTEM })).trim();
      if (raw) return raw;
    } catch {
      // fall through to the heuristic
    }
    return heuristicMerge(texts, this.cfg.llm.heuristicMergeChars);
  }
}

export class HeuristicRewriter implements Rewriter {
  private readonly mergeChars: number;

  constructor(mergeChars: number) {
    this.mergeChars = mergeChars;
  }

  beginPass(): void {}

  async blur(texts: string[]): Promise<string[]> {
    return texts.map(heuristicBlur);
  }

  async merge(texts: string[]): Promise<string> {
    return heuristicMerge(texts, this.mergeChars);
  }
}

const RERANK_SYSTEM =
  'Ricevi una domanda e un elenco numerato di ricordi. Ordina i numeri dal ricordo più pertinente alla domanda al meno pertinente. ' +
  'Rispondi SOLO con un array JSON di numeri interi.';

/** Orders candidate indexes by relevance; undefined when the model output is unusable. */
export async function rerankOrder(model: TextModel, modelId: string, maxTokens: number, query: string, texts: string[]): Promise<number[] | undefined> {
  try {
    const prompt = `Domanda: ${query}\n\nRicordi:\n${texts.map((t, i) => `${i}. ${t}`).join('\n')}`;
    const arr = parseJsonArray(await model.complete(prompt, { model: modelId, maxTokens, system: RERANK_SYSTEM }));
    if (!arr) return undefined;
    const seen = new Set<number>();
    for (const v of arr) if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < texts.length) seen.add(v);
    return seen.size > 0 ? [...seen] : undefined;
  } catch {
    return undefined;
  }
}
