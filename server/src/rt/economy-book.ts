// The economy's catalog in Lorebase. `main` holds what the civilization knows: every Resource,
// the recipes known from the start, and each discovered Technology with its recipes. The
// hidden branch (config `economy.hiddenBranch`) holds the whole catalog, undiscovered
// technologies included; agents never read it (their Lorebase tools are pinned to `main`).
// A discovery is merged into `main` through a branch -> Proposal -> merge, so the knowledge
// graph records who found what and when.
import { randomUUID } from 'node:crypto';
import type { LorebaseClient, RecordItem } from '../lorebase/client.ts';
import { type Catalog, type Discovery, type RecipeDef, recipeFrom, resourceFrom, type TechDef, techFrom } from './economy.ts';

export interface EconomyConfig {
  enabled: boolean;
  hiddenBranch: string;
  discoveryBranchPrefix: string;
  kinds: { resource: string; recipe: string; technology: string };
  relations: { unlockedBy: string; knownBy: string; consumes: string; produces: string; requires: string };
  importOperation: string;
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
  private readonly client: LorebaseClient;
  private readonly cfg: EconomyConfig;
  private readonly main: string;
  private queue: Array<{ tech: TechDef; recipes: RecipeDef[]; d: Discovery; session: string }> = [];
  private busy = false;
  written = 0;
  lastError: string | undefined;

  constructor(client: LorebaseClient, main: string, cfg: EconomyConfig) {
    this.client = client;
    this.main = main;
    this.cfg = cfg;
  }

  /** Full catalog (hidden branch, falling back to main) and the technologies already discovered on main. */
  async load(): Promise<LoadedEconomy> {
    const k = this.cfg.kinds;
    const read = async (kind: string, branch: string) => (await this.client.listRecords(kind, branch)).items.map((r: RecordItem) => r.values);
    const hidden = await this.client.getBranch(this.cfg.hiddenBranch).then(() => this.cfg.hiddenBranch, () => undefined);
    if (!hidden) console.warn(`[economy] hidden branch "${this.cfg.hiddenBranch}" missing: only recipes on ${this.main} exist (run: npm run lorebase:seed)`);
    const src = hidden ?? this.main;
    const [resources, recipes, techs, mainTechs] = await Promise.all([
      read(k.resource, this.main), read(k.recipe, src), read(k.technology, src), read(k.technology, this.main),
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

  /** Records a discovery on main (queued, retried until it lands). */
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
    const branch = `${this.cfg.discoveryBranchPrefix}${tech.code}-${Date.now().toString(36)}`;
    const records = [
      {
        kind: this.cfg.kinds.technology, code: tech.code, name: tech.name, description: tech.description, prerequisites: tech.prerequisites,
        discovered: true, discovered_by: d.by, discovered_role: d.role, discovered_day: d.day, discovered_minute: Math.floor(d.minute), session,
        ...(tech.prerequisites.length ? { links: { [r.requires]: tech.prerequisites } } : {}),
      },
      ...recipes.map((x) => recipeRow(this.cfg, x)),
    ];
    await this.client.createBranch(branch, this.main);
    try {
      await this.client.execute(this.cfg.importOperation, { records }, { branch, message: `Discovery: ${tech.name} by ${d.by}`, idempotencyKey: randomUUID() });
      const p = await this.client.createProposal(branch, this.main, `Discovery: ${tech.name}`, `${d.by} (${d.role}) discovered ${tech.code} on day ${d.day}.`);
      await this.client.review(p.id, 'approve', 'Recorded by the world');
      await this.client.merge(p.id, `Discovery: ${tech.name} by ${d.by}`);
    } finally {
      await this.client.deleteBranch(branch).catch(() => undefined);
    }
  }
}

/** A Recipe row for import_batch, with its Links (role, technology, inputs, outputs). */
export function recipeRow(cfg: Pick<EconomyConfig, 'kinds' | 'relations'>, x: RecipeDef): Record<string, unknown> {
  const r = cfg.relations;
  const links: Record<string, unknown> = {
    [r.consumes]: Object.keys(x.inputs),
    [r.produces]: Object.keys(x.outputs),
  };
  if (x.role) links[r.knownBy] = x.role;
  if (x.tech) links[r.unlockedBy] = x.tech;
  return {
    kind: cfg.kinds.recipe, code: x.code, name: x.name, description: x.description, inputs: x.inputs, outputs: x.outputs, tools: x.tools,
    ...(x.role ? { role: x.role } : {}), ...(x.tech ? { tech: x.tech } : {}), ...(x.station ? { station: x.station } : {}), minutes: x.minutes, links,
  };
}
