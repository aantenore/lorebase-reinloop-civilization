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
