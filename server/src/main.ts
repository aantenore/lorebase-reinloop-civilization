// Entry point: `node server/src/main.ts [--mock] [--start] [--ticks N] [--verbose]`.
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { Simulation } from './sim/sim.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = loadConfig(argv);
const maxTicks = Number(flag('--ticks') ?? 0);
const verbose = argv.includes('--verbose');
if (maxTicks > 0) cfg.autoStart = true;

const sim = new Simulation(cfg);
sim.subscribe((ev) => {
  switch (ev.type) {
    case 'tick': {
      const s = ev.stats as { population: number; food: number; wood: number; shelters: number; avgHp: number; byTier: Record<string, { alive: number }> };
      const tiers = Object.entries(s.byTier).map(([t, v]) => `${t}:${v.alive}`).join(' ');
      console.log(`[tick ${ev.tick}] ${ev.season} pop ${s.population} (${tiers}) food ${s.food} wood ${s.wood} shelters ${s.shelters} avgHp ${s.avgHp}`);
      if (maxTicks > 0 && Number(ev.tick) >= maxTicks) setImmediate(stop);
      break;
    }
    case 'world_event':
      console.log(`  * ${ev.kind}: ${ev.text}`);
      break;
    case 'message':
      if (verbose) console.log(`  > ${ev.from} -> ${ev.to}: ${ev.text}`);
      break;
    case 'agent_action':
      if (verbose) console.log(`  - ${ev.agentId} ${ev.tool} ${JSON.stringify(ev.args)} ${ev.ok ? 'ok' : 'FAILED'}: ${String(ev.result).split('\n')[0]}`);
      break;
  }
});

const server = createHttpServer(sim);
server.listen(cfg.http.port, cfg.http.host, () => {
  const s = sim.status();
  console.log(`civilization server on http://${cfg.http.host}:${cfg.http.port} (provider ${s.provider}${cfg.modelOverride ? `, all agents on ${cfg.modelOverride}` : ''})`);
});

function stop(): void {
  sim.shutdown();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await sim.init();
