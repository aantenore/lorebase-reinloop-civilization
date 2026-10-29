// Plan to turn archive branches into tags (tags do not count against the Keeper's materialized-branch cap).
export type ArchiveStep =
  | { action: 'tag'; name: string; head: string }
  | { action: 'skip'; name: string; reason: string };

/**
 * One step per branch under `prefix`: tag it at its head (the branch is deleted first, a name cannot be
 * both). Branches whose name is already a tag are left alone. Re-running after a full run plans nothing.
 */
export function planArchiveToTags(
  branches: Array<{ name: string; head: string; protected?: boolean }>,
  tags: Array<{ name: string; revision: string }>,
  prefix: string,
): ArchiveStep[] {
  const tagged = new Set(tags.map((t) => t.name));
  return branches
    .filter((b) => b.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b): ArchiveStep => {
      if (b.protected) return { action: 'skip', name: b.name, reason: 'protected branch' };
      if (tagged.has(b.name)) return { action: 'skip', name: b.name, reason: 'a tag with this name exists' };
      return { action: 'tag', name: b.name, head: b.head };
    });
}
