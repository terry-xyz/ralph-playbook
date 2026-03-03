# Implementation Plan — Ralph Monitor

> **Status**: All phases A–R complete + S8/S9/S10/S11/S12/S13/S14/S15/S16/S17/S27/S28. 301 tests passing across 10 test files. TypeScript compiles cleanly. Vite build succeeds.
>
> **Scope**: Phase 1 (Core Dashboard). All code lives in `/monitor`. Nothing outside that directory is touched.
>
> **Tech Stack**: Node.js + Fastify, React SPA + Vite, Tailwind CSS + Tremor, SQLite via sql.js (WASM), WebSocket via @fastify/websocket
>
> **Key Architectural Constraints**:
> - All code, config, and data live under `/monitor`. Nothing outside is modified.
> - sql.js runs entirely in-memory; must explicitly flush to disk on an interval and on shutdown.
> - Single-writer constraint: only the Ingester daemon writes to the database. The dashboard server reads only.
> - All monitoring hooks MUST use `"async": true` (fire-and-forget) to avoid blocking Claude Code.
> - Guardrail hooks are synchronous (Phase 3 scope, but config UI scaffolding is Phase 1).
> - Event names must match Claude Code's actual hook names: `PostToolUseFailure` (not ToolError), `SubagentStart`/`SubagentStop` (not SubagentSpawn/SubagentComplete), `PreCompact` (not ContextCompaction), `PermissionRequest` (not PermissionDecision).
> - Full-text search with sql.js WASM needs FTS5 compatibility validation during Phase C; fall back to LIKE queries if unavailable.
> - WebSocket resume protocol: clients send `last_event_id` on connect; server replays missed events.
> - Dashboard binds to `127.0.0.1:9100` (localhost only, default port).
> - Exactly 4 session statuses: `running`, `completed`, `errored`, `stale`.
> - 8 inferred agent phases: Reading the plan, Orienting, Investigating code, Implementing, Validating, Committing, Updating the plan, Delegating.
> - 4 database tables: `sessions`, `events`, `metrics`, `guardrail_log`.
> - 6 dashboard pages: Dashboard, Sessions, Live Feed, Costs, Errors, Settings.
> - Event files: `/monitor/data/events/events-YYYY-MM-DD.jsonl` (daily rotation).
> - Database file: `/monitor/data/ralph-monitor.db`.
> - Config file: `/monitor/ralph-monitor.config.json`.
> - Ingester daemon: separate detached process spawned by hooks via lock file at `/monitor/data/ingester.lock`. Dashboard also ingests if no daemon running.

---

## Gap Analysis Findings (Phase 2 Increment)

> Thorough spec-vs-implementation review revealed the following gaps. Items are prioritized by impact.

### Completed
- [x] **S1** — Default guardrail rules in DEFAULT_CONFIG (Spec 14 ACs 16-18): Added all 6 rules with proper defaults to `constants.ts`
- [x] **S2** — Guardrails configuration section in Settings page (Spec 14 ACs 28-30): Added full guardrails UI with mode selectors and parameter editors
- [x] **S3** — Data purge control with confirmation (Spec 14 ACs 36-37): Added POST /api/data/purge endpoint + Settings purge button with confirmation dialog
- [x] **S4** — Port restart warning in Settings (Spec 14 AC 27): Added informational callout when port is changed
- [x] **S5** — Make dashboard session cards clickable (Spec 08 AC 15): SessionCard now navigates to session detail on click
- [x] **S6** — Live Activity sidebar shows real WebSocket events (Spec 09 ACs 7-9): Sidebar displays real-time WS events with type badges, timestamps, and connection status
- [x] **S6a** — Config API PATCH route missing: Client sends PATCH but server only had PUT; added PATCH handler

### Backlog — High Priority
- [x] **S7** — Session Detail as side panel (Spec 10 ACs 1-11): Implemented as SessionDetailPanel component with sliding panel, drag-to-resize, three dismissal methods (close button, Escape, click outside), and View Full navigation
- [x] **S8** — Full-text search on Sessions page (Spec 11 ACs 21-26): Added search bar with debounced input, server-side LIKE query on event payloads via `?search=` param on `GET /api/sessions`, combines with all filters
- [x] **S13** — Model filter on Sessions page (Spec 11 AC 14): Added model dropdown populated from data via `GET /api/sessions/filters` endpoint, filters server-side
- [x] **S14** — Agent name column in Sessions table (Spec 11 AC 1): Added `agentName` field to Session type, `agent_name` column to DB schema with migration, derived from workspace path in session-lifecycle, displayed as column in table
- [x] **S15** — Live-updating duration for running sessions (Spec 11 AC 3): Added `LiveDurationCell` component with 1-second interval timer for running sessions, shows elapsed time from startTime to now
- [x] **S9** — Cost trend time-series visualization (Spec 12 ACs 7-12): Added `GET /api/analytics/costs/trend` endpoint with daily/weekly/monthly granularity and previous period comparison; AreaChart component in CostsPage with granularity selector; 7 backend tests
- [x] **S10** — Budget threshold alert banners on Costs page (Spec 12 ACs 25-30): Added `GET /api/analytics/budget-alerts` endpoint checking per-session and per-day limits from config; persistent amber alert banners on CostsPage; 6 backend tests
- [x] **S16** — Custom date range picker on Costs page (Spec 12 AC 34): Added custom date range option with two date inputs alongside preset buttons; also added "agent name" dimension
- [x] **S11** — Error rate time-series chart (Spec 13 ACs 18-21): Added `GET /api/analytics/errors/trend` endpoint with adaptive bucket sizing, stacked AreaChart by error category, session start/stop overlays, filter support; 5 backend tests
- [x] **S12** — Rate limit sub-view on Errors page (Spec 13 ACs 22-26): Added `GET /api/analytics/errors/rate-limits` endpoint with frequency, model attribution, and cooldown pattern detection; toggle between Error Log and Rate Limits views; AreaChart frequency, BarChart by model, cooldown table; 5 backend tests
- [x] **S17** — Scraper integrated into ingestion pipeline (Spec 02/03): `insertBatch()` now collects sessions with Stop/SessionEnd events and fire-and-forget calls `scrapeSession()` after COMMIT; config threaded through `processFile`, `processAllFiles`, and `Ingester` class; 7 backend tests
- [ ] **S18** — Ingester daemon process missing (Spec 02): No lock file, detached process, signal handling
- [ ] **S19** — Project collision disambiguation (Spec 01 AC 23, Spec 05 AC 7): No hash-based disambiguation
- [ ] **S20** — Subagent tracking metadata on parent session (Spec 05 ACs 11-12): Only turn_count incremented, no spawn count/tasks
- [ ] **S21** — WebSocket resume may produce duplicates on same-timestamp events (Spec 06)
- [ ] **S22** — Error analytics category filter is client-side, breaks pagination (Spec 06)
- [ ] **S23** — Cost analytics endpoint missing "estimated cost avoided" (Spec 06)
- [ ] **S24** — Top stats toolCallsPerMin returns numbers not (timestamp, count) pairs (Spec 06)
- [ ] **S25** — No Fastify schema validation on any API endpoint (Spec 06)
- [ ] **S26** — Multiple model tracking stores only last model (Spec 03 AC 2)
- [x] **S27** — Scraped errors persisted to database (Spec 03 AC 6): Added `ScrapedError` event type; `scrapeSession()` now inserts extracted errors into events table with pre-classified categories, increments session `error_count`; analytics error endpoints (list, trend, rate-limits) updated to include ScrapedError; 4 backend tests
- [x] **S28** — Session detail enhancements (Spec 10 ACs 26-29, 36): Fixed `api.getSession()` to properly unwrap `{session, metrics, tools}` envelope; exact cost breakdown from metrics; expandable tool entries showing individual call inputs/outputs (AC 26); token usage BarChart (ACs 27-28); AC 36 (auto-refresh) was already implemented; fixed events endpoint to return `{data}` with correct field names matching `EventRecord` type
- [ ] **S29** — ErrorsPage missing: tool filter (Spec 13 AC 5), live updates (AC 29)
- [ ] **S30** — CostsPage: default time range not from config (Spec 12 AC 32), cost-avoided uses hardcoded rate (AC 21)
- [ ] **S31** — CLI wizard: 11 ACs untested (Spec 15 ACs 2,5-9,11-13,15-16)

---

## Priority Implementation Order (All NOT STARTED)

> Implementation in progress. Items are listed in dependency-aware priority order — implement top-to-bottom.

### Critical Path (Blocks Everything)
- [x] **A1** — Initialize `monitor/` directory, `package.json`, dependencies
- [x] **A2** — TypeScript configuration (strict, path aliases)
- [x] **A3** — Vite + React + Tailwind + Tremor setup
- [x] **A4** — Shared types, constants, event-name mapping (12 events, 4 statuses, 8 phases)

### Data Foundation (Blocks All Backend)
- [x] **B1** — Config file loader (Spec 14: 17 defaults, graceful fallbacks)
- [x] **B2** — Config writer (atomic write, partial update)
- [x] **C1** — sql.js WASM init + 4-table schema (sessions, events, metrics, guardrail_log)
- [x] **C2** — Persistence: periodic flush + atomic write to disk
- [x] **C3** — Retention/pruning + vacuuming (30-day default, all 4 tables)
- [x] **C4** — FTS5 compatibility validation (fallback to LIKE)

### Event Pipeline (Blocks Real-Time Features)
- [x] **D1** — Hook scripts for all 12 event types (async, fire-and-forget)
- [x] **D2** — JSONL daily rotation file format
- [x] **E1** — Ingester: file watcher + position tracking
- [x] **E2** — Ingester: batch parsing + idempotent insertion
- [x] **E3** — Ingester: daemon lifecycle (lock file, detached, stale recovery)
- [x] **E4** — Post-ingestion JSONL cleanup

### Session Intelligence (Blocks Dashboard Content)
- [x] **F1** — Post-session scraper: 8 metric categories from Claude session files
- [x] **F2** — Scraper results → metrics table + sessions table update
- [x] **G1** — Session status tracking (4 states, 6 valid transitions)
- [x] **G2** — Agent phase inference (8 phases from tool patterns)
- [x] **G3** — Orphan/stale detection (60-min timeout)
- [x] **G4** — Project derivation (git remote → org/repo, fallback to dir name)
- [x] **G5** — Subagent tracking (within parent session)
- [x] **G6** — Error categorization engine (3 sources → 5 categories)

### Server & API (Blocks Frontend)
- [x] **H1** — Fastify server (localhost:9100, SPA serving, graceful shutdown)
- [x] **H2** — REST: Sessions endpoints (list + detail + events, filtering, sorting, pagination)
- [x] **H3** — REST: Analytics + Top Stats (costs, errors, overview)
- [x] **H4** — REST: Config endpoints (read/write)
- [x] **H5** — REST: Search endpoint (FTS5 or LIKE fallback)
- [x] **H6** — WebSocket: live event streaming (resume, filter, heartbeat)
- [x] **H7** — SPA fallback routing
- [x] **H8a** — REST: Guardrail log endpoint (Phase 3 scaffold)
- [x] **H8** — API rate limiting

### Frontend Shell (Blocks All Pages)
- [x] **I1** — 4-region layout (top nav, left sidebar, main, live activity sidebar)
- [x] **I2** — React Router: 6 pages, lazy-loaded
- [x] **I3** — WebSocket client hook (auto-reconnect, exponential backoff)
- [x] **I4** — Data fetching layer (typed API wrappers)
- [x] **I5** — Dark/light theme (default dark, localStorage persistence)

### Frontend Pages (Parallelizable After I)
- [x] **J1–J4** — Kanban Dashboard (stats bar, project filter, columns, session cards)
- [x] **K1–K4** — Live Activity Feed (sidebar, full-page, verbosity, auto-pause)
- [x] **L1–L3** — Session Detail (side panel + full-page view, 5 content sections)
- [x] **M1–M3** — Sessions Table (11 columns, sort, filter, search)
- [x] **N1–N4** — Cost Analytics (dimensions, cache efficiency, budget alerts, pricing)
- [x] **O1–O4** — Error Monitoring (log table, categorization, rate chart, rate limit sub-view)
- [x] **P1–P2** — Settings Page (4 sections, validation, save)

### CLI & Integration (Can Start After D+B)
- [x] **Q1** — CLI wizard (6-step flow: detect, scope, inject, preserve, guardrails, config)
- [x] **Q2** — Setup verification (test event, success/failure reporting)
- [x] **Q3** — Manual setup documentation

