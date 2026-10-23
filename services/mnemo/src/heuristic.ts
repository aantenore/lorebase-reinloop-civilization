// Offline stand-in for the LLM rewriter: deterministic, Italian-language text degradation.
// Blur rounds numbers, replaces coordinates with a vague place and trims trailing clauses;
// merge builds one gist sentence out of the shortest blurred texts.

const DECADES: Record<number, string> = {
  10: 'una decina',
  20: 'una ventina',
  30: 'una trentina',
  40: 'una quarantina',
  50: 'una cinquantina',
  60: 'una sessantina',
  70: 'una settantina',
  80: 'un\'ottantina',
  90: 'una novantina',
};
const COORDS = /\s*\(\s*-?\d+\s*[,;]\s*-?\d+\s*\)/g;
const PARENS = /\s*\([^)]*\)/g;
const NUMBER = /(?<!circa )\b\d+(?:[.,]\d+)?\b/g;
const CLAUSE_SPLIT = /\s*[,;]\s+|\s+(?:ma|mentre|perché|quindi)\s+/;
const MIN_KEEP_CHARS = 12;
const MERGE_PREFIX = 'Ricordo vagamente che: ';
const MERGE_SEP = '; ';

function roundNumber(raw: string): string {
  const n = Number(raw.replace(',', '.'));
  if (n < 10) return Number.isInteger(n) ? raw : `circa ${Math.round(n)}`;
  if (n < 100) {
    const r = Math.round(n / 10) * 10;
    return DECADES[r] ?? `circa ${r}`;
  }
  const mag = Math.pow(10, String(Math.floor(n)).length - 1);
  return `circa ${Math.round(n / mag) * mag}`;
}

export function heuristicBlur(text: string): string {
  let t = text.replace(COORDS, ' lì vicino').replace(PARENS, '');
  t = t.replace(NUMBER, roundNumber);
  const parts = t.split(CLAUSE_SPLIT);
  if (parts.length >= 2) {
    const kept = parts.slice(0, -1).join(', ');
    if (kept.length >= MIN_KEEP_CHARS) t = kept + (/[.!?]\s*$/.test(text) ? '.' : '');
  }
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([.,;!?])/g, '$1').trim();
}

export function heuristicMerge(texts: string[], maxChars: number): string {
  const blurred = texts.map((t) => heuristicBlur(t).replace(/[.!?\s]+$/, '')).sort((a, b) => a.length - b.length);
  let body = '';
  for (const b of blurred) {
    const next = body ? body + MERGE_SEP + b : b;
    if (MERGE_PREFIX.length + next.length > maxChars) break;
    body = next;
  }
  if (!body) body = (blurred[0] ?? '').slice(0, Math.max(0, maxChars - MERGE_PREFIX.length));
  return MERGE_PREFIX + body + '.';
}
