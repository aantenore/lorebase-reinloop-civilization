# Upstream issues

Friction found in the projects this demo builds on, worked around here without patching them.

## 1. lorebase: compose silently runs a stale `lorebase:dev` image

- **Severity:** dx
- **Repro:** with an older local `lorebase:dev` image present, from the Lorebase checkout:
  `docker compose --env-file .env -f deploy/compose/docker-compose.yaml up -d postgres migrate keeper`
- **Expected:** the stack runs the code of the checkout, or warns that the image is older than the
  mounted `config/lorebase.example.yaml`.
- **Actual:** Keeper restarts in a loop with `invalid configuration: read.history.lineage_max_changes:
  Extra inputs are not permitted` (config file newer than the image). After rebuilding, `migrate`
  fails on the same volume with `Can't locate revision identified by '0034'` (volume migrated by the
  other image).
- **Where:** `deploy/compose/docker-compose.yaml` (`image: ${LOREBASE_IMAGE:-lorebase}:${LOREBASE_TAG:-dev}`
  with `build:` but no pull/build policy), `config/lorebase.example.yaml` mounted from the checkout.
- **Workaround:** `scripts/lorebase-up.sh` uses its own tag (`LOREBASE_TAG=civ-demo`), builds it once
  from the checkout (`REBUILD=1` to rebuild) and its own compose project/volume (`-p civ-lorebase`).

## 2. lorebase: demo-friendly Keeper settings are not reachable through the compose env file

- **Severity:** dx
- **Repro:** set `LOREBASE__KEEPER__PROPOSALS__ALLOW_SELF_APPROVAL=true` in the `--env-file`;
  approve your own Proposal into `main` with `POST .../proposals/{id}/reviews {"verdict":"approve"}`.
- **Expected:** the variable reaches Keeper (the quickstart suggests `allow_self_approval: true` for
  a local trial with auth mode `none`).
- **Actual:** compose forwards only an explicit list of variables to `keeper`, so the merge stays
  blocked on approvals; the same holds for `keeper.operations.direct_commit_on_protected`.
- **Where:** `deploy/compose/docker-compose.yaml` (`x-keeper.environment`), `docs/quickstart.md`
  ("Propose the changes to `main`").
- **Workaround:** `deploy/compose.override.yaml` adds both variables to `keeper`.

## 3. lorebase: attribute api name `key` is reserved, not mentioned in the schema guides

- **Severity:** doc
- **Repro:** `POST /api/v1/domains/world/schema:validate?branch=main` with a Kind whose primary key
  attribute is named `key`.
- **Expected:** the schema guides (`examples/schema_as_code.md`, `docs/quickstart.md`) list reserved
  attribute names.
- **Actual:** `schema.api_name_reserved: api name 'key' is reserved`; the list (`key`, `kind`, `ref`,
  `revision`) is only in code.
- **Where:** `packages/core/src/lorebase_core/validate/schema_rules.py:55`.
- **Workaround:** the `Rule` and `Role` Kinds use `code` as primary key; the API maps it to `key`.

## 4. reinloop: `"anthropic/<model>"` cannot send extra headers (workspace id)

- **Severity:** dx
- **Repro:** an `ANTHROPIC_API_KEY` that is not scoped to a workspace;
  `await agent({ model: 'anthropic/claude-haiku-5-5' }).run('hi')`.
- **Expected:** a way to pass `anthropic-workspace-id` (e.g. an `ANTHROPIC_WORKSPACE_ID` variable or
  preset headers), as for `ANTHROPIC_BASE_URL`.
- **Actual:** `HTTP 400 ... This API key is not scoped to a workspace, so this request must include
  the anthropic-workspace-id header`. The preset passes only base URL and key.
- **Where:** `src/presets.ts` (`presetProvider`, `PRESETS.anthropic`); `src/providers/anthropic.ts`
  already accepts `headers`.
- **Workaround:** with `ANTHROPIC_WORKSPACE_ID` set, `server/src/agents/registry.ts` builds the
  provider itself: `withRetry(anthropic({ ..., headers: { 'anthropic-workspace-id': id } }))`.