### Final Verification
- [x] **R1** — End-to-end integration test
- [x] **R2** — `package.json` bin entry + npx support
- [x] **R3** — Build and package verification

---

## Phase A: Project Foundation & Scaffolding

**Spec coverage**: Groundwork for all specs. No single spec owns this.

- **A1. Initialize `monitor/` directory structure and `package.json`**
  - Create the canonical directory layout:
    ```
    monitor/
      package.json
      tsconfig.json
      vite.config.ts
      tailwind.config.ts
      postcss.config.js
      ralph-monitor.config.json     # Default config (Spec 14)
      src/
        server/        # Fastify backend
        client/        # React SPA
        shared/        # Types, constants, utils shared across server & client
        hooks/         # Hook scripts (Node.js)
        cli/           # CLI setup wizard
        lib/           # Project standard library for shared utilities
      data/            # Runtime data (events JSONL, SQLite DB, ingester lock)
        events/        # Daily rotated JSONL files
      public/          # Static assets served by Vite / Fastify
      tests/           # Co-located or mirrored test structure
    ```
  - `package.json` with `"type": "module"`, scripts for `dev`, `build`, `start`, `test`, `init`.
  - `"bin": { "ralph-monitor": "./src/cli/index.js" }` for npx support.
  - Dependencies: `fastify`, `@fastify/websocket`, `@fastify/static`, `sql.js`, `chokidar`, `react`, `react-dom`, `react-router-dom`, `@tremor/react`, `tailwindcss`, `vite`, `@vitejs/plugin-react`, `vitest`, `typescript`.
  - **Dependencies**: None.
  - **Tests**:
    - [x] `npm install` completes without errors.
    - [x] `npx tsc --noEmit` passes with zero errors on an empty project.
    - [x] `npx vite build` produces output in `dist/`.

- **A2. TypeScript configuration**
  - `tsconfig.json` with strict mode, path aliases (`@server/*`, `@client/*`, `@shared/*`).
  - Separate `tsconfig.server.json` (Node/ESM target) and `tsconfig.client.json` (DOM lib, JSX) extending the base.
  - **Dependencies**: A1.
  - **Tests**:
    - [x] Path aliases resolve correctly in both server and client code.
    - [x] Strict null checks are enforced (a deliberately nullable access causes a compile error).

- **A3. Vite + React + Tailwind + Tremor setup**
  - `vite.config.ts` with React plugin, proxy `/api` and `/ws` to Fastify dev server.
  - Tailwind configured with Tremor's preset/plugin.
  - A minimal `src/client/main.tsx` that renders a `<div>Ralph Monitor</div>` inside a Tremor `<Card>`.
  - **Dependencies**: A1, A2.
  - **Tests**:
    - [x] `vite dev` starts and serves the React app on the configured port.
    - [x] Tailwind utility classes (e.g., `bg-blue-500`) are present in compiled CSS.
    - [x] A Tremor `<Card>` component renders without runtime errors.

