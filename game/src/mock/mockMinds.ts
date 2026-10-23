import type { GameTime, Insight, InsightList, Memory, ServerMsg } from '../net/protocol';

/** What the minds engine needs from the world. */
export interface MindsHost {
  emit(m: ServerMsg): void;
  r(): number;
  now(): GameTime;
  agents(): { id: string; name: string; role: string }[];
}

export const ROLE_IT: Record<string, string> = {
  chief: 'capo',
  woodcutter: 'taglialegna',
  builder: 'costruttore',
  elder: 'anziano',
  healer: 'guaritore',
  scout: 'esploratore',
  gatherer: 'raccoglitore',
  hunter: 'cacciatore',
  wanderer: 'viandante',
};

/** Shared role consciousness: the first ones are seeded as accepted, the rest get proposed over time. */
const INSIGHT_POOL: Record<string, string[]> = {
  gatherer: [
    'D’inverno le bacche marciscono in fretta: meglio affumicare la carne e tenere le bacche per i primi giorni.',
    'Un cespuglio svuotato ci mette giorni a ricrescere: ruotare i cespugli rende di più.',
    'Con un cesto si porta il doppio e le bacche si ammaccano meno.',
    'Le erbe vanno consegnate alla guaritrice entro sera, altrimenti appassiscono.',
    'Un vaso di ceramica tiene le bacche fresche molto più a lungo.',
    'Fibre e erbe crescono vicino al fiume: conviene passare di là prima di rientrare.',
  ],
  woodcutter: [
    'Un’ascia di pietra ben affilata dura più a lungo: non colpire mai i sassi alla base.',
    'Con la neve gli alberi sono più duri: meglio tagliare la mattina presto.',
    'Dieci legna bastano a un riparo: portarle al costruttore prima di sera.',
    'Una legna ogni due giri va tenuta da parte per il fuoco dell’anziano.',
    'Se l’ascia scricchiola, chiedine una nuova al costruttore prima che si spezzi.',
    'Tagliare sempre gli alberi più vecchi lascia al bosco il tempo di ricrescere.',
  ],
  builder: [
    'Pietra e legna si consegnano insieme: un viaggio in meno per tutti.',
    'Un riparo senza fondamenta cede alla prima neve.',
    'Le asce si fanno con due legna e una pietra: ne servono sempre di scorta.',
    'Le ceste si intrecciano meglio con fibre appena raccolte, ancora umide.',
    'Prima il tetto, poi le pareti: la pioggia rovina più del vento.',
    'Con l’argilla cotta si faranno mattoni più solidi della sola pietra.',
  ],
  healer: [
    'L’impiastro funziona meglio con erbe fresche, non più vecchie di un giorno.',
    'Chi dorme all’aperto d’inverno si ammala: segnalare subito chi non ha un riparo.',
    'Fame e freddo insieme sono il rischio peggiore: prima il cibo, poi il fuoco.',
    'Le erbe amare vanno separate da quelle dolci: non si mescolano nello stesso impiastro.',
    'Un impiastro per ogni taglialegna a inizio settimana evita molte ferite.',
  ],
  scout: [
    'La pietra migliore sta nei pendii a nord del lago.',
    'L’argilla si trova dove il fiume rallenta: segnare il punto per l’anziano.',
    'Con la neve i sentieri a nord si chiudono: tornare prima del tramonto.',
    'Il ponte è più sicuro del guado quando il fiume è alto.',
    'Prima di partire avvisare il costruttore su cosa serve: si risparmiano viaggi a vuoto.',
  ],
  hunter: [
    'Gli animali scappano controvento: avvicinarsi sempre da sottovento.',
    'La carne fresca dura mezza giornata: affumicarla appena possibile.',
    'Un impiastro in tasca vale più di una lancia in più.',
    'Parlare piano nel bosco: la voce porta lontano.',
    'La carne si divide tra chi ha lavorato e chi ha fame, senza scordare l’anziano.',
  ],
  elder: [
    'Le leggi cambiano, i bisogni restano: ascolta Lorebase prima di decidere.',
    'Un vaso di argilla cotta vale più di dieci ceste per conservare il cibo.',
    'Ogni ruolo ha bisogno di un altro: nessuno è autosufficiente.',
    'Il fuoco non va mai lasciato spegnere: è il cuore dei mestieri più importanti.',
    'Chi scopre qualcosa lo racconti la stessa sera: ciò che si sa in uno si sa in tutti.',
  ],
  chief: [
    'Prima le scorte, poi l’avventura.',
    'Un clan che parla poco decide male: riunirsi al fuoco ogni sera.',
    'Chiedere aiuto non è debolezza: il villaggio regge perché ci si scambia i beni.',
    'Prima di cambiare una legge, ascoltare chi la vive ogni giorno.',
  ],
};

