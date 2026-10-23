// Test helper: the repo's default config with an in-memory database and the hash embedder.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, type MnemoConfig } from './config.ts';

export function testConfig(patch: (c: MnemoConfig) => void = () => {}): MnemoConfig {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'config/mnemo.json'), 'utf8')) as MnemoConfig;
  cfg.db.path = ':memory:';
  cfg.embedder.provider = 'hash';
  cfg.llm.provider = 'heuristic';
  patch(cfg);
  return cfg;
}
