# Prompts

Two modes: the real-time world (`npm run game`, v2, below first) and the legacy tick dashboard
(`npm run dev`, v1, further down).

## Real-time world (v2)

The prompt is minimal: no laws, no tasks, no goals, no strategy, no advice on when to consult.

| Part | Source |
|------|--------|
| Instructions (system) | `config/i18n/<lang>.rt.json` → `instructions`: name, personality, role code and title (Lorebase `Role`), the faculties (a mind connected to Lorebase through the `lorebase_*` tools: laws, the role's shared consciousness, the chronicle; a private memory `remember`/`recall`) and the plan interface (`commit_plan`, step counts and horizon of the tier) |
| Observation (user message, at each decision) | `rt.observation.*`, `rt.look.*`: time and season, the person's body, what it carries (item names and codes, tools with wear) and position, group, current step, why it is thinking again (a fact: plan finished, step failed, spoken to, ...), what it perceives within `vision_radius`, what was said to it, what it lived (last `memoryItems`), and which law keys changed since it last thought |
| Tools | `commit_plan`, `say`, `form_group`, `join_group`, `leave_group`, `scambia`, `chiedi`, `rispondi_scambio`, `giudica`, `testimonia`, `proponi_legge`, `share_insight`, `review_insights`, `judge_insight` (`rt.tools.*`); Lorebase read tools from Herald (`lorebase_get`, `lorebase_query`, `lorebase_search`, `lorebase_history`, `lorebase_diff`, `lorebase_changes`, `lorebase_schema`, `lorebase_context`; descriptions `rt.mcp.*`); private memory `remember(text, importance?)`/`recall(query)` (mnemo: semantic recall, memories fade and blur; results say whether a memory is vivid or faded) |
| Spoken reply | same instructions + `rt.replyInstructions`; short observation without laws; optional `rethink` tool |
| Group members | `rt.memberInstructions` + the group situation (`rt.group.*`: members, perception of the leader, what was said, group memory); per role: plan writers get `commit_plan` and `rt.group.format`, prose proposers and workers get `rt.group.proposeFormat` (no `commit_plan`), both get the faculties line `rt.group.faculties` and the Lorebase/memory tools; judges, voters and routers get neither tools nor the faculties line (verdicts, ballots and routes are structured outputs); pattern texts `rt.group.tpl.*` replace reinloop's English harness templates |

Society in the observation (`rt.observation.age|offers|hearsay`, `rt.look.repute*`), facts only and never a
number of esteem or fame: the person's age and life stage; the exchange offers made to it and by it (codes
to answer with `rispondi_scambio`); after each person in view, a band phrase ("gode di molta stima", "gode
di poca stima", "tutti parlano di ciò che ha fatto") and what one heard of them ("di Bruno si dice: «…»");
a block "CIÒ CHE SI DICE IN GIRO" with the judgements one overheard. Why it thinks again may also be "X ti
propone uno scambio" or "la tua proposta di scambio a X è stata accettata". The tools say what they do
(`giudica`: the judgement stays in one's memory and those nearby hear it; `chiedi`: the person answers when
it thinks about it, a refused or ignored request expires; `testimonia`: what one saw of a community law kept
or broken, heard by those nearby; `proponi_legge`: it comes into force only if approved) and never when or
why to use them. A refused `proponi_legge` says only "la tua voce
non ha ancora abbastanza peso".

The plan interface lists the economy actions (`crea(recipe)`, `sperimenta(items)`, `usa(item)`,
`dai(to, item, amount)`, `scambia(to, give, want)`, `gather(resource)` by item code) as a tool description only; the
catalog itself is in Lorebase (`Recipe`, `Resource`, `Technology`), and undiscovered recipes are not readable at all.
Perception adds the structures on tiles (hearth, storehouse) and whether the person stands in the wilds.

Factual perception lines (`rt.body.*`, `rt.recipes.*`, `rt.look.gather|doing|wildFelt`), each capped by
`decisions.perception` in `config/game.json` so the prompt stays short:

- **Body** (`IL TUO CORPO negli ultimi N minuti`): change of health and hunger since the person last thought, with the
  physical causes the body felt (hunger, winter cold or the wilds away from a shelter, rest, remedies) and the food
  eaten. Causes below `bodyMinDelta` are left out; no line when nothing changed.
- **Wilds**: "Sei nelle terre selvagge." as before; only a person that has already lost health there also reads
  "Nelle terre selvagge, fuori da un rifugio, hai già perso salute." (its own experience, not the law).
- **People in view**: the `carriedMax` largest things each one carries (tools included) and the action of its
  current step ("raccoglie Selce", "fabbrica: Fare un'ascia", "va da Vera").
- **Gatherable in view** (`gatherSpotsMax`): for each gathered material, the nearest tile in view where it can be
  gathered.
- **Recipes you know** (`recipesMax`): the known recipes of the person's role or of anyone (never a hidden one),
  with inputs, outputs, tools and station, and what the person lacks right now ("ti manca: 2 Selce (flint)").

Where materials are found is world generation (`map.regions`): outside a core around the spawn the map is cut into
seeded angular sectors, each yielding only its listed materials on the biomes their `Resource` names. The core has
food and wood only, so every first recipe of every role needs something from a sector or from another role. The step count is a suggestion in
the `commit_plan` schema ("di solito non più di N"), not a minimum.

Rendered example (Ilse, opus, at the start of a mock world; v1 of the self line, now `porti: … ; attrezzi: …`):

```text
Sei Ilse. Il tuo carattere: Calma, lungimirante; parla poco ma con chiarezza.
Il tuo ruolo nella società: Anziano (elder).
La tua mente è collegata a Lorebase (strumenti lorebase_*): lì puoi consultare le leggi del mondo, la coscienza condivisa del tuo ruolo e la cronaca. Hai anche una memoria privata (remember/recall).
Il tempo scorre senza pause. Quando ti fermi a pensare fissi con commit_plan ciò che farai per circa 60 minuti; mentre pensi continui a fare ciò che stavi facendo.
Pensi e parli in italiano.
```

```text
GIORNO 1, ORE 06:00 (giorno). Stagione: primavera; l'inverno arriva tra 360 minuti.

TU: salute 10/10, fame 0, porti 0 cibo e 0 legna; sei in (21,12); non sei al riparo; cammini a 1.2 caselle al minuto e lavori a rapidità 0.9.

IL TUO GRUPPO: nessuno.

STAVI FACENDO: niente.

PERCHÉ CI RIPENSI: ti guardi intorno per la prima volta.

CIÒ CHE PERCEPISCI:
Sei in (21,12) su bosco, altitudine 1: cibo 1.53, legna 6.11.
Il mondo misura 40x30 caselle; x cresce verso est, y verso sud. Acqua e roccia non si attraversano.
Caselle con risorse entro 3: (21,11) bosco cibo 1.5 legna 6; (22,11) bosco cibo 1.84 legna 7.36; ...
Persone in vista: Tomas [Costruttore] in (20,12) salute 10 fame 0 cibo 0; Rudi [Costruttore] in (20,13) ...
Rifugio più vicino: nessun rifugio esiste.
Gruppi qui intorno: nessuno.

CIÒ CHE TI È STATO DETTO:
- niente

CIÒ CHE RICORDI:
- niente
```

In a live check the agents consulted Lorebase on their own, e.g. `lorebase_search "rifugio inverno legna costruire"`,
`lorebase_query {"kind":"Rule"}`, `lorebase_context "leggi del mondo, ruolo Esploratore, rifugio, inverno"`.

## Legacy tick dashboard (v1)

Everything a person reads comes from three places, and nothing else:

| Part | Source |
|------|--------|
| Instructions (system prompt) | `config/i18n/<language>.json` → `instructions`, filled with the roster entry (name, personality) and the person's `Role` Record from Lorebase (title, description) |
| Observation (user message, every tick) | `observation.*` and `look.*` templates, filled with the person's own perception, the inbox, and every `Rule` Record of the Lorebase branch verbatim (key, value, unit, text) |
| Tool descriptions | `tools.*` templates; results of actions use `act.*` |

There are no goals beyond staying alive, no strategy, no hints and no rule values in code or
templates: values and wording of the laws live only in Lorebase. When the laws change, the next
observation carries the new laws and a factual list of what changed; when a Role changes, the
instructions are rebuilt. Each person also has a private notebook (reinloop `remember` /
`recall`, one namespace per person) and its own reinloop session, so what it learns is its own.

Language is `language` in `config/sim.json` (default `it`); templates are in `config/i18n/`.
Code identifiers, rule keys and logs stay in English.

## Instructions template (`it`)

```text
Sei {name}. Vivi insieme ad altre persone in un mondo che ha delle leggi.
Il tuo carattere: {personality}
Il tuo ruolo nella società: {roleTitle}. {roleDescription}
Vuoi restare in vita.
Il tempo scorre a turni. A ogni turno conosci le leggi in vigore e ciò che percepisci, e puoi agire con i tuoi strumenti.
Pensi e parli in italiano. Chiudi ogni turno con un breve pensiero, in una o due frasi.
```

## Observation template (`it`)

```text
TURNO {tick}. Stagione: {season}; {winter}.

TU: salute {hp}/{maxHp}, fame {hunger}, porti {food} cibo e {wood} legna; azioni rimaste in questo turno: {actions}; {shelter}.

CIÒ CHE PERCEPISCI:
{look}

MESSAGGI RICEVUTI:
{messages}

LE LEGGI DEL MONDO (dal libro delle leggi, revisione {revision}):
{laws}

LEGGI CAMBIATE DAL TUO ULTIMO TURNO:
{changes}
```

`{look}` is the perception block (`look.*`), `{laws}` one `- {key} = {value} {unit}: {text}` line per Rule
Record, the last block only when laws changed since the person's previous turn.

## Tools (`it`)

| Tool | Description |
|------|-------------|
| `look` | Guardati intorno: caselle vicine con cibo, legna o rifugi, persone in vista. Gratis. |
| `move(dx, dy)` | Fai un passo su una casella adiacente. Costa un'azione. |
| `gather(resource)` | Raccogli cibo (food) o legna (wood) dalla casella in cui sei. Costa un'azione. |
| `eat(amount?)` | Mangia cibo che porti con te. Gratis. |
| `build_shelter` | Costruisci un rifugio sulla tua casella con la legna che porti. Costa un'azione. |
| `give(to, resource, amount)` | Dai cibo (food) o legna (wood) a qualcuno sulla tua casella o su una adiacente. Costa un'azione. |
| `say(to, text)` | Di' qualcosa a una persona (per nome) o a "all" (tutti). Arriva al turno successivo. Gratis. |
| `rest` | Riposa per recuperare salute. Costa un'azione. |
| `remember(text, tags?)` | Annota qualcosa nel tuo taccuino personale, per ricordarlo nei turni futuri. |
| `recall(query)` | Rileggi le annotazioni del tuo taccuino che corrispondono a una ricerca. |

## Rendered example (seed world, tick 1, laws as seeded)

Instructions:

```text
Sei Ilse. Vivi insieme ad altre persone in un mondo che ha delle leggi.
Il tuo carattere: Calma, lungimirante; parla poco ma con chiarezza.
Il tuo ruolo nella società: Anziano. Nella società sei chi ha visto molti inverni; quando parli, gli altri ascoltano.
Vuoi restare in vita.
Il tempo scorre a turni. A ogni turno conosci le leggi in vigore e ciò che percepisci, e puoi agire con i tuoi strumenti.
Pensi e parli in italiano. Chiudi ogni turno con un breve pensiero, in una o due frasi.
```

Observation:

```text
TURNO 1. Stagione: primavera; l'inverno arriva tra 11 turni.

TU: salute 10/10, fame 0, porti 0 cibo e 0 legna; azioni rimaste in questo turno: 2; non sei al riparo.

CIÒ CHE PERCEPISCI:
Sei in (11,9) su prato: cibo 5.69, legna 0.
Il mondo misura 20x14 caselle; x cresce verso est, y verso sud. Sull'acqua non si cammina.
Caselle con risorse entro 3: (10,8) prato cibo 5.35 legna 0; (10,9) prato cibo 4.83 legna 0; (10,10) prato cibo 3.75 legna 0; (11,10) prato cibo 6 legna 0; (12,10) prato cibo 5.13 legna 0; (9,7) prato cibo 5.23 legna 0; (10,7) prato cibo 4.94 legna 0; (9,8) prato cibo 4.25 legna 0; (9,9) prato cibo 4.32 legna 0; (13,9) roccia cibo 0 legna 1; (9,10) prato cibo 5.41 legna 0; (13,10) prato cibo 3.37 legna 0.
Persone in vista: Mara [Guaritore] in (12,9) salute 10 cibo 0.
Rifugio più vicino: nessun rifugio esiste.

MESSAGGI RICEVUTI:
- nessuno

LE LEGGI DEL MONDO (dal libro delle leggi, revisione d8328538):
- cold_damage_unsheltered = 1 salute/turno: D'inverno chi non sta su un rifugio perde questa salute a ogni turno.
- winter_every_ticks = 16 turni: Un anno dura questo numero di turni; l'ultima parte di ogni anno è inverno.
- winter_food_yield_multiplier = 0.5 x: D'inverno la raccolta e la ricrescita sono moltiplicate per questo fattore.
- winter_length_ticks = 4 turni: L'inverno dura questo numero di turni alla fine di ogni anno.
- gather_food_yield = 2 cibo: Raccogliere cibo prende fino a questa quantità di cibo dalla casella su cui ci si trova.
- gather_wood_yield = 2 legna: Raccogliere legna prende fino a questa quantità di legna dalla casella su cui ci si trova.
- regrowth_per_tick = 0.08 quota/turno: A ogni turno la terra ricresce di questa quota del cibo e della legna che può naturalmente portare.
- shelter_wood_cost = 6 legna: Costruire un rifugio sulla propria casella costa questa legna. Chiunque stia su una casella con un rifugio è al riparo.
- actions_per_tick = 2 azioni: A ogni turno una persona può compiere questo numero di azioni (muoversi, raccogliere, costruire, dare, riposare). Guardare, mangiare e parlare non costano azioni.
- birth_food_cost = 6 cibo: Due persone sazie sulla stessa casella con rifugio che insieme portano questo cibo mettono al mondo un figlio, consumando quel cibo (al massimo una volta all'anno ciascuna).
- sharing_allowed = 1 0/1: Se vale 1, si può dare cibo e legna a chi sta sulla stessa casella o su una adiacente. Se vale 0, dare è vietato.
- vision_radius = 3 caselle: Una persona vede caselle e persone entro questo numero di caselle.
- food_per_tick = 1 fame/turno: A ogni turno la fame di ogni persona cresce di questa quantità. Mangiare un cibo toglie uno di fame.
- max_hp = 10 salute: Ogni persona ha al massimo questa salute. Con la salute a zero si muore.
- rest_heal = 1 salute: Riposare restituisce questa salute, ma solo a chi non sta morendo di fame.
- starvation_damage = 2 salute/turno: Chi muore di fame perde questa salute a ogni turno.
- starvation_threshold = 4 fame: Quando la fame supera questo livello si comincia a morire di fame.
```

## Offline mock provider

`npm run sim:mock` (or no `ANTHROPIC_API_KEY`) replaces the model with a deterministic
heuristic (`server/src/agents/mock.ts`) so the demo runs offline; status reports
`provider: "mock"`. It does not read these prompts: it is a fallback, not an agent.
