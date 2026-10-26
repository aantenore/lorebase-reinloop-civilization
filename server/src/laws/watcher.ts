// Follows the laws and roles of the live world: every revision touching them triggers a reload
// of those records and a diff against the previous snapshot. Reloads are serialized, so change
// events never interleave.
import type { Knowledge, Revision, Watch } from '../ports/knowledge.ts';
import { diffRoles, diffRules, type LawKinds, loadRules, type RoleChange, type RuleChange, type RuleSnapshot } from './laws.ts';

export interface LawWatcherHandlers {
  onChange(snapshot: RuleSnapshot, changes: RuleChange[], roleChanges: RoleChange[], rev?: Revision): void;
  onStatus(connected: boolean, detail: string): void;
}

export class LawWatcher {
  current: RuleSnapshot = { revision: '', rules: [], roles: [] };
  private readonly knowledge: Knowledge;
  private readonly kinds: LawKinds;
  private readonly handlers: LawWatcherHandlers;
  private watch: Watch | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(knowledge: Knowledge, kinds: LawKinds, handlers: LawWatcherHandlers) {
    this.knowledge = knowledge;
    this.kinds = kinds;
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.watch?.connected ?? false;
  }

  /** Loads the first snapshot (throws when the knowledge is unreachable) and starts following it. */
  async start(): Promise<RuleSnapshot> {
    this.current = await loadRules(this.knowledge, this.kinds);
    this.watch?.stop();
    this.watch = this.knowledge.watch(
      { kinds: [this.kinds.ruleKind, this.kinds.roleKind], since: () => this.current.revision },
      { onRevision: (rev) => void this.refresh(rev), onStatus: (c, d) => this.handlers.onStatus(c, d) },
    );
    return this.current;
  }

  stop(): void {
    this.watch?.stop();
    this.watch = undefined;
  }

  private refresh(rev?: Revision): Promise<void> {
    this.queue = this.queue.then(async () => {
      const next = await loadRules(this.knowledge, this.kinds);
      const changes = diffRules(this.current.rules, next.rules);
      const roleChanges = diffRoles(this.current.roles, next.roles);
      const moved = next.revision !== this.current.revision;
      this.current = next;
      if (changes.length || roleChanges.length || (rev && moved)) this.handlers.onChange(next, changes, roleChanges, rev);
    }).catch((err) => this.handlers.onStatus(false, `reload failed: ${err instanceof Error ? err.message : err}`));
    return this.queue;
  }
}
