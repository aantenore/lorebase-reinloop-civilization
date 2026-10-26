# Run report — 2026-10-23

Live run with real models, fresh world (`npm run world:reset`, empty mnemo), Lorebase `da53556`,
reinloop `0b8b688`. Default roster of 8 agents (Ilse opus; Mara, Vera sonnet; Tomas, Okon, Pell, Rudi,
Nia haiku), 4 crowd extras (haiku, one group mind), seeded groups: Consiglio degli Anziani (council:
Ilse, Mara) and Assemblea dei Raccoglitori (assembly: Okon, Pell). Laws: seed values, unchanged.
Stops: `budget.maxUsd` 3.00 (`GAME_BUDGET_USD=3`) or 25 real minutes.

## Italiano

**Esito.** Il tetto di spesa ha fermato tutte le menti dopo 12 minuti reali (giorno 1, 17:46 di gioco),
prima del limite di 25 minuti. Nessuna morte, tre nascite e tre casate fondate.

**Scala del tempo.** Il piano era `GAME_TIME_SCALE=3` (circa 3 giorni di gioco in 25 minuti). Con le leggi
di partenza, a 3x tutti e 12 sono morti di fame entro le 09:45 del primo giorno: tra una decisione e
l'altra passava un'ora di gioco, e il cibo vicino alla partenza scarseggia. La run vera è a 1x e ha
coperto circa mezza giornata. Le due prove interrotte (una con il roster sbagliato, 3 sonnet e 4 haiku,
e quella a 3x) sono costate circa 0,60 $ in più, fuori dal tetto della run.

| Misura | Valore |
|---|---|
| Decisioni (individuali + di gruppo) | 166 + 106 |
| Risposte in conversazione | 170 |
| Fallimenti | 3 (2 assemblee senza passi validi, 1 decisione oltre `maxTurns`) |
| Oggetti fabbricati | 8 (Vera: corda, ascia, coltello; abilità corda 3, ascia 3) |
| Scoperte | 0 |
| Nascite / morti | 3 (Ari, Cato, Ivo) / 0 |
| Doni / scambi / richieste (`chiedi`) | 44 / 0 / 1 (rifiutata) |
| Rifugi costruiti o ampliati | 11 |
| Leggi proposte / idee accettate / testimonianze | 0 / 0 / 0 |
| Giudizi (`giudica`) | 0, quindi stima ferma a 0,5 per i fondatori e 0,15 per i nati |
| Primi 3 (a parità di stima decide la fama) | Abe (haiku, fama 17,5), Cira (haiku, 14,6), Okon (haiku, 9,7) |
| Costo | 3,11 $: opus 1,49, sonnet 1,21, haiku 0,40 |
| Costo per livello | gruppo consiglio 1,78, sonnet 0,83, haiku 0,22, gruppo assemblea 0,12, opus 0,10, folla 0,06 |

La fama dei primi tre viene tutta dai doni: le comparse si passavano cibo e legna. Il consiglio opus+sonnet
è costato il 57% del totale. Dopo la pausa i giri già avviati sono arrivati alla fine, quindi il totale
ha superato il tetto di 0,11 $.

## English

**Outcome.** The budget cap paused every mind after 12 real minutes (day 1, 17:46 game time), before
the 25-minute limit. No deaths, three births, three dynasties founded.

**Time scale.** The plan was `GAME_TIME_SCALE=3` (about 3 game days in 25 minutes). With the seed laws,
at 3x all 12 people starved by 09:45 on day 1: about one game hour passed between one decision and the
next, and food is scarce near the spawn. The reported run is at 1x and covered about half a game day.
The two interrupted attempts (one with the wrong roster, 3 sonnet and 4 haiku, and the 3x one) cost
about $0.60 more, outside the run's cap.

Numbers are in the table above. Cost by model: opus $1.49, sonnet $1.21, haiku $0.40 (total $3.11).
Since the change in this release, group runs are booked under each member's own model. The
opus+sonnet council took 57% of the spend. Runs already in flight finished after the pause, so the
total went $0.11 past the cap. Nobody used `giudica`, `testimonia`, `proponi_legge` or
`share_insight`, so esteem never moved. The top 3 all come from gifts among the crowd extras.

## Notable moments

1. **The first ask.** Vera, a crafter with no fibre, broadcast: «Cerco Selce (1 in più) e Fibre
   vegetali (almeno 2)… Offro Legna in cambio». She then used `chiedi` on Nia for 1 fibre. Nia had none
   and turned it down, but kept exploring for her: «Vera, ci provo ancora: vado a sud-ovest sulla
   sabbia a cercare una fibra per te.»