## 5. reinloop: the Anthropic provider ignores structured output (`responseSchema`)

- **Severity:** bug
- **Repro:** `agent({ model: 'anthropic/claude-haiku-5-5', output: { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] } }).run('...')`.
- **Expected:** the schema reaches the model (Anthropic structured outputs / a forced tool), as
  `openaiCompatible` does with `response_format: json_schema`.
- **Actual:** the request body never carries the schema; the model answers free text, validation
  fails and only the retry message (`OUTPUT_FEEDBACK`) shows the schema, costing a turn. With
  tools present the loop does not even set `responseSchema` (`src/loop.ts:172`).
- **Where:** `src/providers/anthropic.ts:32` (body built without `req.responseSchema`).
- **Workaround:** plans are committed through a `commit_plan` tool (the tool schema is enforced);
  group members that answer with JSON get the JSON shape in their prompt (`rt.group.format`).

## 6. reinloop: a tool cannot end the run

- **Severity:** dx
- **Repro:** a "final answer" tool (`commit_plan`) whose call should be the last step of the run.
- **Expected:** a way for a tool result to stop the loop (e.g. `{ content, stop: true }`).
- **Actual:** `ToolOutput` is `{ content, isError }` only (`src/types.ts:75`): the model always
  gets one more turn after the tool result, which is wasted tokens and latency.
- **Workaround:** the tool aborts the run's `AbortSignal` after recording the plan
  (`server/src/rt/decide.ts`); the run ends `interrupted`, which the caller treats as success.

## 7. reinloop: MCP tool names are always prefixed; delegated runs do not stream to the parent

- **Severity:** dx
- **Repro:** `mcpTools('lorebase', { url })` exposes `lorebase__lorebase_get`; `prefix: ''` gives `__lorebase_get`.
  Separately, the `orchestrator` pattern's workers (`agentTool`) emit their events only to sinks, not to
  the parent handle's stream.
- **Expected:** a way to keep the server's own tool names (Herald already prefixes them `lorebase_*`);
  the docs mention that only `sinks` see delegated runs.
- **Where:** `src/mcp/client.ts:249` (`mcpTools`), `src/subagent.ts:30` (`runMember` without forwarding).
- **Workaround:** the game builds its own tools from `McpClient.listTools()` / `callTool()`
  (`server/src/rt/brain.ts`); group decision traces are collected with a `Sink` passed in the run options.

## 8. lorebase (Herald): Streamable HTTP requires a bearer even when Keeper runs with auth `none`

- **Severity:** doc
- **Repro:** Keeper with `auth.mode: none`; Herald with `LOREBASE__HERALD__TRANSPORT=streamable_http`; call
  any tool without `Authorization`.
- **Expected:** the docs say what to send when Keeper needs no credential (local demo), or Herald
  forwards nothing in that case.
- **Actual:** `[unauthorized] this request carries no credential`; any bearer value works.
- **Where:** `packages/herald/src/lorebase_herald/server.py:72` (`Credentials.__call__`), `docs/mcp.md` ("Credentials").
- **Workaround:** the game sends `Authorization: Bearer ${HERALD_API_KEY:-local}`.

## 9. lorebase: no Herald service in the compose file

- **Severity:** dx
- **Repro:** `docker compose -f deploy/compose/docker-compose.yaml config --services`.
- **Expected:** an optional `herald` service (Streamable HTTP) next to `keeper`, as `docs/mcp.md` describes a shared Herald.
- **Actual:** only stdio/host recipes; a shared Herald must be started by hand.
- **Where:** `deploy/compose/docker-compose.yaml`.
- **Workaround:** `scripts/herald-up.sh` runs the backend image (`python -m lorebase_herald`) on the
  compose network with `LOREBASE__HERALD__HTTP__HOST=0.0.0.0` and explicit `ALLOWED_HOSTS`, published on 127.0.0.1:8190.