interface MemSeed { text: string; topic: string; importance: number; emotion: string }

const GENERIC_SEEDS: MemSeed[] = [
  { text: 'Ho passato la mattina a lavorare vicino al fiume.', topic: 'work', importance: 0.25, emotion: 'fatica' },
  { text: 'Ieri ho portato il carico fino al mucchio della legna.', topic: 'work', importance: 0.25, emotion: 'fatica' },
  { text: 'Ho fatto un lungo giro al tramonto con il sacco pesante.', topic: 'work', importance: 0.2, emotion: 'stanchezza' },
  { text: 'Ho parlato con Aurelia davanti al fuoco, a sera.', topic: 'talk', importance: 0.35, emotion: 'calma' },
  { text: 'Ho scambiato due parole con un viandante sul sentiero.', topic: 'talk', importance: 0.3, emotion: 'curiosità' },
  { text: 'Una sera il villaggio ha discusso a lungo delle leggi.', topic: 'law', importance: 0.55, emotion: 'curiosità' },
];

const ROLE_SEEDS: Record<string, MemSeed[]> = {
  woodcutter: [
    { text: 'Un grosso albero mi ha quasi schiacciato il piede.', topic: 'danger', importance: 0.85, emotion: 'paura' },
    { text: 'Ho tagliato il mio primo albero con l’ascia nuova.', topic: 'craft', importance: 0.6, emotion: 'gioia' },
  ],
  builder: [
    { text: 'La prima capanna è crollata sotto la pioggia.', topic: 'danger', importance: 0.8, emotion: 'rabbia' },
    { text: 'Ho finito il tetto con le ultime travi.', topic: 'craft', importance: 0.6, emotion: 'orgoglio' },
  ],
  healer: [
    { text: 'Ho curato Bruno con un impiastro di erbe fresche.', topic: 'craft', importance: 0.7, emotion: 'gioia' },
    { text: 'Un bambino aveva la febbre, ho vegliato tutta la notte.', topic: 'danger', importance: 0.85, emotion: 'paura' },
  ],
  scout: [
    { text: 'Ho visto un branco di lupi oltre il lago.', topic: 'danger', importance: 0.9, emotion: 'paura' },
    { text: 'Ho trovato una cava di pietra a nord.', topic: 'craft', importance: 0.65, emotion: 'gioia' },
  ],
  gatherer: [
    { text: 'Ho trovato un cespuglio carico di bacche vicino alle rocce.', topic: 'craft', importance: 0.6, emotion: 'gioia' },
    { text: 'Le bacche del cesto sono marcite prima di sera.', topic: 'danger', importance: 0.5, emotion: 'delusione' },
  ],
  hunter: [
    { text: 'Ho inseguito un cervo per mezza giornata e l’ho perso.', topic: 'danger', importance: 0.6, emotion: 'frustrazione' },
    { text: 'Ho portato la prima carne al villaggio.', topic: 'craft', importance: 0.7, emotion: 'orgoglio' },
  ],
  elder: [
    { text: 'Ricordo l’inverno lungo, quando il fuoco rimase acceso per sette giorni.', topic: 'danger', importance: 0.9, emotion: 'nostalgia' },
    { text: 'Ho insegnato ai giovani a custodire la brace.', topic: 'craft', importance: 0.6, emotion: 'serenità' },
  ],
  chief: [
    { text: 'Ho diviso le scorte tra tutti, anche se non bastavano.', topic: 'danger', importance: 0.85, emotion: 'preoccupazione' },
    { text: 'Il clan ha votato per restare al villaggio.', topic: 'law', importance: 0.6, emotion: 'orgoglio' },
  ],
};

