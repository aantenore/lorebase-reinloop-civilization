// Changes one law in Lorebase, or creates a new one. The running world learns of it from the
// Lorebase change feed.
//   node scripts/change-rule.ts <key> <value> [--mode direct|proposal] [-m "message"]
//   node scripts/change-rule.ts --new <key> --text "..." --category society [--value 1] [--unit "..."] [--mode ...] [-m "..."]
//   node scripts/change-rule.ts --repeal <key> [--mode ...] [-m "..."]
import { loadConfig } from '../server/src/config.ts';
import { LorebaseClient } from '../server/src/lorebase/client.ts';
import { loadRules } from '../server/src/lorebase/rules.ts';
import { createRule, repealRule, writeRules, type WriteMode } from '../server/src/lorebase/writer.ts';

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
const newKey = opt(['--new']);
const repealKey = opt(['--repeal']);
const cfg = loadConfig([]);
const client = new LorebaseClient(cfg.lorebase.url, cfg.lorebase.domain);
if (!['direct', 'proposal'].includes(mode)) {
  console.error('--mode must be direct or proposal');
  process.exit(2);
}

if (newKey) {
  const text = opt(['--text']);
  const category = opt(['--category']) ?? 'society';
  const value = Number(opt(['--value']) ?? 1);
  const unit = opt(['--unit']);
  if (!text) {
    console.error('usage: node scripts/change-rule.ts --new <key> --text "..." --category society [--value 1] [--unit "..."]');
    process.exit(2);
  }
  const out = await createRule(client, cfg.lorebase, { key: newKey, value, text, category, unit }, mode, message ?? `New law ${newKey}`);
  if (!out.ok) {
    console.error(`failed: ${out.error}`);
    process.exit(1);
  }
  console.log(`${newKey}: new law (${mode}${out.proposalId ? `, proposal ${out.proposalId}` : ''}) @ ${out.revision?.slice(0, 12) ?? '?'}`);
  process.exit(0);
}

if (repealKey) {
  const out = await repealRule(client, cfg.lorebase, repealKey, mode, message ?? `Repeal ${repealKey}`);
  if (!out.ok) {
    console.error(`failed: ${out.error}`);
    process.exit(1);
  }
  console.log(`${repealKey}: repealed (${mode}${out.proposalId ? `, proposal ${out.proposalId}` : ''}) @ ${out.revision?.slice(0, 12) ?? '?'}`);
  process.exit(0);
}

const [key, raw] = args;
if (!key || raw === undefined) {
  console.error('usage: node scripts/change-rule.ts <key> <value> [--mode direct|proposal] [-m "message"]  |  --new <key> --text "..." --category <c>');
  process.exit(2);
}
const before = await loadRules(client, cfg.lorebase, cfg.lorebase.branch);
const rule = before.rules.find((r) => r.key === key);
if (!rule) {
  console.error(`unknown rule "${key}"; known: ${before.rules.map((r) => r.key).join(', ')} (to create one: --new ${key} --text "...")`);
  process.exit(2);
}
const value = Number(raw);
const out = await writeRules(client, cfg.lorebase, [{ key, value }], mode, message ?? `Set ${key} to ${value}`);
if (!out.ok) {
  console.error(`failed: ${out.error}`);
  process.exit(1);
}
console.log(`${key}: ${rule.value} -> ${value} (${mode}${out.proposalId ? `, proposal ${out.proposalId}` : ''}) @ ${out.revision?.slice(0, 12) ?? '?'}`);