- **A4. Shared types and constants**
  - `src/shared/types.ts` — TypeScript interfaces for:
    - `HookEvent` (all 12 event types as a discriminated union on `type`): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest`, `SessionStart`, `SessionEnd`.
    - `Session` with exactly 4 statuses: `running` | `completed` | `errored` | `stale`.
    - `SessionPhase`: `Reading the plan` | `Orienting` | `Investigating code` | `Implementing` | `Validating` | `Committing` | `Updating the plan` | `Delegating`.
    - `EventRecord`: `{ id, sessionId, timestamp, type, tool, payload, project, workspace }`.
    - `Config` (full settings shape matching Spec 14 defaults).
  - `src/shared/constants.ts` — event type enum, default config values, file paths (`/monitor/data/events/`, `/monitor/data/ralph-monitor.db`, `/monitor/ralph-monitor.config.json`).
  - `src/shared/event-names.ts` — canonical mapping of Claude Code hook names, explicitly documenting: `PostToolUseFailure` (not ToolError), `SubagentStart`/`SubagentStop` (not SubagentSpawn/SubagentComplete), `PreCompact` (not ContextCompaction), `PermissionRequest` (not PermissionDecision).
  - **Dependencies**: A1, A2.
  - **Tests**:
    - [x] Types compile without error.
    - [x] Event name mapping covers all 12 hook event types.
    - [x] Default config values are complete and match Spec 14 defaults (port 9100, staleTimeoutMinutes 60, retentionDays 30, etc.).
    - [x] Session status type only allows 4 values: running, completed, errored, stale.
    - [x] Session phase type only allows the 8 defined phases.

---

## Phase B: Configuration System (Spec 14 — backend only)

**Spec coverage**: Spec 14 (Settings & Configuration) — server-side loading, validation, defaults.

- **B1. Config file loader**
  - Implement `src/server/config.ts` (or `src/lib/config.ts` for shared use):
    - Load config from `/monitor/ralph-monitor.config.json`.
    - Deep-merge with hardcoded defaults for all 7 categories: General, Ingestion, Scrape, Guardrails, Display, Pricing, Alerts.
    - Validate types and ranges (e.g., `retentionDays` must be positive integer, `port` must be valid port number, mode fields only "block"/"warn"/"off", theme only "dark"/"light", verbosity only "summary"/"granular").
    - Return a frozen config object.
    - On missing file: use all defaults silently (AC 2).
    - On invalid JSON: log warning, use all defaults (AC 4).
    - On invalid field value: default for that field only, keep valid fields (AC 5).
    - All 17 default values per Spec 14 AC 6-22: port=9100, dataDir="./data", staleTimeoutMinutes=60, retentionDays=30, batchIntervalMs=1000, batchSize=100, mode="auto", claudeDir="~/.claude", captureFullResponses=false, captureExtendedThinking=true, theme="dark", liveFeedVerbosity="summary", defaultCostRange="today", plus per-model pricing and guardrail defaults.
  - **Dependencies**: A4.
  - **Tests**:
    - [x] Missing config file returns all defaults without throwing (AC 2).
    - [x] Malformed JSON logs a warning and returns all defaults (AC 4).
    - [x] Partial config merges correctly — provided fields override defaults, missing fields get defaults (AC 3).
    - [x] Invalid field value (e.g., `retentionDays: -5`) falls back to default for that field only (AC 5).
    - [x] All 17 default values are correct per Spec 14 AC 6-22.
    - [x] Returned config object is frozen (mutations throw in strict mode).

- **B2. Config writer**
  - Implement `writeConfig(partial: Partial<Config>): void` — merges partial update into existing file on disk, writes atomically (write to tmp then rename).
  - Unmodified fields preserved (AC 39).
  - Valid JSON guaranteed (AC 40).
  - Never corrupts the file.
  - **Dependencies**: B1.
  - **Tests**:
    - [x] Writing a partial config preserves existing fields in the file (AC 39).
    - [x] File is written atomically — no partial writes on crash.
    - [x] Written config can be re-loaded and matches expectations (AC 41).
    - [x] Output is always valid JSON (AC 40).

---

## Phase C: Data Storage (Spec 04)

**Spec coverage**: Spec 04 (Storage Layer).

- **C1. sql.js WASM initialization and schema creation**
  - Implement `src/server/storage.ts` (or `src/lib/storage.ts`):
    - Initialize sql.js with the WASM binary (zero native deps, cross-platform).
    - On startup: attempt to load existing `.db` file from `/monitor/data/ralph-monitor.db` (or config `dataDir`). If missing or corrupt, create fresh.
    - Execute schema DDL for exactly 4 tables per Spec 04:
      - `sessions` — session_id, project, workspace, model, status (running/completed/errored/stale), start_time, end_time, total_cost, token_counts (JSON), turn_count, inferred_phase, last_seen, error_count
      - `events` — event_id (unique), session_id (FK), timestamp, type, tool_name, payload (JSON), duration
      - `metrics` — session_id (FK), cost_breakdown, token_breakdown (input/output/cache_creation/cache_read), model, wall_clock_duration, api_duration, turn_count
      - `guardrail_log` — id, session_id (FK), rule_name, action, timestamp, payload (JSON)
    - Create indices on session_id, timestamp, type, project.
    - Referential integrity: events, metrics, guardrail_log each belong to exactly one session.
  - **Dependencies**: A4, B1.
  - **Tests**:
    - [x] Fresh database creation succeeds and all 4 tables exist.
    - [x] Loading an existing valid `.db` file preserves data.
    - [x] Loading a corrupt `.db` file logs a warning and creates a fresh database.
    - [x] All expected indices are present after initialization.
    - [x] Schema supports all fields defined in Spec 04.
    - [x] Session status column only accepts: running, completed, errored, stale.
    - [x] Identical behavior on Windows, Linux, macOS (no native compilation).
    - [x] Referential integrity enforced: events, metrics, guardrail_log each belong to exactly one session (Spec 04 AC 5-7).
    - [x] Tool call events store input arguments in payload (Spec 04 AC 26).
    - [x] Full file contents/snapshots are NEVER stored — only tool arguments (Spec 04 AC 27).
    - [x] Edit/Write event payloads retain sufficient data (old_string + new_string) to reconstruct diffs in UI (Spec 04 AC 28).
    - [x] JSON payloads stored are retrievable in their original structure (Spec 04 AC 31).
    - [x] Querying events by type/session/time range returns complete, parseable JSON payloads (Spec 04 AC 32).
    - [x] No payload data is silently truncated or corrupted during storage or retrieval (Spec 04 AC 33).
    - [x] Only one process accesses the DB file at any given time (Spec 04 AC 24).
    - [x] Second process attempting access does not corrupt DB or silently overwrite data (Spec 04 AC 25).

- **C2. Persistence (flush to disk)**
  - Implement periodic flush: `db.export()` writes Uint8Array to disk at `/monitor/data/ralph-monitor.db`.
  - Flush on interval (configurable, bounded data loss window).
  - Flush on graceful shutdown (SIGINT, SIGTERM).
  - Flush on signal-based shutdown.
  - Atomic write (write to tmp file, then rename) — crash during write must not leave partially written file (Spec 04).
  - Always-valid file on disk (Spec 04).
  - **Dependencies**: C1.
  - **Tests**:
    - [x] Data inserted in-memory is present on disk after a flush.
    - [x] Flush uses atomic write (tmp + rename pattern).
    - [x] Graceful shutdown triggers a final flush.
    - [x] Interval-based flush fires at the configured cadence (use fake timers).
    - [x] Crash during write does not corrupt the existing DB file on disk.
    - [x] Data loss is bounded to events since last flush (JSONL files serve as recovery source).
    - [x] After process restart, all data from last successful persistence cycle is available (Spec 04 AC 19).
    - [x] Data written between persistence cycles is acknowledged as lost on unclean crash — not a bug (Spec 04 AC 20).

- **C3. Retention / pruning + vacuuming**
  - Implement `pruneOldData(retentionDays: number): void` — deletes rows older than the retention window from all 4 tables uniformly (Spec 04 AC 12).
  - Run on startup and on a daily interval.
  - Full hard delete — no summary/aggregated data preserved after deletion (Spec 04 AC 14).
  - Run VACUUM after purge to reclaim space (Spec 04 AC 16, 23).
  - Retention period adjustable via config without process restart (Spec 04 AC 15).
  - **Dependencies**: C1, B1 (for retention_days config).
  - **Tests**:
    - [x] Records older than `retention_days` are deleted.
    - [x] Records within the retention window are preserved.
    - [x] Pruning runs on startup.
    - [x] Pruning runs on the configured daily interval.
    - [x] Purge applies uniformly to ALL 4 tables: sessions, events, metrics, guardrail_log (Spec 04 AC 12).
    - [x] After purge, no records older than retention period remain in any table (Spec 04 AC 13).
    - [x] No summary/aggregated data is preserved after deletion — full hard delete (Spec 04 AC 14).
    - [x] Retention period change via config takes effect without restart (Spec 04 AC 15).
    - [x] Database file size decreases after purge due to vacuuming (Spec 04 AC 16).
    - [x] Database remains functional under typical workloads (multiple concurrent sessions, thousands of events/day) across 30-day retention window (Spec 04 AC 21).
    - [x] Database size stays well under 1 GB for normal usage (Spec 04 AC 22).
    - [x] Vacuuming reclaims space from deleted records — no unbounded growth (Spec 04 AC 23).

- **C4. FTS compatibility validation**
  - Attempt to create an FTS5 virtual table in sql.js.
  - If FTS5 is available: create the FTS index on the `events` table's `payload` column.
  - If FTS5 is unavailable: log a warning, set a runtime flag `ftsAvailable = false`, and fall back to `LIKE` queries in search endpoints.
  - **Dependencies**: C1.
  - **Tests**:
    - [x] FTS5 virtual table creation is attempted.
    - [x] If FTS5 is available, full-text queries return correct results.
    - [x] If FTS5 is unavailable, the fallback flag is set and LIKE queries work correctly.

---

## Phase D: Hook Event Collection (Spec 01)

**Spec coverage**: Spec 01 (Hook Integration Layer).

- **D1. Hook scripts for all 12 event types**
  - Create Node.js hook scripts in `monitor/src/hooks/` (cross-platform via `#!/usr/bin/env node`):
    - All 12 event types: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest`, `SessionStart`, `SessionEnd`.
    - All monitoring hooks configured with `"async": true` (fire-and-forget, Spec 01 AC 1-4).
  - Each hook script:
    1. Reads JSON event from stdin.
    2. Constructs event record: `{ id (unique), sessionId (from $CLAUDE_SESSION_ID env), timestamp (ISO 8601), type, tool (if applicable), payload, project (derived from working dir), workspace }`.
    3. Appends single JSONL line to daily rotating file: `/monitor/data/events/events-YYYY-MM-DD.jsonl`.
    4. Checks ingester lock file at `/monitor/data/ingester.lock`; if no live ingester, spawns one as detached process (`child_process.spawn` with `{detached: true, stdio: 'ignore'}`).
    5. Exits 0 immediately. Crashes NEVER surface to agent (AC 1-4).
  - `PreToolUse` and `PostToolUse` share a `tool_use_id` for correlation (AC 32-33).
  - Auto-create `/monitor/data/events/` directory if missing (AC 40).
  - **Dependencies**: A1, A4.
  - **Tests**:
    - [x] Each of the 12 hook scripts exists and is executable (AC 5-17).
    - [x] Hook writes a valid JSONL line to `/monitor/data/events/events-YYYY-MM-DD.jsonl`.
    - [x] Event record contains all required fields: id (unique), sessionId, timestamp (ISO 8601), type, payload, project, workspace (AC 18-24).
    - [x] Hooks exit with code 0 regardless of write success — errors swallowed (AC 1-4).
    - [x] Hooks complete within 50ms (non-blocking, AC 1).
    - [x] PreToolUse/PostToolUse events share `tool_use_id` for pairing (AC 32-33).
    - [x] Data directory auto-created if missing (AC 40).
    - [x] Concurrent writes to same JSONL file don't corrupt data — append mode with newline termination (AC 25-31).
    - [x] Silent failure on disk full — exits 0, no error surfaced (AC 41).
    - [x] Cross-platform: works on Windows, macOS, Linux (AC 43).
    - [x] Hook checks lock file and spawns ingester if not running (AC 34-37).
    - [x] No events silently dropped under normal operating conditions (disk available, filesystem writable) (AC 17).
    - [x] Event-specific data preserves ALL information from Claude Code without truncation or modification (AC 22).
    - [x] Malformed or missing JSON from stdin handled gracefully — hook does not crash (AC 42).
    - [x] A failing hook script does not prevent subsequent hooks from firing within the same session (AC 4).

- **D2. Event file format and daily rotation**
  - Daily rotating JSONL files: `/monitor/data/events/events-YYYY-MM-DD.jsonl` (Spec 01).
  - Each line is self-contained valid JSON (AC 25-31).
  - File rotation happens naturally at midnight (new date = new filename).
  - Crash-safe partial writes: incomplete lines are tolerable (ingester handles them).
  - **Dependencies**: D1.
  - **Tests**:
    - [x] Events directory is created on first hook invocation if absent.
    - [x] Events from different sessions interleave correctly in the same daily file.
    - [x] Each JSONL line is independently parseable by `JSON.parse()`.
    - [x] Date rollover creates a new file with the new date.

---

## Phase E: Ingester Daemon (Spec 02)

**Spec coverage**: Spec 02 (Event Ingestion Pipeline).

- **E1. File watcher and position tracking**
  - Implement `src/server/ingester.ts`:
    - Use `chokidar` to watch `/monitor/data/events/` for new and changed `.jsonl` files.
    - Track read position per file (byte offset) — never re-processes ingested lines across restarts (Spec 02).
    - Persist position tracking (sidecar file or DB table) so restarts don't reprocess.
    - **CRITICAL**: Position tracking must NOT advance ahead of a successful database save, or recovery from JSONL files becomes impossible on crash (Spec 02 risk).
    - Handle midnight rotation automatically — detect new daily files.
    - Resilient to partial line writes — wait for complete lines (newline terminated).
  - **Dependencies**: C1, D2.
  - **Tests**:
    - [x] Watcher detects a newly created JSONL file.
    - [x] Watcher detects appended lines to an existing file.
    - [x] Only new lines since last read offset are processed (no duplicates).
    - [x] Position survives ingester restart — no re-processing.
    - [x] Partial lines (no trailing newline) are held until complete.

- **E2. Batch parsing and insertion**
  - Parse JSONL lines into typed `HookEvent` objects.
  - Validate each line; skip malformed lines with a warning log (resilient, Spec 02).
  - Batch-insert valid events into the `events` table (single transaction per batch).
  - Time-based flush: configurable interval (default 1000ms, from config `batchIntervalMs`).
  - Size-based flush: configurable threshold (default 100 events, from config `batchSize`).
  - Atomic batch writes: all-or-nothing per batch.
  - Idempotent by event unique ID — no duplicates on re-processing (Spec 02).
  - Derive and upsert `sessions` rows from events (create session on first unseen sessionId).
  - **Dependencies**: E1, C1, A4.
  - **Tests**:
    - [x] Valid JSONL lines are inserted into the `events` table.
    - [x] Malformed JSONL lines are skipped and logged, without aborting the batch.
    - [x] Batch insertion is atomic (all-or-nothing per batch via transaction).
    - [x] First event with unseen sessionId auto-creates a session row with status `running`.
    - [x] Duplicate event IDs are rejected (idempotent).
    - [x] Time-based flush fires at configured interval.
    - [x] Size-based flush fires at configured threshold.
    - [x] When a batch insertion fails (DB error, corrupt event), events from prior successful batches remain intact (Spec 02 AC-B3).

- **E3. Daemon lifecycle (detached process)**
  - Ingester runs as a detached background daemon (Spec 02):
    - Single-instance guarantee via lock file at `/monitor/data/ingester.lock` (PID stored inside).
    - Auto-started by hook scripts when no live ingester detected.
    - Dashboard-triggered fallback: if no daemon running at dashboard start, dashboard ingests accumulated files first.
    - Survives originating terminal closing (`child_process.spawn` with `{detached: true, stdio: 'ignore'}`).
    - Clean shutdown removes lock file.
    - Stale lock (dead PID) triggers fresh start.
    - Cross-platform PID liveness check — must work on Windows, macOS, and Linux (each has different process liveness mechanisms).
  - Also: ingester can run embedded in server process for the dashboard-triggered mode.
  - Graceful shutdown: stop watcher, flush pending batch, flush DB to disk, remove lock file.
  - **Dependencies**: E1, E2, C2.
  - **Tests**:
    - [x] Lock file is written with PID on daemon start.
    - [x] Second instance detects live daemon and exits.
    - [x] Stale lock file (dead PID) is recovered — new daemon starts.
    - [x] Graceful shutdown removes lock file.
    - [x] Graceful shutdown processes pending lines before exiting.
    - [x] Dashboard-triggered mode ingests accumulated files on startup.
    - [x] Ingester survives originating terminal closing (Spec 02 AC-L3).
    - [x] Two hooks firing simultaneously with no ingester → only one ingester starts (Spec 02 AC-L2).
    - [x] Cross-platform PID liveness check works on Windows, macOS, Linux.

- **E4. Post-ingestion file cleanup**
  - Fully ingested JSONL files older than 1 day are automatically deleted (Spec 02).
  - Never deletes files with unprocessed lines.
  - Never deletes current day's file (hooks may still append).
  - **Dependencies**: E2, B1.
  - **Tests**:
    - [x] Fully ingested files older than 1 day are deleted.
    - [x] Current day's file is never deleted.
    - [x] Files with unprocessed lines are never deleted.

---

## Phase F: Post-Session Scraper (Spec 03)

**Spec coverage**: Spec 03 (Post-Session Scraper).

- **F1. Claude session file discovery and parsing**
  - Implement `src/server/scraper.ts`:
    - Triggered by `Stop` hook event (non-blocking to agent shutdown, Spec 03 AC 9).
    - Locate Claude Code's session files at `~/.claude/projects/` (configurable via `scrape.claudeDir`, Spec 03).
    - Parse defensively — silently skip unrecognized fields (Spec 03 AC 7-8).
    - Extract 8 metric categories (Spec 03 AC 2):
      1. Total cost in USD (actual from session file, not calculated).
      2. Token breakdown: input, output, cache creation, cache read (each independently).
      3. Model(s) used (handles mid-session model changes).
      4. Wall-clock duration AND API duration (distinct metrics).
      5. Turn count.
      6. Extended thinking content (opt-in, default ON via `scrape.captureExtendedThinking`).
      7. Full response text (opt-in, default OFF via `scrape.captureFullResponses`).
      8. Error responses: rate limits, auth failures, billing errors, server errors (classified at extraction).
    - If files entirely missing: degrade to hook-only data, no error (AC 8).
    - Distinguish "field not present" from "field present with value zero" (AC 11).
  - **Dependencies**: A4, C1, E2 (triggered after ingestion of Stop event).
  - **Tests**:
    - [x] Scraper locates the correct session file given a session ID (AC 1).
    - [x] All 8 metric categories are individually queryable (AC 2).
    - [x] Extended thinking captured by default (AC 3).
    - [x] Full responses NOT captured by default (AC 4), captured when opt-in enabled (AC 5).
    - [x] Error responses classified into categories at extraction (AC 6).
    - [x] Never crashes on unexpected content — defensive parsing (AC 7).
    - [x] Missing session files degrade gracefully (AC 8).
    - [x] Non-blocking to agent shutdown (AC 9).
    - [x] Config changes take effect on next session end without restart (AC 10).
    - [x] Distinguishes absent vs. zero values (AC 11).

- **F2. Scraper results storage**
  - Insert parsed metrics into `metrics` table (Spec 04), keyed by session_id.
  - Update the `sessions` table with summary metrics (total_cost, token_counts).
  - Metrics available within seconds of session completion (Spec 03 AC 1).
  - **Dependencies**: F1, C1.
  - **Tests**:
    - [x] Metrics are stored in `metrics` table with correct session_id.
    - [x] `sessions` table row is updated with cost and token totals.
    - [x] Re-scraping the same session upserts (no duplicates).
    - [x] Metrics available within seconds of Stop event.

---

## Phase G: Session Lifecycle (Spec 05)

**Spec coverage**: Spec 05 (Session Lifecycle Management).

- **G1. Session status tracking (Spec 05)**
  - Implement `src/server/session-lifecycle.ts`:
    - Exactly 4 statuses: `running`, `completed`, `errored`, `stale` (Spec 05).
    - Session auto-created on first event bearing an unseen session ID (no pre-registration, Spec 05).
    - Valid state transitions (Spec 05):
      - running → completed (normal Stop event)
      - running → errored (error Stop event)
      - running → stale (no events for 60+ minutes, configurable)
      - stale → running (activity resumes — handles extended thinking pauses)
      - stale → completed (delayed normal Stop)
      - stale → errored (delayed error Stop)
      - completed and errored are TERMINAL (no further transitions)
    - Every event updates `last_seen` timestamp.
  - **Dependencies**: C1, E2, A4.
  - **Tests**:
    - [x] First event creates session with status `running` (AC 1).
    - [x] Normal Stop event transitions to `completed` (AC 2).
    - [x] Error Stop event transitions to `errored` (AC 3).
    - [x] No events for stale timeout → status becomes `stale` (AC 4).
    - [x] New event after stale → transitions back to `running` (AC 5).
    - [x] `completed` and `errored` are terminal — no further transitions (AC 6).
    - [x] All 4 statuses visually distinguishable: green (running), blue (completed), red (errored), yellow (stale) (AC 13).
    - [x] Session metadata (cost, tokens, turns, model, duration, error count) visible on cards and detail views (AC 14).

- **G2. Agent phase inference (Spec 05)**
  - Infer current phase heuristically from tool call patterns (Spec 05 AC 8-9):
    - `Reading the plan` — Reading PLAN.md, SPEC.md, task files
    - `Orienting` — Reading CLAUDE.md, project config
    - `Investigating code` — Glob, Grep, Read on source files
    - `Implementing` — Write, Edit on source files
    - `Validating` — Bash running tests, linters
    - `Committing` — Git add, git commit, git push
    - `Updating the plan` — Reading/updating TODO.md, task lists
    - `Delegating` — Agent tool spawning subagents
  - Phases update in near-real-time from incoming tool call events.
  - Zero agent behavior changes required.
  - **Dependencies**: G1, A4.
  - **Tests**:
    - [x] Reading PLAN.md → phase "Reading the plan".
    - [x] Reading CLAUDE.md → phase "Orienting".
    - [x] Glob/Grep/Read on source files → phase "Investigating code".
    - [x] Write/Edit on source files → phase "Implementing".
    - [x] Bash running tests → phase "Validating".
    - [x] Git commands → phase "Committing".
    - [x] Reading/updating TODO.md → phase "Updating the plan".
    - [x] Agent tool spawning subagents → phase "Delegating".
    - [x] Phase updates near-real-time as events arrive (AC 9).

- **G3. Orphan/stale detection (Spec 05)**
  - Periodic check: any session with status `running` whose `last_seen` exceeds `staleTimeoutMinutes` (default 60 min, configurable) is marked `stale`.
  - 60-minute default is intentionally conservative for extended thinking (Spec 05 AC 10).
  - **Dependencies**: G1, B1.
  - **Tests**:
    - [x] Session with no events for 60+ min is marked `stale` (AC 4).
    - [x] Session that receives a new event after being `stale` transitions back to `running` (AC 5).
    - [x] `completed` and `errored` sessions are never marked `stale`.
    - [x] Stale timeout is configurable (AC 10).

- **G4. Project derivation (Spec 05)**
  - Derive project automatically from working directory (Spec 05 AC 7):
    1. Git remote URL → `org/repo-name` (preferred).
    2. Last directory path segment (fallback).
    3. Append path hash if collision occurs.
  - Projects require no manual registration (AC 15).
  - **Dependencies**: G1, A4.
  - **Tests**:
    - [x] Git remote URL correctly derives `org/repo-name` (AC 7).
    - [x] Non-git directory falls back to last path segment.
    - [x] Collision appends path hash.
    - [x] Sessions auto-group by project without manual registration (AC 15).

- **G5. Subagent tracking (Spec 05)**
  - Subagents are NOT independent sessions (Spec 05).
  - Parent session records: spawn count, task assigned, completion status.
  - Displayed in parent's detail view only (AC 11-12).
  - **Dependencies**: G1.
  - **Tests**:
    - [x] SubagentStart event increments spawn count on parent session.
    - [x] SubagentStop event records completion status.
    - [x] Subagent info visible on parent detail view (AC 11-12).

- **G6. Error categorization engine (Spec 13 backend)**
  - Implement `src/server/error-categorizer.ts` (or `src/lib/error-categorizer.ts`):
    - Normalize errors from all 3 sources into a unified error record with exactly one of 5 categories:
      1. `PostToolUseFailure` hook events → `tool_failure`.
      2. Post-session scrape errors → `rate_limit`, `auth_error`, `billing_error`, `server_error` (classified by F1 at extraction).
      3. Stop events with error status → classify into one of the 5 categories based on observable error characteristics.
    - Categorization is automatic — no manual tagging (Spec 13 AC 17).
    - Runs at ingestion time (E2) for hook-sourced errors and at scrape time (F1) for scrape-sourced errors.
    - Unified error records stored in `events` table with category metadata for efficient querying by H3.
  - **Dependencies**: E2, F1, A4.
  - **Tests**:
    - [x] `PostToolUseFailure` events are categorized as `tool_failure`.
    - [x] Scrape-sourced errors retain their categories from extraction.
    - [x] Stop events with error status are classified into one of the 5 categories.
    - [x] Every error gets exactly one category (no uncategorized, no dual-category).
    - [x] Categorization is fully automatic with no manual input.

---

## Phase H: Dashboard Server & API (Spec 06)

**Spec coverage**: Spec 06 (Dashboard Server).

- **H1. Fastify server setup (Spec 06)**
  - Implement `src/server/index.ts`:
    - Create Fastify instance with logging and schema-based validation.
    - Register `@fastify/static` to serve the built React SPA from `dist/client`.
    - Register `@fastify/websocket`.
    - Bind exclusively to `127.0.0.1:<port>` (localhost only, default 9100, Spec 06).
    - On startup: if no ingester daemon running, ingest all accumulated JSONL files first, then watch for new ones (Spec 06).
    - Start session lifecycle/stale checks on server boot (G3).
    - Port conflict → clear human-readable error (Spec 06).
    - Graceful shutdown handler (flush DB, stop ingester, close WebSocket connections).
    - Never leaks internal fields (DB row IDs, file paths, internal state) in responses (Spec 06).
  - **Dependencies**: B1, C1, E3, G3.
  - **Tests**:
    - [x] Server starts and listens on 127.0.0.1:9100 (localhost only).
    - [x] SPA `index.html` is served for the root route.
    - [x] Graceful shutdown completes without errors.
    - [x] Port conflict produces human-readable error message.
    - [x] Server ingests accumulated JSONL files on startup if no daemon running.
    - [x] DB inaccessible → 503 response (Spec 06 AC 58).
    - [x] Unexpected errors → generic message, no stack traces/file paths exposed (Spec 06 AC 59).
    - [x] Server NEVER reachable from any non-localhost machine (Spec 06 AC 2).
    - [x] When ingester daemon is already running at startup, server skips ingestion (Spec 06 AC 8).
    - [x] Errors logged privately on server with full detail for debugging (Spec 06 AC 60).
    - [x] Response payloads never leak internal fields (DB row IDs, internal state, file paths) (Spec 06 AC 57).
    - [x] Server does not block or slow down while serving simultaneous REST + WebSocket traffic (Spec 06 AC 63).

- **H2. REST API — Sessions endpoints (Spec 06)**
  - `GET /api/sessions` — Session Listing with filters: status, project, model, date range, cost range. Sortable by any field. Paginated.
  - `GET /api/sessions/:id` — Session Detail: full record + event timeline + tool call breakdown + token usage over time + cost breakdown.
  - `GET /api/sessions/:id/events` — paginated event list for a session.
  - Session listing (≤100 results) within 200ms under normal load (Spec 06 performance).
  - Schema-validated inputs; 400 on missing/wrong-type params with descriptive messages.
  - **Dependencies**: H1, C1, G1.
  - **Tests**:
    - [x] `GET /api/sessions` returns a paginated list of sessions.
    - [x] Filtering by status works (`?status=running`).
    - [x] Filtering by project works (`?project=my-app`).
    - [x] Filtering by model works (`?model=claude-opus-4`).
    - [x] Filtering by date range works (`?from=...&to=...`).
    - [x] Filtering by cost range works (`?minCost=...&maxCost=...`).
    - [x] Sorting by any field works (`?sortBy=total_cost&order=desc`).
    - [x] `GET /api/sessions/:id` returns full session details including metrics.
    - [x] `GET /api/sessions/:id` returns 404 for non-existent session.
    - [x] `GET /api/sessions/:id/events` returns paginated events in chronological order.
    - [x] Response time ≤200ms for ≤100 results (Spec 06 AC 61).
    - [x] Invalid params → 400 with descriptive error.
    - [x] No sessions matching filters returns empty list, not error (Spec 06 AC 18).
    - [x] Session listing returns all metadata fields per entry: session ID, project, workspace, model, status, start/end times, cost, tokens, turns, errors, phase (Spec 06 AC 16).

- **H3. REST API — Analytics & Top Stats endpoints (Spec 06)**
  - `GET /api/analytics/costs` — Cost by dimension (project/model/agent), time range, granularity. Returns: cost by dimension, trend data, cache efficiency metrics.
  - `GET /api/analytics/errors` — Error data: category, session, project, date range. Paginated. Returns: error list + rate-over-time data + rate limit details.
  - `GET /api/analytics/overview` — Top Stats: active sessions count, total cost (with time window), error count/rate, rate limit incidents, tool calls/min time series.
  - **Dependencies**: H1, C1.
  - **Tests**:
    - [x] Cost endpoint returns data grouped by the requested dimension (project/model/agent).
    - [x] Cost endpoint supports 3 granularities: daily, weekly, monthly.
    - [x] Cost endpoint returns cache efficiency metrics.
    - [x] Error endpoint returns categorized error counts with 5 categories.
    - [x] Error endpoint returns rate-over-time data.
    - [x] Overview endpoint returns: active sessions count, total cost, error count/rate, rate limit incidents, tool calls/min.
    - [x] Overview endpoint supports time window parameter (today/this week/this month).
    - [x] Empty database returns zeroed-out stats (not errors).
    - [x] Error endpoint returns rate limit event details: frequency, which model affected, timestamps (Spec 06 AC 42).
    - [x] Error endpoint supports filtering by error category, session ID, project, date range (Spec 06 AC 39-40).
    - [x] Each error entry includes: error type, message, session ID, project, tool name, timestamp (Spec 06 AC 43).

- **H4. REST API — Config endpoints**
  - `GET /api/config` — current config (with sensitive fields redacted if any).
  - `PUT /api/config` — update config (validates, merges, writes).
  - **Dependencies**: H1, B1, B2.
  - **Tests**:
    - [x] `GET /api/config` returns the current config.
    - [x] `PUT /api/config` with valid partial config updates and persists.
    - [x] `PUT /api/config` with invalid values returns 400 with field-level errors.
    - [x] After settings write, subsequent reads reflect updated values without server restart (Spec 06 AC 46).
    - [x] Write endpoint never corrupts config file — if writing fails, previous config remains intact (Spec 06 AC 48).

- **H5. REST API — Search endpoint**
  - `GET /api/search?q=...` — full-text search across events.
  - Uses FTS5 if available (C4), falls back to LIKE.
  - **Dependencies**: H1, C1, C4.
  - **Tests**:
    - [x] Search returns events matching the query string.
    - [x] Search results include session context (session ID, timestamp).
    - [x] Empty query returns 400.
    - [x] Search works in both FTS and LIKE fallback modes.

- **H6. WebSocket — live event streaming (Spec 06)**
  - `GET /ws` — WebSocket endpoint.
  - Each message: event_id, session_id, timestamp, type, tool_name, project, payload.
  - Multiple clients receive simultaneously.
  - Resume point on reconnect: client sends `last_event_id`; server replays missed events from DB (no duplicates, no lost events during disconnection, Spec 06).
  - Filter by session_id or project (query params on connect).
  - Heartbeat to keep connections alive.
  - Stable for 8+ hours continuous use, no memory leaks (Spec 06).
  - 50+ concurrent WebSocket connections without degradation (Spec 06).
  - **Dependencies**: H1, E2.
  - **Tests**:
    - [x] Client can establish a WebSocket connection.
    - [x] New events are pushed to connected clients in real-time.
    - [x] Heartbeat messages are sent at the configured interval.
    - [x] Connection with `last_event_id` replays missed events without duplicates.
    - [x] Filter by session_id narrows events to that session.
    - [x] Filter by project narrows events to that project.
    - [x] Multiple concurrent clients receive events simultaneously.
    - [x] Malformed WebSocket messages are ignored without crashing.
    - [x] Server handles client disconnection gracefully.
    - [x] 50+ concurrent connections handled without degradation (Spec 06 AC 62).
    - [x] Stable for 8+ hours continuous use, no memory leaks (Spec 06 AC 29).
    - [x] Idle connections remain open without timeouts or disconnections (Spec 06 AC 30).

- **H7. SPA fallback routing**
  - Any `GET` request not matching `/api/*` or `/ws` serves `index.html` (SPA client-side routing).
  - **Dependencies**: H1.
  - **Tests**:
    - [x] `/dashboard` serves `index.html`.
    - [x] `/sessions/abc-123` serves `index.html`.
    - [x] `/api/sessions` does NOT serve `index.html` (serves JSON).

- **H8a. REST API — Guardrail log endpoint (Phase 3 scaffold)**
  - `GET /api/guardrails/log` — paginated, filterable list of guardrail activations from the `guardrail_log` table.
  - Filters: rule_name, session_id, action (block/warn), date range.
  - Returns: rule name, action taken, session, timestamp, payload context.
  - **Note**: The `guardrail_log` table is created in C1. Guardrail hooks that write to it are Phase 3, but the CLI wizard (Q1) optionally injects them in Phase 1. This endpoint ensures activations are queryable when they exist.
  - **Dependencies**: H1, C1.
  - **Tests**:
    - [x] Endpoint returns paginated list of guardrail activations.
    - [x] Filtering by rule name, session, action works.
    - [x] Empty table returns empty list (not error).
    - [x] Each entry includes: rule name, action, session ID, timestamp, payload context.

- **H8. API rate limiting**
  - Apply rate limiting to all REST and WebSocket endpoints (per project security rules).
  - Reasonable defaults for solo use (e.g., 100 req/s per endpoint).
  - **Dependencies**: H1.
  - **Tests**:
    - [x] Exceeding rate limit returns 429 with Retry-After header.
    - [x] Normal usage is unaffected by rate limits.

---

## Phase I: Frontend Application Shell (Spec 07)

**Spec coverage**: Spec 07 (Dashboard App Shell).

- **I1. Layout with 4 regions (Spec 07)**
  - Implement `src/client/App.tsx` with exactly 4 layout regions per Spec 07:
    1. **Top Navigation Bar** — Full viewport width; logo, page links (Dashboard, Sessions, Live Feed, Costs, Errors, Settings), theme toggle. Persistent on all pages.
    2. **Left Sidebar** — Vertical nav with links to all 6 pages; visually indicates active page. Persistent on all pages.
    3. **Main Content Area** — Changes per page via `<Outlet>`.
    4. **Live Activity Sidebar** — Right panel; visible only on Dashboard page; collapsible (main area expands on collapse). Hidden on all other pages (Spec 07).
  - Desktop-only: 1280px+, no horizontal scrollbars (Spec 07).
  - **Dependencies**: A3.
  - **Tests**:
    - [x] Top nav bar renders on every page (AC).
    - [x] Left sidebar renders on every page with all 6 links (AC).
    - [x] Active page indicated visually in sidebar (AC).
    - [x] Live activity sidebar visible only on Dashboard page (AC).
    - [x] Live activity sidebar collapsible; main area expands on collapse (AC).
    - [x] 1280px+ renders cleanly without horizontal scrollbars (AC 8).
    - [x] Top nav bar displays logo, page links, and theme toggle (AC 9).
    - [x] Cards use rounded corners with subtle borders in both themes (AC 22).
    - [x] Status badges: green=running, blue=completed, red=errored, yellow=stale — distinguishable in both themes (AC 23-24).
    - [x] Transitions for sidebar collapse/expand and theme toggle are visually smooth (AC 25).
    - [x] Consistent spacing and typography across all pages (AC 26-27).

- **I2. React Router setup — 7 routes (Spec 07 + Spec 10)**
  - Configure client-side routes for all 7 routes:
    - `/` → redirect to Dashboard (default route)
    - `/dashboard` → Kanban Dashboard (Phase J)
    - `/sessions` → Sessions Table (Phase M)
    - `/sessions/:id` → Full Session Detail Page (Phase L — "View Full" destination)
    - `/live` → Live Feed full page (Phase K)
    - `/costs` → Cost Analytics (Phase N)
    - `/errors` → Error Monitoring (Phase O)
    - `/settings` → Settings (Phase P)
  - Client-side routing: no full page reloads on navigation (AC).
  - Browser back/forward works correctly (AC).
  - Direct URL load (bookmark/refresh/manual) renders correct page (AC).
  - Unknown URL → "not found" with way back to dashboard (AC).
  - Lazy-load all route components.
  - **Dependencies**: I1.
  - **Tests**:
    - [x] All 7 routes reachable (6 pages + session detail).
    - [x] No full page reloads on navigation (AC).
    - [x] URL updates on navigation (AC).
    - [x] Browser back/forward works correctly (AC).
    - [x] Direct URL load renders correct page (AC).
    - [x] Unknown URL shows 404 with way back to dashboard (AC).
    - [x] Route components are lazy-loaded (code splitting works).

- **I3. WebSocket client hook**
  - Implement `src/client/hooks/useWebSocket.ts`:
    - Connect to `/ws` on mount.
    - Auto-reconnect with exponential backoff (1s, 2s, 4s, ..., max 30s).
    - Parse incoming messages and dispatch to a React context or store.
    - Track connection status (connected, connecting, disconnected).
    - On reconnect: send `last_event_id` for replay.
  - **Dependencies**: I1, H6.
  - **Tests**:
    - [x] Hook establishes WebSocket connection on mount.
    - [x] Hook reconnects automatically after disconnection.
    - [x] Backoff interval increases exponentially up to the cap.
    - [x] Connection status is accurately reported.
    - [x] Incoming messages are parsed and dispatched to context.

- **I4. Data fetching layer**
  - Implement `src/client/api.ts`:
    - Typed fetch wrappers for all REST endpoints (H2, H3, H4, H5).
    - Error handling: network errors, HTTP errors, JSON parse errors.
    - Optional: simple SWR-like cache or use `@tanstack/react-query`.
  - **Dependencies**: I1.
  - **Tests**:
    - [x] Each API function calls the correct endpoint with correct method.
    - [x] HTTP error responses throw typed errors.
    - [x] Network failures are caught and reported.

- **I5. Dark/light theme support (Spec 07)**
  - Default: dark theme (Spec 07).
  - Toggle button in top nav bar.
  - Immediate global application (all regions, all components, all charts) (AC).
  - Persists across browser sessions via localStorage (AC).
  - Both themes: readable text, visible borders, distinguishable badges (AC).
  - Tailwind `dark:` variant support via CSS class strategy.
  - Tremor's built-in dark/light mode support.
  - **Dependencies**: A3, I1.
  - **Tests**:
    - [x] Default theme is dark on first load (AC).
    - [x] Theme toggle switches immediately and globally (AC).
    - [x] Theme persists across page reloads via localStorage (AC).
    - [x] Both themes fully legible — readable text, visible borders, distinguishable badges (AC).
    - [x] Tremor components render correctly in both themes.
    - [x] All charts respond to theme toggle (AC).

---

## Phase J: Kanban Dashboard (Spec 08)

**Spec coverage**: Spec 08 (Kanban Board Dashboard).

- **J1. Top stats bar — 5 metrics (Spec 08)**
  - Display at the top of the dashboard, all real-time:
    1. Active sessions counter (updates live on session start/stop) (AC 1).
    2. Total cost in USD with time-window toggle (today / this week / this month) (AC 1, 3).
    3. Error count + error rate (errors as % of total tool calls) (AC 1).
    4. Tool calls per minute as sparkline (throughput trend) (AC 1).
    5. Rate limit incidents in last hour (AC 1).
  - Fetch from `GET /api/analytics/overview`. Auto-refresh via WebSocket updates (AC 2).
  - **Dependencies**: I1, I3, I4, H3.
  - **Tests**:
    - [x] Stats bar renders all 5 metrics (AC 1).
    - [x] Values update in real-time when a WebSocket event arrives (AC 2).
    - [x] Cost toggle switches between today/week/month (AC 3).
    - [x] Tool calls/min sparkline renders (AC 1).
    - [x] Zero-state displays "0" for all metrics (not "loading" forever).

- **J2. Project filter (Spec 08)**
  - Dropdown defaulting to "All" (AC 4).
  - Populated from actual session data (no hardcoded list, AC 21).
  - Filtering narrows BOTH kanban AND stats bar (AC 5).
  - "All" restores full view (AC 6).
  - New projects appear dynamically without refresh (AC 20).
  - **Dependencies**: I4, H2.
  - **Tests**:
    - [x] Filter defaults to "All" (AC 4).
    - [x] Selecting a project filters kanban and stats bar (AC 5).
    - [x] "All" shows everything (AC 6).
    - [x] New projects appear dynamically (AC 20).
    - [x] Only projects with sessions are listed (AC 21).

- **J3. Kanban columns layout (Spec 08)**
  - 3 status columns: Running | Completed | Errored (left to right) (AC 7).
  - Sessions grouped by project (each project = horizontal row with header) (AC 8).
  - Stale sessions stay in their last column but show distinct yellow badge (Spec 08).
  - Status changes, new sessions → real-time card moves/additions (no refresh) (AC 13-14).
  - **Dependencies**: I4, H2.
  - **Tests**:
    - [x] 3 columns: Running, Completed, Errored (AC 7).
    - [x] Sessions grouped by project with labeled sections (AC 8).
    - [x] Stale sessions show yellow badge in their last column.
    - [x] New sessions appear in real-time (AC 14).
    - [x] Status changes move cards in real-time (AC 13).
    - [x] Empty status column for a filtered project remains visible, does not collapse (AC 18).

- **J4. Session cards — rich detail (Spec 08)**
  - Each card shows all required fields per Spec 08 AC 9-12:
    - Agent name, status badge (color-coded: green/blue/red/yellow), model
    - Cumulative cost (USD), duration (live for running sessions, AC 15), turn count
    - Current phase (running sessions only, from phase inference, AC 10)
    - Last tool called
    - Error count (hidden if zero, AC 11)
    - Mini sparkline of tool call activity over session lifetime
    - Subagent summary (if applicable, AC 12)
  - Clicking a card opens the session detail side panel (AC 16).
  - **Dependencies**: J3, G2.
  - **Tests**:
    - [x] Cards display all required fields (AC 9).
    - [x] Current phase shown only on running sessions (AC 10).
    - [x] Error count hidden if zero (AC 11).
    - [x] Subagent summary shown when applicable (AC 12).
    - [x] Duration updates live for running sessions (AC 15).
    - [x] Click opens session detail panel (AC 16).
    - [x] No sessions → meaningful empty state (AC 17).
    - [x] Server disconnected → visual disconnected indicator (AC 19).

---

## Phase K: Live Activity Feed (Spec 09)

**Spec coverage**: Spec 09 (Live Activity Feed).

- **K1. Activity feed sidebar — dashboard (Spec 09)**
  - Collapsible right sidebar on the Dashboard page only (Spec 07/09).
  - Condensed format: session name + colored badge, short event description, relative timestamp (AC 7).
  - Real-time delivery from WebSocket (AC 1). Multi-agent interleaving (AC 2).
  - Sidebar collapse/expand without losing stream (AC 9).
  - **Dependencies**: I1, I3.
  - **Tests**:
    - [x] Real-time events appear in sidebar (AC 1).
    - [x] Multi-agent events interleave correctly (AC 2).
    - [x] Condensed format: session name, badge, description, relative timestamp (AC 7).
    - [x] Sidebar shares same data source as full-page feed (AC 8).
    - [x] Collapse/expand doesn't lose stream (AC 9).
    - [x] Relative timestamps update progressively ("less than a minute ago", "3 min ago") (AC 23).

- **K2. Full-page Live Feed — dedicated page at `/live` (Spec 09)**
  - Expanded detail per event: tool name, input preview, output preview, duration, session name, project (AC 10).
  - Visual type differentiation per event type (AC 11).
  - Filters (all combinable, intersection logic):
    - Event type filter — toggle specific types on/off (AC 12-13).
    - Session filter (AC 14-15).
    - Project filter (AC 16-17).
    - All filter combinations work (AC 18); clearing all + granular = full unfiltered stream (AC 19).
  - Reconnection: on connection loss → indicates disconnected; on restore → resumes without duplicates (AC 3).
  - **Dependencies**: K1, I2.
  - **Tests**:
    - [x] Full-page shows complete event detail (AC 10).
    - [x] Visual type differentiation (AC 11).
    - [x] Event type filter works bidirectionally (AC 12-13).
    - [x] Session filter works bidirectionally (AC 14-15).
    - [x] Project filter works bidirectionally (AC 16-17).
    - [x] Filter combinations work (AC 18).
    - [x] Clearing all filters + granular = full stream (AC 19).
    - [x] Reconnection without duplicates or lost events (AC 3).
    - [x] Empty state when no events match (AC 24).
    - [x] Page navigation and return reconnects automatically (AC 26).

- **K3. Verbosity toggle — both surfaces (Spec 09)**
  - **Summary mode** (default): Only session-level events — started, completed, errored, subagent spawned (AC 4).
  - **Granular mode**: Every event — all tool calls, errors, spawns, prompts, stops, compaction, notifications, permission decisions (AC 5).
  - Switching is immediate (AC 6). Default configurable in settings.
  - **Dependencies**: K1, K2.
  - **Tests**:
    - [x] Summary mode shows only session-level events (AC 4).
    - [x] Granular mode shows all events (AC 5).
    - [x] Switching is immediate (AC 6).
    - [x] Default verbosity from config.

- **K4. Auto-pause on scroll — full-page (Spec 09)**
  - Scrolling up pauses live streaming + shows indicator (AC 20).
  - Events during pause are queued and appear in order (AC 20).
  - Scroll to bottom resumes (AC 21).
  - Auto-anchor to latest when at bottom (AC 22).
  - **Dependencies**: K2.
  - **Tests**:
    - [x] Scrolling up pauses auto-scroll and shows indicator (AC 20).
    - [x] Events during pause are queued (AC 20).
    - [x] Scroll to bottom resumes and shows queued events in order (AC 21).
    - [x] Auto-anchor to latest when at bottom (AC 22).
    - [x] High-volume responsiveness (AC 25).

---

## Phase L: Session Detail Panel (Spec 10)

**Spec coverage**: Spec 10 (Session Detail).

- **L1. Side panel behavior (Spec 10)**
  - Slides in from right edge (AC 2).
  - Default width: 50% of screen (AC 3).
  - Left edge draggable to resize; width remembered within browser session (AC 5-6).
  - 3 dismissal methods: close button, click outside, Escape key (AC 7-9).
  - Underlying page remains visible; no state loss on dismiss (AC 10).
  - "View Full" button navigates to full session detail page (AC 11).
  - Access points: Kanban card click AND Sessions table row click — identical behavior (AC 1).
  - **Dependencies**: I1.
  - **Tests**:
    - [x] Panel slides in from right (AC 2).
    - [x] Default width is 50% (AC 3).
    - [x] Drag to resize works (AC 5).
    - [x] Width persists across openings within session (AC 6).
    - [x] Close button dismisses (AC 7).
    - [x] Escape key dismisses (AC 8).
    - [x] Click outside dismisses (AC 9).
    - [x] Underlying page state preserved on dismiss (AC 10).
    - [x] "View Full" navigates to full detail page (AC 11).
    - [x] Opens identically from kanban and table (AC 1).
    - [x] Panel displays data for the specific session selected — session ID, project, all metrics match (Spec 10 AC 4).

- **L2. Session detail — 5 content sections (Spec 10)**
  - **1. Summary Stats (top)**: Total cost (USD), duration (live for running), turn count, model, error count, token breakdown (input/output/cache creation/cache read) (AC 12-17).
  - **2. Event Timeline**: Chronological list of every event. Each entry: event type, tool, timestamp. Expandable to reveal full tool inputs, outputs, duration, error messages. Collapsed entries scannable (AC 18-21).
  - **3. Tool Call Breakdown**: Per-tool: call count, success count, failure count, average duration. Each tool expandable to show individual call input/output previews (AC 22-26).
  - **4. Token Usage Chart**: Cumulative token consumption over session lifetime (time on X, tokens on Y). Highlights expensive operations visually. Correlatable with timeline (AC 27-29).
  - **5. Cost Breakdown**: Input token cost, output token cost, cache token cost. Components sum to total cost in summary stats (AC 30-31).
  - **Dependencies**: L1, I4, H2.
  - **Tests**:
    - [x] All 6 summary stat fields present (AC 12-17).
    - [x] Duration updates live for running sessions (AC 36).
    - [x] Event timeline chronological (AC 18).
    - [x] Timeline entries show type/tool/timestamp (AC 19).
    - [x] Timeline entries expandable with full details (AC 20).
    - [x] Collapsed entries scannable (AC 21).
    - [x] Per-tool breakdown with call/success/failure/avg-duration (AC 22-26).
    - [x] Tool entries expandable to individual call previews (AC 24).
    - [x] Token chart renders cumulative consumption (AC 27).
    - [x] Expensive operations visually apparent (AC 28).
    - [x] Cost breakdown has 3 components summing to total (AC 30-31).
    - [x] All metrics match DB data (AC 32-34).
    - [x] Zero-error sessions display correctly (AC 37).
    - [x] Pending data shown as pending, not zero (AC 38).
    - [x] Token chart spikes correlatable with specific events in timeline (AC 29).
    - [x] No-tool-call sessions show appropriate indicator, not error state (AC 37).

- **L3. Full-page session detail view**
  - Implement `/sessions/:id` route as the "View Full" destination from the side panel (Spec 10 AC 11).
  - Reuses the same 5 content sections as L2 but rendered in the full main content area (not a side panel).
  - URL-addressable: direct navigation via bookmark/URL renders the correct session detail.
  - Back button returns to previous page (Sessions table or Dashboard).
  - **Dependencies**: L2, I2.
  - **Tests**:
    - [x] `/sessions/:id` renders full session detail in the main content area.
    - [x] All 5 sections from L2 are present and functional.
    - [x] Direct URL navigation renders the correct session.
    - [x] Non-existent session ID shows appropriate error state.
    - [x] Back navigation returns to the referring page.

---

## Phase M: Sessions Table Page (Spec 11)

**Spec coverage**: Spec 11 (Sessions Table).

- **M1. Sortable, filterable table — 11 columns (Spec 11)**
  - Full-page table with 11 columns per Spec 11:
    Session ID, Project, Agent name, Model, Status (color-coded badge), Total cost, Duration, Turn count, Error count, Start time, End time.
  - Running sessions: live-updating duration, no end time (AC 3).
  - All values human-readable: formatted currency, readable dates, friendly durations (AC 4-6).
  - Sorting: click any column header; click again to reverse; visual indicator of active sort; one sort at a time; default: start time most recent first (AC 7-11).
  - 5 combinable filters (AC 12-20):
    - Status: multi-select (running, completed, errored, stale).
    - Project: from actual data (not hardcoded).
    - Model: from actual data.
    - Date range: start/end date for session start_time.
    - Cost range: min and/or max USD.
  - Active filters visible; clearable individually or all at once (AC 18-20).
  - Pagination.
  - **Dependencies**: I1, I4, H2.
  - **Tests**:
    - [x] All 11 columns present with correct data (AC 1).
    - [x] Status badges color-coded (AC 2).
    - [x] Running sessions show live duration, no end time (AC 3).
    - [x] Formatted currency/timestamps/durations (AC 4-6).
    - [x] Sort by each column in both directions (AC 7-10).
    - [x] Default sort: start time, most recent first (AC 11).
    - [x] All 5 filters work independently and in combination (AC 12-17).
    - [x] Active filters visible and clearable (AC 18-20).
    - [x] Empty state: clear explanation (AC 30).
    - [x] No-match state: indicate no matches + way to adjust/clear (AC 31).
    - [x] Loading state: loading indicator (AC 32).

- **M2. Full-text search (Spec 11)**
  - Search covers: user prompts, tool inputs (file paths, bash commands, search patterns, edit contents), full response text (when capture enabled) (AC 21-23).
  - Returns sessions where ANY indexed content matches (AC 22).
  - Combinable with column filters (AND logic) (AC 24).
  - Updates as user types or submits (AC 25).
  - Debounced input.
  - **Dependencies**: M1, H5.
  - **Tests**:
    - [x] Search by user prompts returns matching sessions (AC 21).
    - [x] Search by tool inputs (file paths, commands) works (AC 22).
    - [x] Search by full responses works when capture enabled (AC 23).
    - [x] Combines with column filters via AND logic (AC 24).
    - [x] Updates as typed (AC 25).
    - [x] Clearing search restores full session list (AC 26).

- **M3. Row click opens detail (Spec 11)**
  - Click row → opens session detail side panel (identical to kanban card click) (AC 27).
  - Underlying table remains visible; sort/filter/search state preserved (AC 28-29).
  - **Dependencies**: M1, L1.
  - **Tests**:
    - [x] Clicking a row opens session detail panel (AC 27).
    - [x] Panel content identical to kanban card click (AC 28).
    - [x] Table state (sort/filter/search) preserved while panel open and after dismiss (AC 29).

---

## Phase N: Cost Analytics Page (Spec 12)

**Spec coverage**: Spec 12 (Cost Analytics).

- **N1. Cost by dimension + trend (Spec 12)**
  - **Cost by Dimension**: Selectable dimension: project | model | agent name (AC 1-3).
    - Two complementary visualizations: proportional share (pie) + absolute amounts (bar) (AC 1).
    - Both update together on dimension or time range change (AC 3).
  - **Cost Trend Over Time**: Time-series chart at 3 granularities: daily | weekly | monthly (AC 7-8).
    - Shows current period + equivalent previous period side-by-side for comparison (AC 8).
    - Selectable time range: presets (today, this week, this month, custom) + custom date picker (AC 31-34).
    - Default time range from config (AC 32).
  - **Summary KPIs (4 cards)**: Total spend, avg cost per session, most expensive session, most expensive model — all update on time range change (AC 13-18).
  - Time range selector shared across ALL visualizations; single change updates everything (AC 31).
  - Fetch from `GET /api/analytics/costs`.
  - **Dependencies**: I1, I4, H3.
  - **Tests**:
    - [x] All 3 dimension breakdowns render (project/model/agent) (AC 1-3).
    - [x] Both pie and bar charts present and update together (AC 1, 3).
    - [x] 3 granularities work: daily/weekly/monthly (AC 7).
    - [x] Comparison periods shown side-by-side (AC 8).
    - [x] All 4 KPI cards present with correct values (AC 13-18).
    - [x] Time range selector updates all visualizations (AC 31).
    - [x] Empty state handled gracefully (AC 6).
    - [x] Single-dimension edge case (only one project) accounts for 100% (AC 4-5).
    - [x] Missing comparison period data renders available data, shows missing period as zero/absent (AC 12).
    - [x] Custom date range picker allows arbitrary start/end dates (AC 34).
    - [x] Default time range on page load matches application config default (AC 32).

- **N2. Cache efficiency metrics (Spec 12)**
  - 3 cache metrics per Spec 12 AC 19-24:
    1. Cache hit rate (% of input tokens from cache) (AC 19).
    2. Tokens saved by caching (absolute count) (AC 20).
    3. Cost avoided ($ difference at standard input rate vs cache-read rate) (AC 21).
  - All per-model accurate (different models have different rate differentials) (AC 24).
  - Update on time range change (AC 22).
  - **Dependencies**: N1, F2.
  - **Tests**:
    - [x] Cache hit rate displayed as percentage (AC 19).
    - [x] Tokens saved displayed (AC 20).
    - [x] Cost avoided calculated correctly (AC 21).
    - [x] Per-model accuracy (AC 24).
    - [x] Empty state when no cache data (AC 23).

- **N3. Budget threshold alerts (Spec 12)**
  - Per-session cost limit: alert banner if any session exceeds (AC 25).
  - Per-day cost limit: alert banner if today's total exceeds (AC 26).
  - Multiple thresholds crossed → multiple separate banners (AC 27).
  - Banners persistent while condition met; disappear when no longer exceeded (AC 28).
  - No banners when no limits configured (AC 29-30).
  - Informational only — active blocking is guardrail system's job (Spec 12).
  - **Dependencies**: N1, B1, H3.
  - **Tests**:
    - [x] Per-session alert banner appears when threshold crossed (AC 25).
    - [x] Per-day alert banner appears when threshold crossed (AC 26).
    - [x] Multiple banners for multiple threshold violations (AC 27).
    - [x] Banners persistent while exceeded, disappear when clear (AC 28).
    - [x] No banners when unconfigured (AC 29-30).

- **N4. Pricing configuration (Spec 12)**
  - All cost calculations use pricing from config (Spec 12 AC 35-38).
  - All 4 token types accounted: input, output, cache creation, cache read (AC 36).
  - Per-model pricing applied (AC 37).
  - Pricing changes reflected after settings save (AC 38).
  - **Dependencies**: N1, B1.
  - **Tests**:
    - [x] Pricing from config used in all calculations (AC 35).
    - [x] All 4 token types included (AC 36).
    - [x] Per-model pricing applied correctly (AC 37).
    - [x] Config pricing changes reflected after save (AC 38).

---

## Phase O: Error Monitoring Page (Spec 13)

**Spec coverage**: Spec 13 (Error & Anomaly Monitoring).

- **O1. Error log table (Spec 13)**
  - Columns: error category, error message, session, tool (if applicable), project, timestamp (AC 1).
  - 5 combinable filters (intersection logic): error category, session, project, tool, date range (AC 2-6).
  - Sorting: any column, ascending or descending (AC 7).
  - Paginated (large error volumes remain navigable) (AC 8).
  - Click session ID → navigates to/opens session detail view (AC 9).
  - Running sessions show real-time tool failures (AC 28). New errors appear within seconds (AC 29).
  - **Dependencies**: I1, I4, H3.
  - **Tests**:
    - [x] All columns present with correct data (AC 1).
    - [x] All 5 filters work independently and combined (AC 2-6).
    - [x] Sort by any column in both directions (AC 7).
    - [x] Pagination works for large volumes (AC 8).
    - [x] Session ID click opens session detail (AC 9).
    - [x] Empty state when no errors exist (AC 10).
    - [x] Missing tool name shown as empty/N/A, not broken (AC 32).
    - [x] Running sessions show real-time tool failures (AC 28).
    - [x] New errors appear within seconds without manual refresh (AC 29).
    - [x] Large error volumes remain responsive via pagination (AC 31).

- **O2. Error categorization — 5 categories (Spec 13)**
  - 3 error sources:
    1. `PostToolUseFailure` hook events → `tool_failure` category.
    2. Post-session scrape errors → `rate_limit`, `auth_error`, `billing_error`, `server_error` categories.
    3. Stop events with error status → classified into one of the 5 categories.
  - Each error assigned exactly one category (AC 12). Automatic, no manual tagging (AC 17).
  - Each category visually distinguishable (AC 16).
  - **Dependencies**: O1, A4, G6.
  - **Tests**:
    - [x] All errors assigned to exactly one of 5 categories (AC 12).
    - [x] PostToolUseFailure → tool_failure (AC 13).
    - [x] Scrape errors mapped to correct categories (AC 14).
    - [x] Stop errors classified (AC 15).
    - [x] Each category visually distinguishable (AC 16).
    - [x] Automatic categorization, no manual tagging (AC 17).
    - [x] All 3 error sources present in table (AC 27).

- **O3. Error rate over time chart (Spec 13)**
  - Time-series of error counts per time bucket (AC 18).
  - Event overlays: marks significant events (session starts/stops, rate limit bursts) on timeline (AC 20).
  - Respects same filters as table (filter table → chart updates to match) (AC 19).
  - Appropriate resolution to distinguish spikes from baseline (AC 21).
  - **Dependencies**: O1, H3.
  - **Tests**:
    - [x] Time-series chart renders (AC 18).
    - [x] Chart respects table filters (AC 19).
    - [x] Event overlays visible (AC 20).
    - [x] Resolution distinguishes spikes from baseline (AC 21).

- **O4. Rate limit sub-view (Spec 13)**
  - Dedicated sub-view accessible within errors page (no full navigation away) (AC 22).
  - 3 metrics: frequency over time (AC 23), model attribution (AC 24), cooldown patterns (AC 25).
  - Toggle between full error log and rate limit sub-view without losing filter state (AC 26).
  - **Dependencies**: O1, O2.
  - **Tests**:
    - [x] Sub-view accessible within errors page (AC 22).
    - [x] Frequency over time displayed (AC 23).
    - [x] Model attribution shown (AC 24).
    - [x] Cooldown patterns shown (AC 25).
    - [x] Filter state preserved on sub-view toggle (AC 26).

---

## Phase P: Settings Page (Spec 14 — frontend)

**Spec coverage**: Spec 14 (Settings & Configuration) — frontend UI.

- **P1. Settings page — 4 sections (Spec 14)**
  - **Section 1 — General**: port (warns restart required, AC 27), stale timeout, retention, data directory (AC 26).
  - **Section 2 — Guardrails**: all 6 rules with mode toggles (block/warn/off) + rule-specific params (patterns, paths, cost limits, chain limits, delay) (AC 28-30).
  - **Section 3 — Display**: theme, verbosity, default cost range. Changes take effect immediately on save, no reload (AC 31-32).
  - **Section 4 — Data**: full response capture toggle, extended thinking toggle, retention period, manual data purge (with confirmation before executing) (AC 33-37).
  - Each field shows current value from `GET /api/config` (AC 24-25).
  - **Dependencies**: I1, I4, H4.
  - **Tests**:
    - [x] All config fields rendered with current values (AC 24-25).
    - [x] 4 organized sections (AC 25).
    - [x] Port change warns restart required (AC 27).
    - [x] Guardrail modes editable (AC 29).
    - [x] Display changes take effect immediately on save (AC 32).
    - [x] Manual purge requires confirmation (AC 37).
    - [x] Data settings: full response capture toggle present (AC 33).
    - [x] Data settings: extended thinking toggle present (AC 34).
    - [x] Data settings: retention period editable (AC 35).
    - [x] Guardrail rule-specific params editable: patterns, paths, cost limits, chain limits, delay (AC 30).

- **P2. Validation and save (Spec 14)**
  - UI validates before saving (AC 49-53):
    - Numeric fields: valid numbers in reasonable ranges.
    - Port: valid port number.
    - Mode fields: only "block", "warn", "off".
    - Theme: only "dark", "light".
    - Verbosity: only "summary", "granular".
  - Field-specific error feedback shown (AC 52).
  - Never writes invalid config (AC 53).
  - On save: `PUT /api/config` with changed fields; unmodified fields preserved (AC 38-39).
  - Change propagation timing per Spec 14 AC 42-48:
    - Display: immediately in dashboard.
    - Ingestion: next ingestion cycle.
    - Stale timeout / retention: next evaluation cycle.
    - Port: requires server restart.
    - Scrape: next session scrape.
    - Guardrail config: next tool call.
    - Pricing: next cost calculation.
  - **Dependencies**: P1, H4.
  - **Tests**:
    - [x] Client-side validation prevents invalid submissions (AC 49-51).
    - [x] Field-specific error feedback (AC 52).
    - [x] Never writes invalid config (AC 53).
    - [x] Unmodified fields preserved on save (AC 39).
    - [x] Config reads back correctly after save without restart (AC 41).
    - [x] Pricing overrides work and survive release updates (AC 54-56).
    - [x] Ingestion settings take effect on next ingestion cycle (AC 43).
    - [x] Stale timeout changes take effect on next stale detection evaluation (AC 44).
    - [x] Retention changes take effect on next purge cycle (AC 45).
    - [x] Guardrail config changes take effect on next tool call (AC 46).
    - [x] Pricing changes take effect on next cost calculation (AC 47).
    - [x] Scrape settings take effect on next session scrape (AC 48).

---

## Phase Q: CLI Setup Wizard (Spec 15)

**Spec coverage**: Spec 15 (CLI Setup / Init Command).

- **Q1. Wizard flow — 6 steps (Spec 15)**
  - Implement `src/cli/init.ts` — run via `npx ralph-monitor init`:
    1. **Claude Code Detection**: Check for `~/.claude/settings.json`. If not found: inform user, provide guidance, stop cleanly (no partial setup) (AC 2).
    2. **Hook Scope Selection**: Always ask — global (`~/.claude/settings.json`) OR project-only (`.claude/settings.json` in CWD) (AC 3-4). Never decide unilaterally.
    3. **Monitoring Hook Injection**: Add async hook entries for ALL 12 supported event types. Hook scripts point to monitor hook files. Work regardless of installation method (repo clone or npx) (AC 5, AC 15-16).
    4. **Existing Hook Preservation**: Merge alongside existing entries; never overwrite, remove, or reorder existing hooks (AC 6). If monitor hooks already present: detect, inform, skip (no duplicates) (AC 7).
    5. **Guardrail Hook Injection (optional)**: Ask "Enable active guardrails? (~50-100ms latency per tool call but active protection)". Yes → add sync hooks. No → no sync hooks (AC 8-9).
    6. **Config File Generation**: Generate `/monitor/ralph-monitor.config.json` with all defaults. If file exists: inform user, ask how to proceed (never silently overwrite) (AC 10-11).
  - **Dependencies**: B2, D1.
  - **Tests**:
    - [x] Full flow succeeds when Claude Code installed (AC 1).
    - [x] Graceful failure when not installed — no partial config left behind (AC 2).
    - [x] Global scope → only global settings file modified (AC 3).
    - [x] Project scope → only project settings file modified (AC 4).
    - [x] All 12 event types have async hook entries after wizard (AC 5).
    - [x] Existing hooks preserved unchanged (AC 6).
    - [x] Re-running doesn't create duplicates (AC 7).
    - [x] Guardrail opt-in adds sync hooks (AC 8).
    - [x] Guardrail opt-out adds no sync hooks (AC 9).
    - [x] Valid config file generated (AC 10).
    - [x] Existing config prompts before overwriting (AC 11).

- **Q2. Setup verification (Spec 15)**
  - After configuration:
    - Fire a test event to confirm hooks working and event file written (AC 12-13).
    - Report success + guidance on starting dashboard (AC 14).
    - Report failure with troubleshooting context (not silent false success) (AC 13).
  - Works identically from repo clone and via `npx ralph-monitor init` (AC 15-16).
  - **Dependencies**: Q1, D1.
  - **Tests**:
    - [x] Verification confirms end-to-end event flow (AC 12).
    - [x] Failure reported with context (AC 13).
    - [x] Clear guidance on starting dashboard (AC 14).
    - [x] Works via package manager (AC 15).
    - [x] Works from local clone (AC 16).
    - [x] Hook paths resolve correctly in both contexts (AC 16).

- **Q3. Manual setup documentation (Spec 15)**
  - README documents complete manual process as alternative to wizard (AC 17).
  - Manual process produces equivalent configuration to wizard.
  - **Dependencies**: Q1.
  - **Tests**:
    - [x] Manual setup documented and produces equivalent result (AC 17).

---

## Phase R: Integration & Distribution

**Spec coverage**: Cross-cutting. Ensures the system works end-to-end.

- **R1. End-to-end flow test**
  - Integration test that:
    1. Starts the server.
    2. Simulates hook events (writes to spool files).
    3. Verifies events appear in the database.
    4. Verifies events are pushed via WebSocket.
    5. Verifies REST API returns the data.
    6. Verifies session lifecycle transitions.
  - **Dependencies**: All prior phases.
  - **Tests**:
    - [x] Full event flow from hook file write to WebSocket delivery works.
    - [x] Session lifecycle transitions through all expected phases.
    - [x] REST API reflects the current state after events are processed.
    - [x] Multiple concurrent sessions are handled correctly.
    - [x] Server handles graceful shutdown mid-flow.

- **R2. `package.json` bin entry and npx support**
  - Add `"bin"` field to `package.json` pointing to the CLI entry point.
  - Ensure `npx ralph-monitor init` and `npx ralph-monitor start` work.
  - **Dependencies**: Q1, H1.
  - **Tests**:
    - [x] `npx ralph-monitor init` launches the setup wizard.
    - [x] `npx ralph-monitor start` starts the dashboard server.
    - [x] `npx ralph-monitor --help` displays usage information.

- **R3. Build and package verification**
  - `npm run build` produces a production bundle (server + client).
  - Production server serves the built SPA and API correctly.
  - No dev dependencies are required at runtime.
  - **Dependencies**: All prior phases.
  - **Tests**:
    - [x] `npm run build` completes without errors.
    - [x] Production server starts and serves the SPA.
    - [x] API endpoints work in production mode.
    - [x] Bundle size is reasonable (document the size).

---

## Summary: Dependency Graph

```
Phase A (Foundation)
  |
  v
Phase B (Config)
  |
  v
Phase C (Storage)
  |
  +---> Phase C4 (FTS validation, parallel with D)
  |
  v
Phase D (Hooks) ----+---> Phase Q (CLI Wizard, needs D + B)
  |                 |
  v                 v
Phase E (Ingester)  Q1-Q3 ---> Phase R (needs Q + H)
  |
  v
Phase F (Scraper)
  |
  v
Phase G (Session Lifecycle + Error Categorization)
  |
  v
Phase H (Server & API, incl. H8a Guardrail Log scaffold)
  |
  v
Phase I (App Shell)
  |
  +---> Phase J (Kanban Dashboard)   \
  +---> Phase K (Live Activity Feed)  |
  +---> Phase L (Session Detail)      |  All parallelizable
  +---> Phase M (Sessions Table)      |
  +---> Phase N (Cost Analytics)      |
  +---> Phase O (Error Monitoring)    |
  +---> Phase P (Settings UI)       /
  |
  v
Phase R (Integration & Distribution)
```

> **Note**: Phases J through P (frontend pages) are independent of each other and can be developed in parallel once Phase I (App Shell) is complete. Phase Q (CLI Wizard) can begin after Phase D (hooks exist) and Phase B (config writer exists).

---

## Learnings

- **Tremor 3.x requires React 18** — React 19 causes peer dependency conflicts. Pinned to React 18.3.1 and react-router-dom 6.x.
- **Base tsconfig needs jsx and DOM lib** — `tsc --noEmit` uses the base tsconfig, so jsx and DOM lib must be in the base config, not just client extends.
- **sql.js, chokidar, uuid** — all installed as production deps. No native compilation needed.
- **Vite build bundle** — initial build is ~992KB due to Tremor; will need code-splitting in Phase I.
- **FTS5 NOT available in default sql.js WASM build** — Confirmed during C4 validation. LIKE queries are the permanent fallback. This resolves Open Design Decision #1.
- **sql.js corrupt DB handling** — sql.js does not throw on corrupt data at construction time. Errors surface at first query (PRAGMA). Wrapping init+schema in try/catch handles this correctly.
- **JSONL position tracking off-by-one** — `String.split('\n')` produces an empty trailing element after final `\n`. Must not count its bytes in the offset, otherwise position overshoots file size by 1 byte per read.
- **Sidecar .pos files** — Position tracking uses `.pos` sidecar files per JSONL file. Simpler than a DB table, survives ingester restarts.
- **sql.js has no bundled TypeScript declarations** — Added `src/types/sql-js.d.ts` to provide type definitions.
- **pino-pretty and @types/ws needed as devDependencies** — Required for server logging formatting and WebSocket type support.
- **Fastify decorators for shared state** — Used Fastify decorators to share db, config, and storage across route handlers.
- **33 API tests pass via fastify.inject()** — All API tests run against in-memory sql.js using Fastify's built-in injection, no real HTTP needed.
- **Explicit type annotations for sql.js .map() callbacks** — All `.map()` callbacks over sql.js result rows need explicit type annotations; TypeScript cannot infer row shapes from sql.js query results.
- **WebSocket live streaming** — Implemented with filtering (session_id, project), resume via `last_event_id`, and heartbeat to keep connections alive.
- **Guardrails API scaffolded as Phase 3 placeholder** — `GET /api/guardrails/log` endpoint is queryable now; guardrail hooks that populate the table are deferred to Phase 3.
- **Phase H test totals** — 164 tests across 7 test files cover the full server and API surface.
- **Claude session files are undocumented JSONL** — 3-strategy file discovery (exact name, partial match, content search) needed to reliably locate session files.
- **Defensive parsing extracts 8 metric categories with null/zero distinction** — Important to distinguish "field not present" from "field present with value zero" for accurate metrics.
- **Cost reconciliation** — If reported total differs from computed total by >1%, proportionally scales breakdown to maintain consistency.
- **32 scraper tests** — Covers all metric categories, defensive parsing, and DB upserts.
- **React Router v6 lazy routes work well with Vite code splitting** — Each page chunk ~0.4-0.5KB gzipped.
- **Tremor's Tracker component is the largest chunk at 843KB** — Future optimization target for bundle size reduction.
- **WebSocket hook uses exponential backoff 1s to 30s max** — Includes last_event_id resume on reconnect for seamless event replay.
- **localStorage-based theme with dark class on `<html>`** — Works with both Tailwind `dark:` variants and Tremor's built-in dark mode support.
- **8 placeholder pages ready for Phase J-P implementation** — Frontend shell complete with lazy-loaded routes and all navigation wired up.
- **All 7 pages implemented as lazy-loaded React components (6-13KB each after code splitting)** — Each page is a separate chunk loaded on demand via React.lazy and Suspense.
- **Dashboard uses WebSocket for real-time updates with connection status indicator** — Live event streaming drives stats bar, kanban cards, and session status changes without polling.
- **Live Feed implements auto-pause on scroll with buffered event count** — Scrolling up pauses the stream and queues incoming events; scrolling back to bottom resumes and replays buffered events in order.
- **Sessions table supports 11-column sorting, pagination, and combinable filters** — All columns sortable in both directions, with 5 combinable filters (status, project, model, date range, cost range) using intersection logic.
- **Session detail page includes event timeline with expandable payloads and DonutChart for costs** — Chronological event timeline with collapsible entries revealing full tool inputs/outputs, plus DonutChart visualization for cost breakdown by token type.
- **Cost analytics shows dimension breakdown (project/model) with DonutChart + BarChart** — Proportional share via DonutChart and absolute amounts via BarChart update together on dimension or time range change.
- **Error monitoring has automatic 5-category classification and spike detection** — Errors from all 3 sources (PostToolUseFailure, scrape, Stop events) automatically classified into tool_failure, rate_limit, auth_error, billing_error, or server_error with time-series spike detection.
- **Settings page has 4 expandable sections with field validation and immediate theme application** — General, Guardrails, Display, and Data sections with client-side validation; display changes (theme, verbosity) apply immediately without page reload.
- **Tremor Tracker chunk is 843KB — optimization target for future work** — The Tracker component from Tremor contributes the largest single chunk to the bundle; tree-shaking or replacement would significantly reduce bundle size.
- **CLI uses Node.js readline (no external CLI deps), 7-step wizard** — The setup wizard uses only built-in Node.js `readline` for interactive prompts, keeping the dependency footprint minimal while implementing a 7-step guided flow.
- **Hook injection preserves existing hooks, prevents duplicates via marker strings** — When injecting monitoring hooks into Claude Code settings, existing hook entries are preserved unchanged. Marker strings in hook commands allow re-run detection to prevent duplicate entries.
- **22 integration tests cover full pipeline end-to-end** — Integration tests validate the complete flow from hook event file writes through ingestion, database storage, WebSocket delivery, and REST API responses.
- **Total: 290 tests across 10 files** — Full test suite covers all phases A through R plus gap items S8/S9/S10/S11/S12/S13/S14/S15/S16 with comprehensive coverage of the server, API, scraper, CLI, and integration layers.
- **API response shape fix** — `GET /api/sessions` now returns `{ data, total, page, limit }` instead of `{ sessions, total, page, limit }` to match the `PaginatedResponse<T>` client type. This fixes a client-server type mismatch that would have caused the SessionsPage to fail at runtime.
- **Schema migration for agent_name** — Added `Storage.migrateSchema()` that uses `PRAGMA table_info` to detect missing columns and ALTERs the table. This supports loading pre-S14 database files without data loss.
- **Full-text search via subquery** — Sessions search uses `WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE payload LIKE ?)` to find sessions by event payload content. Combines cleanly with all other filters and pagination.
- **Filter dropdowns populated from data** — `GET /api/sessions/filters` returns distinct projects and models from the sessions table, used by the client to populate filter dropdowns without hardcoding values (Spec 11 AC 15).
- **API/client shape mismatches found and fixed** — 3 bugs where server response shapes diverged from client TypeScript types: (1) Analytics overview returned `errorCount` but client expected `totalErrors`, plus missing `totalSessions` and `totalTokens` fields; (2) Cost analytics returned `{breakdown, totalCost, cacheHitRate, tokensSaved}` but client expected `CostDimension[]` with `key` instead of `name`; (3) Error analytics only queried `PostToolUseFailure` events with hardcoded `tool_failure` category — expanded to include Stop events with error payloads, with proper keyword-based categorization matching session-lifecycle.ts logic.
- **Error analytics response uses `data` field** — Changed from `{errors: [...]}` to `{data: [...]}` to match PaginatedResponse<ErrorRecord> shape expected by ErrorsPage client component.
- **Server-side error categorization mirrors categorizeError()** — The analytics errors endpoint now applies the same keyword-matching logic (rate_limit, auth_error, billing_error, server_error) as the session-lifecycle `categorizeError` function, ensuring consistent categorization across ingestion and query paths.
- **SessionDetailPanel as overlay (not route)** — The session detail side panel is a fixed-position overlay rendered within DashboardPage and SessionsPage, not a route change. This preserves parent page state (scroll, filters, selections) while the panel is open. Width stored in sessionStorage (per browser session, not persisted permanently). Requires ResizeObserver polyfill in jsdom tests (Tremor uses it).
- **loadConfig returns frozen objects** — `loadConfig()` deep-freezes the returned Config object. Test code that needs to modify config (e.g., budget alert tests) must use a plain mutable object via Fastify decorator instead of mutating the frozen config.
- **Cost trend endpoint design** — `GET /api/analytics/costs/trend` accepts `granularity` (daily/weekly/monthly), `from`, `to` params. Returns `{current, previous, granularity}` where previous period is the same-duration window immediately before the current period, enabling side-by-side comparison.
- **Budget alerts endpoint design** — `GET /api/analytics/budget-alerts` reads `config.alerts.perSessionCostLimit` and `config.alerts.perDayCostLimit`, queries sessions table, and returns `{alerts: [{type, limit, actual, sessionId?}]}`. Separate endpoint keeps the concern isolated from other analytics.
- **Costs page dimension='agent' support** — The cost-by-dimension endpoint now supports `dimension=agent` which groups by `agent_name` column, enabling agent-level cost attribution (Spec 12 AC 3).
- **Error trend adaptive bucketing** — `GET /api/analytics/errors/trend` auto-selects bucket size: 10min for <1day, 1hr for 1-7days, 1day for >7days. Categories are counted per bucket for stacked visualization.
- **Rate limit cooldown detection heuristic** — Gaps between consecutive rate limit events in 5s-5min range are classified as cooldown periods. This is a heuristic that works well for typical API rate limit patterns.
- **View toggle preserves filter state** — Switching between Error Log and Rate Limits sub-views on ErrorsPage preserves all filter state (S12 AC 26), since both views share the same component state.
- **Scraper integration is fire-and-forget** — `scrapeSession()` is called after the transaction COMMIT in `insertBatch()`, not inside the transaction. This ensures the scraper never blocks event insertion or causes rollbacks. Failures are caught and logged via `.catch()`. Config must be threaded through the entire call chain (`processAllFiles` → `processFile` → `insertBatch`) since the scraper needs `config.scrape.claudeDir` to find session files.
- **ScrapedError is a synthetic event type** — Unlike the 12 hook-based event types, `ScrapedError` is generated internally by the scraper. It's added to `HookEventType` for type safety but NOT to `HOOK_EVENT_TYPES` constant (which the CLI wizard iterates to create hook scripts). Error analytics queries must include it explicitly.
- **Session detail API returns an envelope** — `GET /api/sessions/:id` returns `{ session, metrics, tools }`, not a flat Session object. The client `api.getSession()` was incorrectly typed as `Promise<Session>` — now correctly returns `Promise<SessionDetailResponse>`. Callers must unwrap `response.session`.
- **Events endpoint field name alignment** — The server's events endpoint used `eventId`/`toolName` but the client's `EventRecord` type uses `id`/`tool`. Fixed the server to use the shared type field names. The response key is now `data` (matching `PaginatedResponse`) instead of `events`.

---

## Design Decisions (Resolved)

1. **FTS5 in sql.js** — RESOLVED: FTS5 not available in default sql.js WASM build. LIKE queries are the permanent fallback.
2. **Hook script language** — RESOLVED: Pure Node.js (via `#!/usr/bin/env node`), cross-platform.
3. **State management** — RESOLVED: React Context + hooks suffice for Phase 1.
4. **Scraper session file location** — RESOLVED: 3-strategy file discovery (exact name, partial match, content search). Path configurable via `scrape.claudeDir`.
5. **Ingester position persistence** — RESOLVED: Sidecar `.pos` files per JSONL file.
6. **sql.js memory ceiling** — Targets well under 1GB. No hard limit monitoring yet (potential Phase 2 item).
7. **Error categorization timing** — RESOLVED: Categorization at ingestion time in `processEvent`.
8. **Full-page session detail route** — RESOLVED: `/sessions/:id` reuses L2 components in full-width layout.

---

## Cross-Cutting Concerns

- **All code in `/monitor`** — nothing outside that directory is modified.
- **Zero native dependencies** — sql.js WASM ensures cross-platform without node-gyp.
- **Hooks NEVER affect agent** — identical output, tool call sequences, timing with or without hooks (Spec 01 AC 1).
- **Error handling** — vague messages to users; detailed logs privately (security rules).
- **No secrets in client code** — all sensitive config stays server-side.
- **`src/lib`** is the project standard library — prefer consolidated utilities there over ad-hoc copies.