## 10. lorebase: Keeper CORS cannot expose `ETag`/`Lorebase-Revision`; `allow_headers` replaces defaults

- **Severity:** dx
- **Repro:** `LOREBASE__KEEPER__CORS__ALLOW_ORIGINS='["http://localhost:5180"]'`, web app in live mode on that origin
  (cross origin); `GET /api/v1/domains` and read `ETag`.
- **Expected:** a setting such as `keeper.cors.expose_headers` so the web adapter's conditional reads work
  cross origin; `allow_headers` adding to the defaults.
- **Actual:** exposed headers are fixed (`X-Request-ID` plus the rate-limit ones); `ETag` is not, so every read is a plain 200
  (documented in `apps/web/README.md`). `allow_headers` replaces the default list, so `If-None-Match` must be added together with the three defaults.
- **Where:** `packages/keeper/src/lorebase_keeper/app.py:217`, `packages/keeper/src/lorebase_keeper/settings.py:33` (`CorsSettings`).
- **Workaround:** `deploy/compose.override.yaml` sets `LOREBASE__KEEPER__CORS__ALLOW_ORIGINS` / `__ALLOW_HEADERS` (JSON lists); no conditional reads.

## 10. reinloop: `MemoryStore` has no search hook; `recall` always ranks by keyword overlap

- **Severity:** dx
- **Repro:** back `memoryTools({ store })` with a semantic store; `recall` calls `store.all(ns)` and ranks with `rank()`.
- **Expected:** an optional `search(namespace, query, limit)` on `MemoryStore` used by `recall` when present.
- **Actual:** the store can only return everything; ranking is word overlap (`src/tools/memory.ts:44` `rank`, `:83` `recall`).
- **Workaround:** the game defines its own `remember`/`recall` tools that call mnemo (`server/src/rt/brain.ts`).

## 11. reinloop: `parallel` pattern reports only "all workers failed"

- **Severity:** dx
- **Repro:** a `parallel` team whose workers all end with a non-completed status (budget, timeout, provider error).
- **Expected:** the failed result carries the workers' reasons.
- **Actual:** `reason: 'all workers failed'` only (`src/patterns.ts:105`); the cause is visible only in each worker's `run_end`.
- **Workaround:** the group decision sink collects every non-completed `run_end` reason, budget stops included (`server/src/rt/groups.ts`); the council uses its own tolerant proposals pattern, where a worker stopped by its budget still contributes what it said and the elder decides alone when nobody proposed.

## 12. reinloop: `parseYaml` rejects multi-line flow mappings

- **Severity:** dx
- **Repro:** `parseYaml('a:\n  - {code: x,\n     name: y}\n')`.
- **Expected:** valid YAML parses (or the docs state the supported subset).
- **Actual:** `frontmatter line N: expected ":" after ""` (`src/frontmatter.ts`, `flowValue`).
- **Workaround:** `lorebase/economy.seed.yaml` uses block style only.

## 13. lorebase: reserved attribute names also include `kind`

- **Severity:** doc (same as 3)
- **Repro:** a Kind attribute named `kind` → `schema.api_name_reserved`.
- **Workaround:** the `Resource` Kind uses `category`.

## 14. reinloop: thinking-only answers look like "empty responses"

- **Severity:** bug
- **Repro:** a Claude 5.5 model (thinking on by default) with a small `maxTokens` (e.g. 300): the
  answer stops at `max_tokens` with only a `thinking` block.
- **Expected:** a `max_tokens` stop is reported as such (or the run continues with a larger budget).
- **Actual:** the Anthropic provider drops thinking blocks (`src/providers/anthropic.ts`, `toParts`),
  so the message has no parts; the loop retries the identical request and fails with
  `model returned 3 empty responses in a row` (`src/loop.ts`), each retry paying the full thinking budget.
- **Workaround:** `decisions.modelExtra` sends `output_config.effort: "low"` for replies and group
  prose (`thinking.type: "disabled"` is not accepted by every 5.5 model), with larger `maxTokens`;
  a reply with no words leaves the person silent instead of counting as a failure.
