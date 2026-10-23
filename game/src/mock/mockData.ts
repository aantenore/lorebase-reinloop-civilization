import type { Group, Rule, Tier } from '../net/protocol';

export interface AgentSeed {
  id: string;
  name: string;
  role: string;
  tier: Exclude<Tier, 'human'>;
  groupId: string;
  speed: number;
  persona: string;
}

export const MODELS: Record<string, string> = {
  opus: 'claude-opus',
  sonnet: 'claude-sonnet',
  haiku: 'claude-haiku',
  human: 'umano',
};

export const AGENTS: AgentSeed[] = [
  { id: 'a-aurelia', name: 'Aurelia', role: 'chief', tier: 'opus', groupId: 'g-clan', speed: 1.5, persona: 'decisa e protettiva' },
  { id: 'a-bruno', name: 'Bruno', role: 'woodcutter', tier: 'haiku', groupId: 'g-clan', speed: 1.7, persona: 'brusco ma leale' },
  { id: 'a-cora', name: 'Cora', role: 'builder', tier: 'sonnet', groupId: 'g-clan', speed: 1.4, persona: 'precisa e paziente' },
  { id: 'a-dario', name: 'Dario', role: 'elder', tier: 'opus', groupId: 'g-mentor', speed: 1.1, persona: 'saggio e ironico' },
  { id: 'a-elsa', name: 'Elsa', role: 'healer', tier: 'haiku', groupId: 'g-mentor', speed: 1.5, persona: 'curiosa e gentile' },
  { id: 'a-fosco', name: 'Fosco', role: 'scout', tier: 'sonnet', groupId: 'g-exp', speed: 2.0, persona: 'irrequieto e ottimista' },
  { id: 'a-gaia', name: 'Gaia', role: 'gatherer', tier: 'haiku', groupId: 'g-exp', speed: 1.6, persona: 'allegra e pratica' },
  { id: 'a-ivo', name: 'Ivo', role: 'hunter', tier: 'sonnet', groupId: 'g-exp', speed: 1.7, persona: 'silenzioso e attento' },
  { id: 'a-ugo', name: 'Ugo', role: 'woodcutter', tier: 'sonnet', groupId: 'g-clan', speed: 1.6, persona: 'costante e diffidente' },
  { id: 'a-tina', name: 'Tina', role: 'gatherer', tier: 'haiku', groupId: 'g-exp', speed: 1.6, persona: 'chiacchierona e generosa' },
];

export const CROWD_NAMES = ['Lino', 'Mira', 'Nello', 'Olga'];

export const GROUPS: Group[] = [
  {
    id: 'g-clan',
    name: 'Clan del Fiume',
    pattern: 'orchestrator',
    members: ['a-aurelia', 'a-bruno', 'a-cora', 'a-ugo'],
    leader: 'a-aurelia',
    color: '#e0503a',
    lastDecision: {
      summary: 'Aurelia divide il lavoro: Bruno taglia, Cora costruisce la terza capanna.',
      trace: [
        { member: 'a-aurelia', role: 'leader', text: 'Serve una capanna prima del freddo. Bruno al bosco, Cora al cantiere.' },
        { member: 'a-bruno', role: 'proposer', text: 'Posso portare dieci legna entro sera.' },
        { member: 'a-cora', role: 'proposer', text: 'Inizio le fondamenta vicino al sentiero sud.' },
      ],
    },
  },
  {
    id: 'g-mentor',
    name: 'Bottega delle Erbe',
    pattern: 'mentor',
    members: ['a-dario', 'a-elsa'],
    leader: 'a-dario',
    color: '#8a5ad0',
    lastDecision: {
      summary: 'Elsa propone di cercare bacche lontano; Dario la corregge: prima le scorte vicine.',
      trace: [
        { member: 'a-elsa', role: 'proposer', text: 'Vado oltre il fiume, lì ci sono più bacche.' },
        { member: 'a-dario', role: 'critic', text: 'Troppo lontano con l’inverno vicino. Raccogli vicino al villaggio.' },
        { member: 'a-elsa', role: 'proposer', text: 'Va bene: cespugli a est, poi torno al fuoco.' },
      ],
    },
  },
  {
    id: 'g-exp',
    name: 'Spedizione del Nord',
    pattern: 'chain',
    members: ['a-fosco', 'a-gaia', 'a-ivo', 'a-tina'],
    leader: 'a-fosco',
    color: '#3a9ad0',
    lastDecision: {
      summary: 'Fosco esplora, Ivo pianifica il percorso, Gaia raccoglie.',
      trace: [
        { member: 'a-fosco', role: 'proposer', text: 'A nord del lago ci sono cespugli carichi.' },
        { member: 'a-ivo', role: 'router', text: 'Passiamo dal ponte, è il sentiero più sicuro.' },
        { member: 'a-gaia', role: 'leader', text: 'Raccolgo io, voi coprite i fianchi.' },
      ],
    },
  },
  {
    id: 'g-crowd',
    name: 'Gente del Mercato',
    pattern: 'crowd',
    members: ['c-0', 'c-1', 'c-2', 'c-3'],
    leader: null,
    color: '#d0a83a',
    lastDecision: { summary: 'Una sola mente muove il mercato: girare tra le capanne e chiacchierare.', trace: [] },
  },
];