const GIST: Record<string, string[]> = {
  work: ['Il lavoro quotidiano è fatica, ma ripaga.', 'Le giornate si assomigliano: portare, raccogliere, tornare.'],
  talk: ['Parlo spesso con gli altri del villaggio.', 'Ci si ritrova sempre attorno al fuoco a parlare.'],
  trade: ['Ci si aiuta a vicenda: chi ha di più dà a chi ha bisogno.', 'Gli scambi tengono insieme i mestieri.'],
  craft: ['So fabbricare ciò che serve, con pazienza.', 'Ogni cosa fatta bene dura di più.'],
  law: ['Le leggi cambiano, ma si impara ad adattarsi.'],
  discovery: ['Ogni tanto qualcuno scopre qualcosa e il villaggio cambia.'],
  danger: ['Il mondo può essere pericoloso: meglio stare attenti.'],
};

const VAGUE = ['…', 'qualcosa', 'da qualche parte', 'qualcuno'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Blur a memory text: the lower the fidelity, the more words melt into vague ones. */
export function degrade(orig: string, id: string, fidelity: number): string {
  const words = orig.split(' ');
  const cands = words.map((w, i) => ({ w, i })).filter(({ w }) => w.replace(/[^\p{L}\d]/gu, '').length > 3);
  const n = Math.min(cands.length, Math.round(cands.length * Math.max(0, (0.85 - fidelity) / 0.85) * 1.1));
  const hit = new Set(
    [...cands].sort((a, b) => hash(id + a.i) - hash(id + b.i)).slice(0, n).map((c) => c.i),
  );
  const out: string[] = [];
  words.forEach((w, i) => {
    if (!hit.has(i)) return void out.push(w);
    const tail = /[.,;!?]$/.test(w) ? w.slice(-1) : '';
    const rep = /^\p{Lu}/u.test(w) && i > 0 ? 'qualcuno' : /\d/.test(w) ? 'alcuni' : VAGUE[hash(id + w) % 2 === 0 ? 0 : 1];
    if (out[out.length - 1]?.replace(/[.,;!?]$/, '') === rep) return;
    out.push(rep + tail);
  });
  return out.join(' ');
}

interface Mem {
  m: Memory;
  orig: string;
  topic: string;
  /** Fidelity at the last blur/recall emit. */
  lastEmit: number;
}

const MAX_MEMS = 14;

/** Private memories (reinloop) and shared role insights (Lorebase), driven by the world clock. */
export class Minds {
  private mems = new Map<string, Mem[]>();
  private seq = 1;
  private clock = 0;
  private decayAt = 3;
  private recallAt = 4;
  private insightAt: number;
  private queue: { at: number; fn: () => void }[] = [];
  private pending: Insight[] = [];
  private stored: Insight[] = [];
  private used = new Map<string, Set<number>>();
  private insSeq = 1;

  constructor(private host: MindsHost, private roles: string[]) {
    this.insightAt = 6 + host.r() * 6;
    for (const role of Object.keys(INSIGHT_POOL)) this.seedInsights(role);
  }

  // ------------------------------------------------------------ memories

  seedAgent(id: string, role: string) {
    const h = this.host;
    const seeds = [...(ROLE_SEEDS[role] ?? []), ...GENERIC_SEEDS.filter((_, i) => i < 3 + Math.floor(h.r() * 2))].slice(0, 6);
    const list: Mem[] = seeds.map((s) => {
      const fid = 0.3 + h.r() * 0.6;
      const m: Memory = {
        id: this.newId(id),
        text: s.text,
        fidelity: +fid.toFixed(2),
        importance: s.importance,
        emotion: s.emotion,
        kind: 'episodic',
        createdAt: { day: 1, minute: Math.floor(h.r() * 420) },
        recalls: 0,
      };
      return { m: { ...m, text: degrade(s.text, m.id, m.fidelity) }, orig: s.text, topic: s.topic, lastEmit: m.fidelity };
    });
    this.mems.set(id, list);
  }

  remember(agentId: string, text: string, topic: string, importance: number, emotion: string) {
    const list = this.mems.get(agentId);
    if (!list) return;
    const m: Memory = { id: this.newId(agentId), text, fidelity: 1, importance, emotion, kind: 'episodic', createdAt: this.host.now(), recalls: 0 };
    list.push({ m, orig: text, topic, lastEmit: 1 });
    this.host.emit({ type: 'memory', agentId, action: 'added', memory: { ...m } });
    if (list.length > MAX_MEMS) {
      const weakest = list.reduce((p, c) => (c.m.fidelity < p.m.fidelity ? c : p));
      this.drop(agentId, weakest);
    }
  }

  rememberAll(text: string, topic: string, importance: number, emotion: string) {
    for (const a of this.host.agents()) this.remember(a.id, text, topic, importance, emotion);
  }

  memories(id: string): Memory[] | undefined {
    return this.mems.get(id)?.map((x) => ({ ...x.m }));
  }

  private newId(agentId: string): string {
    return `m-${agentId.replace(/^a-/, '')}-${this.seq++}`;
  }

  private drop(agentId: string, x: Mem) {
    const list = this.mems.get(agentId);
    if (!list) return;
    list.splice(list.indexOf(x), 1);
    this.host.emit({ type: 'memory', agentId, action: 'forgotten', memory: { ...x.m } });
  }

  private decayStep() {
    const h = this.host;
    for (const [agentId, list] of this.mems) {
      for (const x of [...list]) {
        const slow = x.m.kind === 'gist' ? 0.4 : 1;
        x.m.fidelity = Math.max(0, +(x.m.fidelity - (0.012 + 0.035 * (1 - x.m.importance)) * (0.6 + h.r() * 0.8) * slow).toFixed(3));
        if (x.m.fidelity < 0.12) {
          this.drop(agentId, x);
        } else if (x.lastEmit - x.m.fidelity >= 0.15) {
          x.lastEmit = x.m.fidelity;
          x.m.text = degrade(x.orig, x.m.id, x.m.fidelity);
          h.emit({ type: 'memory', agentId, action: 'blurred', memory: { ...x.m } });
        }
      }
      this.mergeStep(agentId);
      if (list.length < 3) this.remember(agentId, GENERIC_SEEDS[Math.floor(h.r() * 3)].text, 'work', 0.25, 'fatica');
    }
  }

  /** 3+ similar faded episodic memories collapse into one gist. */
  private mergeStep(agentId: string) {
    const list = this.mems.get(agentId);
    if (!list) return;
    const byTopic = new Map<string, Mem[]>();
    for (const x of list) if (x.m.kind === 'episodic' && x.m.fidelity < 0.5) byTopic.set(x.topic, [...(byTopic.get(x.topic) ?? []), x]);
    for (const [topic, group] of byTopic) {
      if (group.length < 3 || !GIST[topic]) continue;
      const pool = GIST[topic];
      const text = pool[Math.floor(this.host.r() * pool.length)];
      const emotions = new Map<string, number>();
      for (const g of group) emotions.set(String(g.m.emotion), (emotions.get(String(g.m.emotion)) ?? 0) + 1);
      const emotion = [...emotions.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const m: Memory = {
        id: this.newId(agentId),
        text,
        fidelity: 0.7,
        importance: Math.min(1, +(group.reduce((s, g) => s + g.m.importance, 0) / group.length + 0.1).toFixed(2)),
        emotion,
        kind: 'gist',
        createdAt: this.host.now(),
        recalls: 0,
      };
      for (const g of group) list.splice(list.indexOf(g), 1);
      list.push({ m, orig: text, topic, lastEmit: m.fidelity });
      this.host.emit({ type: 'memory', agentId, action: 'merged', memory: { ...m }, mergedFrom: group.map((g) => g.m.id) });
      return;
    }
  }

  private recallStep() {
    const agents = [...this.mems.entries()].filter(([, l]) => l.some((x) => x.m.fidelity < 0.85));
    if (!agents.length) return;
    const [agentId, list] = agents[Math.floor(this.host.r() * agents.length)];
    const cands = list.filter((x) => x.m.fidelity < 0.85);
    const x = cands[Math.floor(this.host.r() * cands.length)];
    x.m.recalls++;
    x.m.fidelity = Math.min(1, +(x.m.fidelity + 0.15 + this.host.r() * 0.1).toFixed(3));
    x.m.text = degrade(x.orig, x.m.id, x.m.fidelity);
    x.lastEmit = x.m.fidelity;
    this.host.emit({ type: 'memory', agentId, action: 'recalled', memory: { ...x.m } });
  }

  // ------------------------------------------------------------ insights

  private seedInsights(role: string) {
    const pool = INSIGHT_POOL[role];
    const used = new Set<number>();
    this.used.set(role, used);
    const peers = this.host.agents().filter((a) => a.role === role);
    const n = 2 + Math.floor(this.host.r() * 3);
    for (let i = 0; i < Math.min(n, pool.length - 1); i++) {
      used.add(i);
      this.stored.push({
        code: `${role}.i${this.insSeq++}`,
        role,
        text: pool[i],
        confidence: +(0.65 + this.host.r() * 0.3).toFixed(2),
        author: peers[0]?.name ?? 'Gli anziani',
        reviewer: peers[1]?.name,
        day: 1,
        status: 'accepted',
      });
    }
  }

  private schedule(afterSec: number, fn: () => void) {
    this.queue.push({ at: this.clock + afterSec, fn });
  }

  private propose() {
    const h = this.host;
    const agents = h.agents().filter((a) => INSIGHT_POOL[a.role]);
    if (!agents.length) return;
    const author = agents[Math.floor(h.r() * agents.length)];
    const pool = INSIGHT_POOL[author.role];
    const used = this.used.get(author.role) ?? new Set<number>();
    this.used.set(author.role, used);
    let free = pool.map((_, i) => i).filter((i) => !used.has(i));
    if (!free.length) {
      // texts that are no longer accepted may be proposed again
      used.clear();
      pool.forEach((t, i) => {
        if (this.stored.some((s) => s.role === author.role && s.text === t && s.status === 'accepted')) used.add(i);
      });
      free = pool.map((_, i) => i).filter((i) => !used.has(i));
    }
    if (free.length) {
      const idx = free[Math.floor(h.r() * free.length)];
      used.add(idx);
      const ins: Insight = {
        code: `${author.role}.i${this.insSeq++}`,
        role: author.role,
        text: pool[idx],
        confidence: +(0.4 + h.r() * 0.35).toFixed(2),
        author: author.name,
        day: h.now().day,
        evidence: `Osservato ${2 + Math.floor(h.r() * 4)} volte nei giorni scorsi`,
        status: 'proposed',
      };
      this.pending.push(ins);
      h.emit({ type: 'insight', insight: { ...ins }, action: 'proposed' });
      const peers = h.agents().filter((a) => a.role === author.role && a.id !== author.id);
      if (peers.length) {
        const reviewer = peers[Math.floor(h.r() * peers.length)];
        this.schedule(6 + h.r() * 6, () => this.review(ins, author.id, reviewer.name, h.r() < 0.8));
      } else {
        this.schedule(8 + h.r() * 6, () => this.review(ins, author.id, undefined, true));
      }
    }
    if (h.r() < 0.18) this.retireOne();
  }

  private review(ins: Insight, authorId: string, reviewer: string | undefined, accept: boolean) {
    const i = this.pending.indexOf(ins);
    if (i < 0) return;
    this.pending.splice(i, 1);
    ins.reviewer = reviewer;
    if (accept) {
      ins.status = 'accepted';
      ins.confidence = Math.min(0.95, +(ins.confidence + 0.1).toFixed(2));
      this.stored.push(ins);
      this.host.emit({ type: 'insight', insight: { ...ins }, action: 'accepted', reviewer });
      this.remember(authorId, `La mia intuizione sul mestiere è stata accettata${reviewer ? ` da ${reviewer}` : ''}.`, 'law', 0.55, 'orgoglio');
    } else {
      ins.status = 'rejected';
      this.host.emit({ type: 'insight', insight: { ...ins }, action: 'rejected', reviewer });
      this.remember(authorId, `${reviewer ?? 'Un collega'} ha respinto la mia intuizione.`, 'law', 0.5, 'delusione');
    }
  }

  private retireOne() {
    const byRole = new Map<string, Insight[]>();
    for (const s of this.stored) if (s.status === 'accepted') byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);
    const roles = [...byRole.entries()].filter(([, l]) => l.length >= 3);
    if (!roles.length) return;
    const [, list] = roles[Math.floor(this.host.r() * roles.length)];
    const old = list[0];
    old.status = 'retired';
    this.host.emit({ type: 'insight', insight: { ...old }, action: 'retired' });
  }

  insightList(role?: string): InsightList {
    const f = (l: Insight[]) => l.filter((i) => !role || i.role === role).map((i) => ({ ...i }));
    return { pending: f(this.pending), stored: f(this.stored) };
  }

  consciousness(): Record<string, Insight[]> {
    const out: Record<string, Insight[]> = {};
    for (const r of this.roles) out[r] = [];
    for (const s of this.stored) if (s.status === 'accepted') (out[s.role] ??= []).push({ ...s });
    return out;
  }

  // ------------------------------------------------------------ clock

  tick(dt: number) {
    this.clock += dt;
    if (this.clock >= this.decayAt) {
      this.decayAt = this.clock + 3;
      this.decayStep();
    }
    if (this.clock >= this.recallAt) {
      this.recallAt = this.clock + 3 + this.host.r() * 4;
      this.recallStep();
    }
    if (this.clock >= this.insightAt) {
      this.insightAt = this.clock + 15 + this.host.r() * 10;
      this.propose();
    }
    const due = this.queue.filter((q) => q.at <= this.clock);
    if (due.length) {
      this.queue = this.queue.filter((q) => q.at > this.clock);
      for (const q of due) q.fn();
    }
  }
}

const CONSULT: Record<string, string[]> = {
  lorebase_search: ['leggi inverno', 'ricette ceramica', 'come conservare le bacche', 'leggi sul freddo', 'tecnologie scoperte', 'regole sugli scambi'],
  lorebase_get_record: ['legge wood.per_chop', 'legge food.per_gather', 'ricetta ascia di pietra', 'ricetta impiastro'],
  lorebase_list_records: ['ricette scoperte', 'leggi della categoria clima', 'intuizioni accettate'],
};

/** A plausible Lorebase lookup for an agent that starts thinking. */
export function consultFor(role: string, r: () => number): { tool: string; query: string } {
  const tools = Object.keys(CONSULT);
  const tool = tools[Math.floor(r() * tools.length)];
  if (r() < 0.3) return { tool: 'lorebase_get_record', query: `coscienza del ruolo ${ROLE_IT[role] ?? role}` };
  const qs = CONSULT[tool];
  return { tool, query: qs[Math.floor(r() * qs.length)] };
}