2. **Hoarding against sharing.** Okon (haiku) thought: «conviene accumulare scorte invece di regalare il
   cibo, visto che Cira ne ha già 29». Tomas (haiku) told everyone: «Chi ha un bisogno reale mi dica
   quanto, senza accumulare scorte inutili.»
3. **A council granary.** With no prompting, the Council made "la scorta comune" at the shelter
   (20,8) a standing policy. The elder's own rule for it: «si dona solo dopo essersi avvicinati e
   tenendo un margine».
4. **A newborn joins the council.** Cato (born to Ilse and Mara) was fed by the council («Cato, che non
   ha niente, riceve cibo da Mara e Ilse») and within the hour was writing council proposals himself.
5. **Builders coordinating.** Tomas turned down more wood: «il rifugio è già al livello massimo e ho legna
   più che sufficiente… torna qui solo se ti chiedo qualcosa». The builders went on to put up
   11 shelters or extensions.

## Observations for the next run

- At 3x the seed economy cannot keep up with model latency. A faster world needs shorter decision gaps,
  or richer laws (for example the `abundance` scenario).
- Council proposers often write «non ho lo strumento commit_plan» in their proposals. Their prose is still
  aggregated by the elder, but the wording shows a mismatch between the template and the tools.
- Without judgements, esteem stays flat. Ranks then follow fame from gifts.

