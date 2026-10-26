// Composition root: the one place that picks the adapters behind the two ports, from config
// (`knowledge.adapter` in config/sim.json, `memory.adapter` in config/game.json; KNOWLEDGE_ADAPTER
// and MEMORY_ADAPTER override). Everything else depends on the ports only.
import { LorebaseKnowledge } from './adapters/knowledge/lorebase/index.ts';
import { MemoryKnowledge } from './adapters/knowledge/memory/index.ts';
import { InMemoryMemory } from './adapters/memory/inmem/index.ts';
import { Mnemo } from './adapters/memory/mnemo/mnemo.ts';
import { ROOT, type SimConfig } from './config.ts';
import type { Knowledge } from './ports/knowledge.ts';
import type { Memory } from './ports/memory.ts';
import type { GameConfig } from './rt/config.ts';
import { economyChanges, hiddenChanges, lawChanges, loadSeed } from './seed.ts';

export function createKnowledge(sim: SimConfig, game?: Pick<GameConfig, 'economy'>): Knowledge {
  const k = sim.knowledge;
  if (k.adapter === 'memory') {
    // Nothing persists: the knowledge starts from the seed at every boot.
    const seed = loadSeed(ROOT, k.seed);
    const eco = game?.economy;
    return new MemoryKnowledge(k.memory, {
      live: [...lawChanges(seed, k), ...(eco ? economyChanges(seed, eco) : [])],
      scopes: eco ? { [eco.hiddenBranch]: hiddenChanges(seed, eco, new Set()) } : {},
    });
  }
  return new LorebaseKnowledge(k.lorebase, { root: ROOT, pollMs: k.pollMs });
}

/** The knowledge an admin script works on: it must outlive this process (not the in-process adapter). */
export function scriptKnowledge(sim: SimConfig, game?: Pick<GameConfig, 'economy'>): Knowledge {
  if (sim.knowledge.adapter === 'memory') {
    console.error('knowledge.adapter is "memory": that knowledge lives inside the running game only (use its HTTP API, or KNOWLEDGE_ADAPTER=lorebase)');
    process.exit(2);
  }
  return createKnowledge(sim, game);
}

export function createMemory(game: Pick<GameConfig, 'memory'>): Memory {
  const m = game.memory;
  return m.adapter === 'inmem' ? new InMemoryMemory(m) : new Mnemo(m);
}

export function createAdapters(sim: SimConfig, game: GameConfig): { knowledge: Knowledge; memory: Memory } {
  return { knowledge: createKnowledge(sim, game), memory: createMemory(game) };
}
