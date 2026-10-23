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
