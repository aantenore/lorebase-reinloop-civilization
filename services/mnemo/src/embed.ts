// Text embedders. Preferred: a local multilingual sentence model (transformers.js, e5 prefixes).
// Fallback chain when it cannot load (offline, error): LLM concept tags hashed into a sparse
// vector (`claude-concepts`), then, as the last resort that works with no network and no key,
// a hashed bag-of-words (`hash`).
import type { MnemoConfig } from './config.ts';
import type { TextModel } from './llm.ts';

export interface Embedder {
  name: string;
  dim: number;
  embed(texts: string[], mode: 'query' | 'passage'): Promise<Float32Array[]>;
}

const WORD = /[\p{L}\p{N}]+/gu;
const MIN_WORD = 2;
const STEM_MIN = 5;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function words(text: string): string[] {
  const norm = text.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  return (norm.match(WORD) ?? []).filter((w) => w.length >= MIN_WORD);
}

/** Crude suffix strip (final vowel / plural) so that gatto/gatti/gatta share a feature. */
export function stem(w: string): string {
  return w.length >= STEM_MIN ? w.replace(/[aeiou]+$/, '') : w;
}

function addFeature(vec: Float32Array, token: string, weight: number): void {
  const h = fnv1a(token);
  vec[h % vec.length]! += (h & 0x80000000) === 0 ? weight : -weight;
}

function normalize(vec: Float32Array): Float32Array {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / n;
  return vec;
}

export class HashEmbedder implements Embedder {
  readonly name = 'hash';
  readonly dim: number;

  constructor(dim: number) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const w of words(t)) addFeature(v, stem(w), 1);
      return normalize(v);
    });
  }
}

const CONCEPT_SYSTEM =
  'Estrai da un testo da 5 a 12 concetti chiave come tag in minuscolo (una o due parole ciascuno, al singolare, nella lingua del testo; ' +
  'includi sinonimi e categorie generali utili a ritrovare il testo con parole diverse). Rispondi SOLO con un array JSON di stringhe.';

export class ClaudeConceptsEmbedder implements Embedder {
  readonly name = 'claude-concepts';
  readonly dim: number;
  private readonly llm: TextModel;
  private readonly cfg: MnemoConfig['embedder'];

  constructor(llm: TextModel, cfg: MnemoConfig['embedder']) {
    this.llm = llm;
    this.cfg = cfg;
    this.dim = cfg.conceptDim;
  }

  private async tags(text: string): Promise<string[]> {
    try {
      const raw = await this.llm.complete(text, { model: this.cfg.conceptModel, maxTokens: this.cfg.conceptMaxTokens, system: CONCEPT_SYSTEM });
      const a = raw.indexOf('[');
      const b = raw.lastIndexOf(']');
      const arr = JSON.parse(raw.slice(a, b + 1)) as unknown[];
      return arr.filter((t): t is string => typeof t === 'string');
    } catch {
      return [];
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) {
      const v = new Float32Array(this.dim);
      for (const tag of await this.tags(t)) for (const w of words(tag)) addFeature(v, stem(w), 1);
      for (const w of words(t)) addFeature(v, stem(w), this.cfg.conceptWordWeight);
      out.push(normalize(v));
    }
    return out;
  }
}

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

export class TransformersEmbedder implements Embedder {
  name: string;
  dim = 0;
  private readonly cfg: MnemoConfig['embedder'];
  private extractor: Extractor | undefined;

  constructor(cfg: MnemoConfig['embedder']) {
    this.cfg = cfg;
    this.name = `transformers:${cfg.model}:${cfg.dtype}`;
  }

  /** Loads the model (downloads it into cacheDir on first use) and probes the vector size. */
  async init(): Promise<void> {
    const tf = await import('@huggingface/transformers');
    tf.env.cacheDir = this.cfg.cacheDir;
    this.extractor = (await tf.pipeline('feature-extraction', this.cfg.model, { dtype: this.cfg.dtype as 'q8', cache_dir: this.cfg.cacheDir })) as unknown as Extractor;
    this.dim = (await this.embed(['init'], 'passage'))[0]!.length;
  }

  async embed(texts: string[], mode: 'query' | 'passage'): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error('embedder not initialised');
    const prefix = mode === 'query' ? this.cfg.queryPrefix : this.cfg.passagePrefix;
    const out = await this.extractor(
      texts.map((t) => prefix + t),
      { pooling: 'mean', normalize: true },
    );
    const dim = out.dims[out.dims.length - 1]!;
    return texts.map((_, i) => Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
  }
}

export interface EmbedderChoice {
  embedder: Embedder;
  /** True when the configured provider could not be used. */
  fallback: boolean;
}

export async function createEmbedder(cfg: MnemoConfig, llm: TextModel | undefined, log: (msg: string) => void = console.warn): Promise<EmbedderChoice> {
  const want = cfg.embedder.provider;
  if (want === 'transformers') {
    try {
      const t = new TransformersEmbedder(cfg.embedder);
      await t.init();
      return { embedder: t, fallback: false };
    } catch (err) {
      log(`mnemo: transformers embedder unavailable (${(err as Error).message}); falling back`);
    }
  }
  if (want !== 'hash' && llm) return { embedder: new ClaudeConceptsEmbedder(llm, cfg.embedder), fallback: want !== 'claude-concepts' };
  if (want === 'claude-concepts') log('mnemo: claude-concepts needs an Anthropic key; using hash embedder');
  else if (want === 'transformers') log('mnemo: no Anthropic key; using local hash embedder (last resort, lexical only)');
  return { embedder: new HashEmbedder(cfg.embedder.conceptDim), fallback: want !== 'hash' };
}
