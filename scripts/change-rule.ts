// Changes one law in Lorebase. The running simulation learns of it from the Lorebase change feed.
//   node scripts/change-rule.ts <key> <value> [--mode direct|proposal] [-m "message"]
import { loadConfig } from '../server/src/config.ts';
import { LorebaseClient } from '../server/src/lorebase/client.ts';
import { loadRules } from '../server/src/lorebase/rules.ts';
import { writeRules, type WriteMode } from '../server/src/lorebase/writer.ts';

const args = process.argv.slice(2);
const opt = (names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const mode = (opt(['--mode']) ?? 'proposal') as WriteMode;
const message = opt(['-m', '--message']);
const [key, raw] = args;
if (!key || raw === undefined || !['direct', 'proposal'].includes(mode)) {
  console.error('usage: node scripts/change-rule.ts <key> <value> [--mode direct|proposal] [-m "message"]');
  process.exit(2);
}
const cfg = loadConfig([]);
const client = new LorebaseClient(cfg.lorebase.url, cfg.lorebase.domain);
const before = await loadRules(client, cfg.lorebase, cfg.lorebase.branch);
const rule = before.rules.find((r) => r.key === key);
if (!rule) {
  console.error(`unknown rule "${key}"; known: ${before.rules.map((r) => r.key).join(', ')}`);
  process.exit(2);
}
const value = Number(raw);
const out = await writeRules(client, cfg.lorebase, [{ key, value }], mode, message ?? `Set ${key} to ${value}`);
if (!out.ok) {
  console.error(`failed: ${out.error}`);
  process.exit(1);
}
console.log(`${key}: ${rule.value} -> ${value} (${mode}${out.proposalId ? `, proposal ${out.proposalId}` : ''}) @ ${out.revision?.slice(0, 12) ?? '?'}`);