Screenshots from this run: `docs/screenshots/` (game-world, society, economy, god-mode,
consciousness; 800×500, the browser pane's size).

## Run 2 (haiku, 3 days) — 2026-10-24

Fresh world (`npm run world:reset`, empty mnemo), code at `d1162d8`. `SIM_MODEL_OVERRIDE=haiku` (every
agent and every group role on haiku), default roster of 8 agents, no crowd extras (`GAME_CROWD=0`), seeded
groups Consiglio degli Anziani (council: Ilse, Mara) and Assemblea dei Raccoglitori (assembly: Okon, Pell).
Seed laws, unchanged. `GAME_TIME_SCALE=4`, `GAME_BUDGET_USD=2`. Stopped by hand after 13 real minutes at
day 3, 10:25 (about 2.2 game days elapsed from 06:00 of day 1), on a time-box; the budget was never near.

| Measure | Run 1 (mixed, 1x, 0.5 day) | Run 2 (haiku, 4x, 2.2 days) |
|---|---|---|
| Decisions (individual + group) | 166 + 106 | 302 + 37 |
| Spoken replies | 170 | 89 |
| Failures | 3 | 2 (1 decision over `maxTurns`, 1 decision timeout); 0 group failures |
| Crafted items / discoveries | 8 / 0 | 0 / 0 |
| Births / deaths | 3 / 0 | 0 / 2 (Okon, Pell: "freddo", the wild damage) |
| Gifts / barters / asks | 44 / 0 / 1 | 21 / 0 / 0 (offers 0) |
| Shelters built or extended | 11 | 23 |
| Judgements / testimonies / insights / law proposals | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Esteem spread | 0 (all 0.5) | 0 (all 0.5) |
| Top 3 (fame) | Abe, Cira, Okon | Vera 22.6, Nia 12.0, Ilse 2.8 |
| Bodies acting by reflex (plans) | n/a | 602 |
| Cost | $3.11 (opus 1.49, sonnet 1.21, haiku 0.40) | **$0.53**, all haiku (individual 0.38, council 0.10, assembly 0.05) |
| Cost per game day | about $6.2 | about $0.24 |

Group decisions dropped from 106 per half day to 37 in 2.2 days (cooldown in game time, proposers on the
cheap tier, no vote when only one valid proposal) and were 28% of the spend instead of 57%. Each group
decision cost $0.002-0.007 (logged per decision). No group failed: no "no valid step" (the repair dropped
two invalid `dai` steps from assembly proposals and kept the rest), no proposer writing that it lacks
`commit_plan`.

### Notable moments

1. **The elder feeds first.** The council's plans settled on one rule of its own: «Prima si mangia,
   ognuno su una casella di cibo diversa» — eat first, each on a different food tile so none is exhausted.
2. **Checking the law instead of guessing.** The council consulted Lorebase before deciding: «Ho verificato
   le regole: max_shelter_level è 2 e shelter_wood_cost è 6 per livello, quindi nessun livello…».
3. **Carrying food to the elder.** Nia, an explorer, crossed the map back to the shelter: «Nia qui: ho
   portato cibo a Ilse. Chi altro ha fame, si faccia avanti».
4. **Holding wood for a common plan.** Vera: «Tengo le mie 2 legna da parte finché non mi dici dove
   costruirlo, così non ne sprechiamo nemmeno una» — the builders then ran a second shelter site together.
5. **The assembly that walked into the wild.** Okon and Pell kept choosing the richest grass at (19,1)-(21,2),
   far north, and noticed «Di notte la salute è bassa per tutti» without tying it to the place. Both died of
   the wild damage (`wild_distance` 9); the assembly dissolved.

### Analysis: why the society features did or did not emerge

- **Survival works, at 4x.** Bodies never wait for a mind: 602 reflex plans covered the gaps while minds
  thought or groups waited. Nobody starved. The two deaths came from a law the agents did not understand.
- **Esteem, testimonies, laws, insights: still zero.** The tools are listed (`giudica`, `testimonia`,
  `proponi_legge`, `share_insight`) with neutral descriptions, but nothing in a haiku agent's perception
  makes them relevant: no conflict, no theft, no broken promise is ever perceived as such. Hearsay and
  esteem start flat, and a judgement has no visible consequence before it is made. The agents spend their
  turns on what the perception is about: hunger, food tiles, wood, shelters.
- **Barter did not happen** because everyone carries the same two goods (food, wood). Without crafts there
  is nothing to trade; the one ask was a fibre request that nobody could serve. Crafting needs flint and
  fibre, which are far from the centre, in the wild, where the assembly died: the economy and the wild
  law pull in opposite directions and haiku plans do not weigh the risk.
- **Perception gap.** An agent sees its health drop but not why (exposure in the wild, at night). Making
  the cause perceivable (a factual line such as "fuori dal villaggio, all'aperto" in the self line) would
  let the laws be learned from experience; adding hints would break the no-advice rule, so that is left
  as a perception change for a later release.
- **Haiku is enough for logistics.** Council and assembly plans were coherent, reused coordinates, shared
  food and checked the laws. The social layer needs a reason in the perception, not a bigger model.

Screenshots: `game-world.png` replaced with this run (day 3, a village of 8 shelters and the council's
decision); the society, economy, consciousness and god-mode captures from run 1 still show more and are kept.

## Run 4 (economy profile + prompt caching) — 2026-10-26

Fresh world (`npm run world:reset`, empty mnemo), reinloop `96601b2` (Anthropic prompt caching on, `promptCache.ttl`
`5m`). `GAME_PROFILE=economy` (Ilse on sonnet, the other 7 agents on haiku, no crowd, council and assembly seeded,
group members on haiku, horizons x4 and cooldowns x6 in game time, a group decides at most every 240 game minutes,
replies capped at 500 tokens), `GAME_BUDGET_USD=10`, `GAME_TIME_SCALE=6`. Seed laws, unchanged. Stopped by the
35-real-minute limit at day 10, 00:08: 8.8 game days from 06:00 of day 1. The budget was never near. Progress
lines: `docs/run-progress.log`; raw evidence: `docs/evidence/run4/`.

| Measure | Run 1 (mixed, 1x) | Run 2 (haiku, 4x) | Run 4 (economy, 6x) |
|---|---|---|---|
| Game days covered | 0.5 | 2.2 | **8.8** |
| Decisions (individual + group) | 166 + 106 | 302 + 37 | 1002 + 16 |
| Spoken replies | 170 | 89 | 187 |
| Failures | 3 | 2 | 2 (1 decision over `maxTurns`, 1 decision timeout); 0 group failures |
| Crafted items / discoveries | 8 / 0 | 0 / 0 | 21 / 0 |
| Births / deaths | 3 / 0 | 0 / 2 | 16 / 10 (cold 6, hunger 4); 14 alive at the end |
| Gifts / barters | 44 / 0 | 21 / 0 | 69 / 2 accepted (76 offers and asks: 4 rejected, 70 expired) |
| Judgements / testimonies / insights / law proposals | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Lorebase consultations (MCP calls) | n/a | n/a | 8 |
| Cost | $3.11 | $0.53 | **$3.31** (sonnet 2.03, haiku 1.25) |
| Cost per game day | about $6.2 | about $0.24 | **about $0.38** |
| Prompt cache | none | none | 79% of input tokens read from cache (16.3M read, 4.3M written); saved $3.0 |

Cost by tier (snapshot 45 s before the stop, $3.28): Ilse's own decisions and replies (sonnet) $1.69, the seven haiku
agents and the newborns $1.21, council $0.35, assembly $0.02. One sonnet mind cost more than all the haiku minds together.

**Prompt caching.** Hit ratio 79% overall: haiku 80%, sonnet 72%, council and assembly 69%. Without the cache the same
calls would have cost about $6.3, so it halved the bill. Caching works because each call puts its stable part first
(tool catalog, then the person's instructions) and the perception last, as the message. reinloop also writes the latest
message to the cache, so every new perception is written once at 1.25x. That is most of the 4.3M written tokens, and
it pays off only when a decision takes more than one turn (consultation, retry). **TTL:** a person's cache entry is
read again at its next call. At 6x that came every 15-40 real seconds, and a group decided at most every 240 game
minutes (40 real seconds), so everything stayed far inside 5 minutes. `1h` writes cost 2x instead of 1.25x and would
have bought no extra hits: about $1 more on this run. `5m` stays the default. `1h` only pays when the same person's
calls are more than 5 real minutes apart, e.g. at 1x with cooldowns over 300 game minutes.

### Notable moments (transcripts in `docs/evidence/run4/conversations.md`)

1. **Flint for rope, settled by counting.** Tomas borrowed Vera's axe against 2 flint for 2 ropes. Then Rudi's ropes,
   a gift from Vera, got mixed up with the payment. Vera: «io ti ho consegnato due corde per le tue selci, e tu dici
   di averne tre in tasca?» Tomas: «Contiamole una per una adesso, davanti a Rudi e Nia». They settled it by talking
   and counting in front of witnesses, without `giudica` or `testimonia`.
2. **A price is refused.** Vera offered 8 wood for 2 flint. Tomas: «8 legna per 2 selci non mi servono: ne ho già 10 e
   non le voglio sprecare. Se mi dai corde o erbe, quelle sì». Then he turned down her rope offer: he needed the flint himself.
3. **The elder as critic.** Ilse (sonnet) rejected five of the council's six joint plans with specific fixes: «Il
   piano ripete l'errore appena fallito… Cambia l'ordine». On day 2 she noted «nelle terre selvagge perde salute».
   The council stayed north anyway, and Mara died of cold about 15 game minutes later.
4. **The assembly walks north again.** Okon and Pell voted for the rich grass at (20-23,3), «6 a casella», and died
   of cold on day 2, exactly as in run 2.
5. **A generation that knows the wild.** The newborns' thoughts name the cost: «sono nelle terre selvagge, che mi
   costano salute». Their plans still return to the shelter at (17,2), which is itself past `wild_distance`.

### Analysis

- **Cheap and long, as intended.** 8.8 game days for $3.31: 17 times more game time than run 1 for about the same money.
  It cost more per day than run 2 (all haiku) because of one sonnet mind, and the cache took half of the input cost off.
- **The groups died early, then the society thinned out.** Both seeded groups went to the rich grass in the north and
  lost members to the cold on day 2. From then on there were no group decisions (16 in total), and nobody used
  `form_group`. The birth law then made Ilse, who was always at the shelter, a parent of 11 of the 16 newborns. One
  dynasty, the Casata di Ilse, holds almost everyone.
- **Perceiving a cost is not avoiding it.** The wild is now in the perception and in the agents' words, yet the
  survivors settled at (17,2) next to the food. Six of the ten deaths were from cold. The food-versus-wild trade-off is
  real in the seed laws: food is richer in the north. Haiku plans keep choosing food. The no-advice rule leaves this to
  the agents, and so far they resolve it badly.
- **Social layer: still zero.** No judgement, testimony, insight or law proposal in 1,018 decisions, even with a real
  dispute (moment 1). The agents settle conflicts in speech. The tools stay unused because nothing in their perception
  ties a dispute to `giudica` or `testimonia`, and adding that would be advice. Lorebase was consulted 8 times in
  the whole run: with one consultation allowed per haiku decision, the agents nearly never use it.
- **Economy: crafts but no discoveries.** 21 crafts and 2 barters, all in the builders/crafter triangle (flint, rope,
  axe, hearth, storehouse). Nobody combined materials with `sperimenta`, so the technology tree stayed hidden.
- **Language.** Speech stayed Italian. Some reasoning summaries came back in English, and they are visible in god mode.

Screenshots: `society.png` replaced with this run (day 6: 12 people, one sonnet mind, the Casata di Ilse). game-world,
economy, consciousness and god-mode from runs 1-2 still show more (village, crafted economy, insights) and are kept.
