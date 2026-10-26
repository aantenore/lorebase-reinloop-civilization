// The economy's catalog in the shared knowledge. The live world holds what the civilization
// knows: every Resource, the recipes known from the start, and each discovered Technology with
// its recipes. The hidden scope (config `economy.hiddenBranch`) holds the whole catalog,
// undiscovered technologies included; people never read it (their consultations only reach the
// live world). A discovery reaches the live world through a draft -> proposal -> accept, so the
// knowledge records who found what and when.
import type { Change, Knowledge } from '../ports/knowledge.ts';
import { type Catalog, type Discovery, type RecipeDef, recipeFrom, resourceFrom, type TechDef, techFrom } from './economy.ts';

export interface EconomyConfig {
  enabled: boolean;
  hiddenBranch: string;
  discoveryBranchPrefix: string;
  kinds: { resource: string; recipe: string; technology: string };
  relations: { unlockedBy: string; knownBy: string; consumes: string; produces: string; requires: string };
  minExperimentItems: number;
  maxTradeKinds: number;
  flowsMs: number;
  retryMs: number;
}

export interface LoadedEconomy {
  catalog: Catalog;
  discovered: Map<string, Discovery>;
}

const byCode = <T extends { code: string }>(items: T[]) => new Map(items.map((i) => [i.code, i]));

export class EconomyBook {
  private readonly knowledge: Knowledge;
  private readonly cfg: EconomyConfig;
  private queue: Array<{ tech: TechDef; recipes: RecipeDef[]; d: Discovery; session: string }> = [];
  private busy = false;
  written = 0;
  lastError: string | undefined;

  constructor(knowledge: Knowledge, cfg: EconomyConfig) {
    this.knowledge = knowledge;
    this.cfg = cfg;
  }

  /** Full catalog (hidden scope, falling back to the live world) and the technologies already discovered. */
  async load(): Promise<LoadedEconomy> {
    const k = this.cfg.kinds;
    const read = async (kind: string, scope?: string) => (await this.knowledge.readAll(kind, { scope })).items.map((r) => r.values);
    const hidden = (await this.knowledge.hasScope(this.cfg.hiddenBranch)) ? this.cfg.hiddenBranch : undefined;
    if (!hidden) console.warn(`[economy] hidden catalog "${this.cfg.hiddenBranch}" missing: only the recipes of the live world exist (seed the knowledge first)`);
    const [resources, recipes, techs, mainTechs] = await Promise.all([
      read(k.resource), read(k.recipe, hidden), read(k.technology, hidden), read(k.technology),
    ]);
    const catalog: Catalog = {
      resources: byCode(resources.map(resourceFrom)),
      recipes: byCode(recipes.map((r) => recipeFrom(r))),
      techs: byCode([...techs, ...mainTechs].map(techFrom)),
    };
    const discovered = new Map<string, Discovery>();
    for (const t of mainTechs) {
      if (t.discovered !== true && t.discovered !== 'true') continue;
      discovered.set(String(t.code), { by: String(t.discovered_by ?? ''), role: String(t.discovered_role ?? ''), day: Number(t.discovered_day ?? 0), minute: Number(t.discovered_minute ?? 0) });
    }
    return { catalog, discovered };
  }

  /** Records a discovery in the live world (queued, retried until it lands). */
  record(tech: TechDef, recipes: RecipeDef[], d: Discovery, session: string): void {
    this.queue.push({ tech, recipes, d, session });
    void this.drain();
  }

  get pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0]!;
        try {
          await this.write(job.tech, job.recipes, job.d, job.session);
          this.queue.shift();
          this.written++;
          this.lastError = undefined;
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          console.warn(`[economy] discovery of ${job.tech.code} not written yet: ${this.lastError}; retrying in ${this.cfg.retryMs} ms`);
          setTimeout(() => void this.drain(), this.cfg.retryMs);
          return;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async write(tech: TechDef, recipes: RecipeDef[], d: Discovery, session: string): Promise<void> {
    const r = this.cfg.relations;
    const changes: Change[] = [
      {
        action: 'upsert', kind: this.cfg.kinds.technology, key: tech.code,
        values: {
          code: tech.code, name: tech.name, description: tech.description, prerequisites: tech.prerequisites,
          discovered: true, discovered_by: d.by, discovered_role: d.role, discovered_day: d.day, discovered_minute: Math.floor(d.minute), session,
        },
        ...(tech.prerequisites.length ? { links: { [r.requires]: tech.prerequisites } } : {}),
      },
      ...recipes.map((x) => recipeChange(this.cfg, x)),
    ];
    const p = await this.knowledge.propose({
      draft: `${this.cfg.discoveryBranchPrefix}${tech.code}-${Date.now().toString(36)}`,
      title: `Discovery: ${tech.name}`,
      description: `${d.by} (${d.role}) discovered ${tech.code} on day ${d.day}.`,
      message: `Discovery: ${tech.name} by ${d.by}`,
      changes,
    });
    try {
      await this.knowledge.review(p.id, 'approve', 'Recorded by the world');
      await this.knowledge.accept(p.id, `Discovery: ${tech.name} by ${d.by}`);
    } catch (err) {
      await this.knowledge.reject(p.id).catch(() => this.knowledge.discardDraft(p.draft).catch(() => undefined));
      throw err;
    }
  }
}

/** A Recipe record with its links (role, technology, inputs, outputs). */
export function recipeChange(cfg: Pick<EconomyConfig, 'kinds' | 'relations'>, x: RecipeDef): Change {
  const r = cfg.relations;
  const links: Record<string, string | string[]> = {
    [r.consumes]: Object.keys(x.inputs),
    [r.produces]: Object.keys(x.outputs),
  };
  if (x.role) links[r.knownBy] = x.role;
  if (x.tech) links[r.unlockedBy] = x.tech;
  return {
    action: 'upsert', kind: cfg.kinds.recipe, key: x.code, links,
    values: {
      code: x.code, name: x.name, description: x.description, inputs: x.inputs, outputs: x.outputs, tools: x.tools,
      ...(x.role ? { role: x.role } : {}), ...(x.tech ? { tech: x.tech } : {}), ...(x.station ? { station: x.station } : {}), minutes: x.minutes,
    },
  };
}
