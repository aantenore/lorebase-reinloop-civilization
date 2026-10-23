const SYL_A = ['Ar', 'Be', 'Cal', 'Da', 'El', 'Fen', 'Ga', 'Hal', 'Io', 'Ka', 'Lu', 'Mo', 'Ny', 'Or', 'Pe', 'Qu', 'Ro', 'Sa', 'Tam', 'Ul', 'Ve', 'Wy', 'Ya', 'Zel'];
const SYL_B = ['ra', 'lin', 'do', 'mir', 'sa', 'ven', 'ka', 'th', 'wen', 'ric', 'na', 'lo', 'is', 'ten', 'ya', 'bel'];

export function randomName(taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  for (let i = 0; i < 50; i++) {
    const n = SYL_A[Math.floor(Math.random() * SYL_A.length)] + SYL_B[Math.floor(Math.random() * SYL_B.length)];
    if (!used.has(n.toLowerCase())) return n;
  }
  return `Soul${Math.floor(Math.random() * 1000)}`;
}
