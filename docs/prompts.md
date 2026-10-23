# Prompts

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
