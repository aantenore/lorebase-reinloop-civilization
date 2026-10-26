# Run 4: selected exchanges

Taken from the live feed of run 4 (WebSocket `say` and `deliberation` messages, as a spectator) and from
`GET /api/conversations` (mnemo). Speech is verbatim. Times are game time (day, clock). For the live feed they
are worked out from the real arrival time at 6 game minutes per real second, so they can be a few game minutes off.
Deliberation lines are cut at `groups.traceMaxChars` (280) by the game. mnemo forgets a person's lines when they
die, so `/api/conversations` at the end only holds the living (from day 7); the feed covers the whole run.
Lines marked *(thought)* are the model's reasoning summary (privileged view), not speech.

## 1. Flint for rope, a borrowed axe and a miscount (Tomas, Vera, Rudi; day 2-3)

The trade starts as a loan and an offer: Tomas has flint, Vera has rope and the only axe.

- d2 10:42, **Tomas → Vera**: «Vera, ho 4 legna e 3 selci. Mi presti l'ascia per il focolare? Ti passo le selci dello scambio appena siamo al rifugio.»
- d2 11:29, **Vera → Tomas**: «Tomas, l'ascia è ancora buona, la usura è 11 su 12, e te la passo volentieri per il focolare. Però mi servono le selci dello scambio prima di consegnarla, così ho le corde pronte per il cesto e tu hai la tua parte.»
- d2 13:28, **Tomas → Vera**: «Va bene Vera, accetto lo scambio o13: 2 corde per 2 selci. Te le do appena sono al rifugio, e l'ascia te la riporto subito dopo il focolare.»
- d2 15:00, **Tomas → Vera**: «Focolare fatto, ti riporto l'ascia adesso.»
- d2 18:12, **Tomas → Vera**: «Tomas qui: ti ho dato le 2 selci. Mi passi le 2 corde dello scambio, per favore?»

Rudi had received two ropes from Vera as a gift for the storehouse. Tomas thinks they are his payment:

- d2 19:33, **Rudi → Tomas**: «Rudi qui: le 2 corde che ho sono quelle che Vera mi ha dato per il magazzino, non le ho ricevute in cambio delle tue selci e non vedo selci nel mio zaino. Se mi rimandi le selci te le rido; altrimenti ne parliamo con Vera.»
- d2 19:54, **Tomas → Rudi**: «Rudi, le due selci le ho date a Vera, non a te, e le corde dello scambio le aspetto da lei. Mi sfamo qui a un passo, poi vado al rifugio a ritirarle, e se serve chiariamo tutti e tre davanti al magazzino.»
- d2 20:02, **Vera → Tomas**: «Vera qui: ti ho consegnato le 2 corde promesse per le tue selci. Grazie per il focolare!»
- d2 20:21, **Tomas → Vera**: «Vera, le corde ci sono: ne ho tre in tasca, quindi lo scambio è chiuso. Ora mi sfamo nel bosco qui vicino, poi ti passo l'ascia per il focolare e a Rudi dico che le selci le hai avute tu.»
- d2 20:36, **Vera → Tomas**: «Tomas, fammi capire bene: io ti ho consegnato due corde per le tue selci, e tu dici di averne tre in tasca? Prima di considerare chiuso lo scambio voglio contarle insieme, perché Rudi ha ancora in mano due corde che non ho ricevuto in cambi…»
- d2 21:12, **Vera → Rudi**: «Rudi, le 2 corde che ti ho dato erano un dono per il magazzino, non il pagamento delle selci di Tomas. Se ti servono ancora le corde, dimmelo.»
- d2 21:53, **Rudi → Tomas**: «Ehi Tomas, tranquillo, le mie corde sono un dono di Vera per il magazzino, non c'entrano con le tue selci! Chiaritela con lei, io intanto vado a costruire, che al rifugio (12,16) il magazzino non si fa da solo!»
- d2 22:08, **Vera → Tomas**: «Vera qui: ho 3 corde in tasca, non 1. Contiamole insieme prima di considerare chiuso lo scambio: io ti ho dato 2 corde, tu cosa mi hai dato in cambio?»
- d2 23:26, **Tomas → Vera**: «Accetto lo scambio: 2 Selce per le tue 2 Corde. Contiamole una per una adesso, davanti a Rudi e Nia, così non resta niente di sospeso.»
- d3 00:21, **Vera → Tomas**: «Tomas, contiamo ora, a voce alta: quante corde e quante selci hai in tasca? Le tue 2 selci dello scambio le metti sul tavolo, e io ti do le 2 corde appena le contiamo insieme.»
- d3 03:44, **Tomas → Rudi**: «Va bene, Rudi: 1 selce per 4 legna è uno scambio giusto e non mi costa nulla. Ti raggiungo al rifugio (12,16) appena finisco di mangiare e te la do.»
- d3 11:05, **Tomas → Vera**: «Vera, 8 legna per 2 selci non mi servono: ne ho già 10 e non le voglio sprecare. Se mi dai corde o erbe, quelle sì che mi tornano utili, e le contiamo subito insieme.»
- d3 14:52, **Tomas → Vera**: «Vera, la tua proposta o22 (2 selci per 2 corde) non la accetto: mi servono le selci per ascia e focolare. Se vuoi corde, trova fibre e te ne cerco io legna o cibo.»