export const ASSEMBLY_DECISION: Group['lastDecision'] = {
  summary: 'Con la neve la spedizione si fa assemblea: 2 voti a 1 per restare al villaggio.',
  trace: [
    { member: 'a-fosco', role: 'proposer', text: 'Continuiamo verso nord, la neve è poca.' },
    { member: 'a-gaia', role: 'proposer', text: 'Torniamo e accumuliamo cibo per tutti.' },
    { member: 'a-ivo', role: 'voter', text: 'Voto per tornare.' },
    { member: 'a-gaia', role: 'voter', text: 'Voto per tornare.' },
    { member: 'a-fosco', role: 'voter', text: 'Voto per proseguire.' },
  ],
};

export const RULES: Rule[] = [
  { key: 'wood.per_chop', value: 3, text: 'Legna ottenuta per ogni albero abbattuto', category: 'risorse', unit: 'legna' },
  { key: 'food.per_gather', value: 2, text: 'Cibo raccolto da un cespuglio', category: 'risorse', unit: 'cibo' },
  { key: 'hunger.per_hour', value: 4, text: 'Quanto cresce la fame ogni ora', category: 'corpo', unit: 'punti/ora' },
  { key: 'cold.damage_per_hour', value: 2, text: 'Vita persa all’aperto d’inverno', category: 'clima', unit: 'vita/ora' },
  { key: 'season.length_days', value: 2, text: 'Durata di una stagione', category: 'clima', unit: 'giorni' },
  { key: 'shelter.wood_cost', value: 10, text: 'Legna per costruire un riparo', category: 'costruzione', unit: 'legna' },
  { key: 'speech.radius', value: 4, text: 'Distanza a cui si sente una voce', category: 'società', unit: 'caselle' },
  { key: 'group.max_size', value: 5, text: 'Membri massimi di un gruppo', category: 'società', unit: 'membri' },
];

/** Ambient lines: [opener, reply]. */
export const CHATTER: [string, string][] = [
  ['Hai visto quanta legna ci serve per l’inverno?', 'Più di quanta ne abbiamo. Domani torno al bosco.'],
  ['Il fiume è più basso oggi.', 'Meglio, si attraversa senza bagnarsi.'],
  ['Le bacche a est sono mature.', 'Allora ci passo prima del tramonto.'],
  ['Senti che freddo arriva da nord?', 'Sì. Le leggi dicono che l’inverno sarà lungo.'],
  ['Chi accende il fuoco stasera?', 'Ci penso io, tu porta la legna.'],
  ['La nuova capanna sta venendo bene.', 'Mancano ancora le travi del tetto.'],
  ['Hai fame?', 'Sempre. Ma prima finisco questo.'],
  ['Aurelia vuole tutti al fuoco a sera.', 'Ci sarò, voglio sentire cosa decide.'],
];

export const THOUGHTS = [
  'Se l’inverno arriva presto, la legna non basterà.',
  'Forse dovrei chiedere aiuto al clan.',
  'Quel cespuglio è quasi vuoto.',
  'Le nuove leggi cambiano tutto.',
  'Il viandante sembra gentile.',
  'Devo ricordarmi di mangiare.',
];

export const REPLIES: Record<string, string[]> = {
  chief: ['Benvenuto nel nostro villaggio. Qui ognuno fa la sua parte: se porti legna al mucchio, avrai un posto vicino al fuoco.', 'Il clan decide insieme, ma la responsabilità è mia. Cosa ti serve?'],
  woodcutter: ['Legna, legna e ancora legna. Con l’inverno che arriva non ne avremo mai abbastanza. Prendi un’ascia e vieni con me.', 'Il bosco a ovest è il migliore. Gli alberi grossi danno tre ceppi.'],
  builder: ['Sto alzando una nuova capanna. Mi servono dieci legna: se me le porti, la finisco prima della neve.', 'Una buona capanna tiene lontano il freddo. Le leggi dicono che chi dorme all’aperto d’inverno si ammala.'],
  elder: ['Ho visto molte stagioni, giovane. Le leggi di questo mondo cambiano, ma chi ascolta sopravvive.', 'Elsa impara in fretta. Io le dico solo dove sbaglia, il resto lo trova da sola.'],
  healer: ['Se sei ferito, riposa vicino al fuoco e mangia qualcosa. Il maestro Dario dice che il cibo è la prima medicina.', 'Sto raccogliendo erbe e bacche. Vuoi aiutarmi?'],
  scout: ['Ho visto cespugli carichi a nord del lago! Ma con la neve sarà dura arrivarci.', 'Conosco ogni sentiero di questa valle. Chiedimi pure la strada.'],
  gatherer: ['Le bacche sono il nostro tesoro. Ne porto sempre qualcuna in più per chi ha fame.', 'Raccogli con calma: un cespuglio svuotato ci mette giorni a ricrescere.'],
  hunter: ['…Parli troppo forte. Gli animali scappano.', 'La spedizione segue Fosco, ma i passi li conto io.'],
};
export const DEFAULT_REPLY = ['Ciao, viandante. Che cosa ti porta qui?'];
