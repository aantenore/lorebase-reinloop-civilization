// Vote tally of the `assembly` group pattern. Pure.
export interface Tally {
  /** Index of the winning proposal. */
  winner: number;
  /** Votes per proposal index. */
  counts: number[];
  /** Valid votes cast. */
  valid: number;
  /** True when the winner has more than half of the valid votes. */
  majority: boolean;
  /** True when the top count was shared and the tie-break decided. */
  tie: boolean;
}

/**
 * Counts votes (each a proposal index) over `proposals` options. Invalid votes are ignored.
 * Plurality wins; a tie goes to the tied proposal listed first in `tieBreak` (default: lowest index).
 */
export function tally(votes: Array<number | null | undefined>, proposals: number, tieBreak: number[] = []): Tally {
  const counts = Array.from({ length: Math.max(0, proposals) }, () => 0);
  let valid = 0;
  for (const v of votes) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < proposals) {
      counts[v]!++;
      valid++;
    }
  }
  if (!proposals) return { winner: -1, counts, valid, majority: false, tie: false };
  const top = Math.max(...counts);
  const leaders = counts.flatMap((c, i) => (c === top ? [i] : []));
  const order = [...tieBreak.filter((i) => leaders.includes(i)), ...leaders];
  const winner = order[0]!;
  return { winner, counts, valid, majority: valid > 0 && top * 2 > valid, tie: leaders.length > 1 };
}