Nobody used `giudica` or `testimonia`. The three settled it by talking and counting in front of witnesses.
The game recorded 2 accepted barters and 69 gifts in the whole run.

## 2. The council: the elder critiques the joint plan (Ilse on sonnet, Mara on haiku; day 1-2)

- d1 16:31, **Ilse (critic)**: «✓ Il piano va bene: ci sfama subito nelle caselle da 2 cibo, ognuno su una casella diversa (Ilse a (22,7), (23,7), (22,6); Mara a (21,7), (21,6), (20,6)), poi prevede una piccola scorta ed erbe. Questa volta le caselle sono ricche, quindi i fallimenti precedenti non dovrebbero ri…»
- d1 20:31, **Ilse (critic)**: «✗ Il piano ripete l'errore appena fallito: Ilse raccoglie cibo a (22,8), dove ce n'è solo 1.6 e le ultime raccolte non sono riuscite, e poi mangia senza aver portato cibo. Cambia l'ordine: Ilse si sposta PRIMA su (21,9) (cibo 1.92), raccoglie, e solo dopo mangia…»
- d2 00:32, **Ilse (critic)**: «✗ Il piano è quasi buono, ma va corretto. 1) Ilse ha cibo 1 e Mara 0: Mara ha fame 0.5 e salute bassa (4.8), quindi deve mangiare per prima…»
- d2 10:40, **Ilse (critic)**: «✗ Il piano è quasi buono, ma va corretto. 1) Mara è in (18,3) e ha salute 4.5: deve prima mangiare e poi usare le erbe che porta (3). Nel piano non le usa mai…»
- d2 15:01, **Ilse (critic)**: «✗ Il piano non va bene così. Mara ha salute 1.3 e fame 1.2, e nelle terre selvagge perde salute: serve prima stabilizzarla…»
- d2 16:29, **Mara (proposer)**: «Ho controllato il costo del riparo, ma Lorebase non mi ha dato il dettaglio della legna richiesta. Per questo la costruzione resta condizionale…»

Mara died of cold at (16,3) around d2 15:15. That council decision was still running: her last proposal
arrived after her death. With one member left the council dissolved, and the group decisions stopped at 16.

## 3. The assembly votes for the north (Okon, Pell; day 1-2)

- d1 22:31, **Okon (proposer)**: «Proposta di Okon: andiamo subito sul prato a (21,3) dove il cibo è 6 a casella (il bosco di (21,4) e (22,4) è quasi esaurito), mangiamo, dividiamo il raccolto a metà, poi ci teniamo vicini nel bosco di (21,5) per la notte.»
- d1 22:44, **Pell (voter)**: «#2: La mia proposta sfrutta il prato a nord (20-23,3), dove il cibo è abbondante…»
- d2 02:02, **Pell (proposer)**: «Pell ha salute 2/10: prima raccoglie le erbe medicinali in (21,5) e le usa, poi passa a Okon (fame 0.4, cibo 0) il suo cibo, e restiamo vicini a riposare nel bosco per la notte.»

Both died of cold at (19,2)-(19,3) on day 2, as in run 2.

## 4. Knowing the wild, staying in it (the newborns; day 7-8, from `/api/conversations`)

The shelter the survivors kept is at (17,2), past `wild_distance` from the centre. Their thoughts name the
cost; their plans still go back to it.

- d7 10h, **Ari** *(thought)*: «Sono bambino, fuori dal rifugio perdo salute: raccolgo cibo qui vicino, mangio e torno a riposare al riparo nel rifugio (17,2).»
- d7 14h, **Ilse** *(thought)*: «Sono fuori dal rifugio e perdo salute: rientro al riparo e uso la legna per ampliarlo in vista dell'inverno.»
- d7 19h, **Kit** *(thought)*: «Ho fame (1.5) e sono nelle terre selvagge, che mi costano salute: vado a raccogliere e mangiare dove il cibo è abbondante, poi mi rifugio nel rifugio (17,2) a riposare.»
- d8 6h, **Quin** *(thought)*: «Sono fuori dal riparo nelle terre selvagge e non ho legna; Ilse ha molta legna e non le servono semi, quindi scambio lì…»

## 5. A note on language

The instructions say «Pensi e parli in italiano». Speech stayed Italian throughout; some reasoning summaries
came back in English, for example Vera at d2 23:07 *(thought)*: "I need to sort out my situation: I'm at my
shelter with 3 corde in my bag, and I'm weighing Tomas's request for 2 corde in exchange for his 2 selci…".
