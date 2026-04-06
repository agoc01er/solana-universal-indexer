# Universal Solana Indexer

A production-ready Solana indexer that works with any Anchor program. Provide an IDL file, set a program ID, and the indexer handles everything: schema generation, transaction decoding, account state tracking, event parsing, and a REST API — without writing program-specific code.

Supports **PostgreSQL** for production workloads and **SQLite** for lightweight deployments. Includes a **real-time web dashboard** at `/dashboard`.

![Tests](https://img.shields.io/badge/tests-96%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## How it works

```
Solana RPC / WebSocket
  │
  ├── getSignaturesForAddress   ──►  SolanaIndexer
  ├── getParsedTransaction              ├── Batch mode (slot range / signatures)
  ├── getProgramAccounts        ──►  AccountWatcher (bulk + real-time)
  └── onLogs (WebSocket)        ──►  Gap Detector (fills missed txs)
                                        │
                                        ▼
                              Decoder Layer
                              ├── InstructionDecoder  (Anchor discriminator + BorshCoder)
                              ├── AccountDecoder      (BorshAccountsCoder)
                              └── EventDecoder        (emit!() from program logs)
                                        │
                                        ▼
                              Storage (PostgreSQL or SQLite)
                              ├── ix_{program}_{instruction}        — one table per instruction
                              ├── acc_{program}_{account}           — account state snapshots
                              ├── acc_history_{program}_{account}   — account change history
                              ├── {program}_events                  — Anchor events
                              ├── _indexer_state                    — checkpoint / last slot
                              └── _idl_versions                     — IDL upgrade history
                                        │
                                        ▼
                              REST API (Express)
                              ├── /health, /ready, /metrics, /schema
                              ├── /instructions/:name  (cursor pagination)
                              ├── /events
                              ├── /stats/:instruction  (aggregation: COUNT/SUM/AVG/MIN/MAX)
                              ├── /accounts/:type/:pubkey/history
                              └── /stats
```

---

## Features

**Core indexing**
- IDL-driven schema — tables auto-generated from Anchor IDL on startup
- Instruction decoding with Anchor 8-byte discriminator matching and BorshCoder
- Account state snapshots via `getProgramAccounts` + real-time via `onProgramAccountChange`
- Account history — append-only log of every state change per pubkey
- Anchor event decoding — `emit!()` events extracted from transaction logs
- CPI inner instruction tracking with `cpi_depth` and `parent_ix_index`

**Reliability**
- Three indexing modes: `realtime`, `batch`, and `backfill_then_realtime` (cold start)
- Hybrid WebSocket + polling with gap detection — polls every 30s to catch missed transactions
- Exponential backoff with full jitter on all RPC calls
- Atomic writes — data and checkpoint committed in the same transaction
- Graceful shutdown on `SIGINT`/`SIGTERM` with state flush
- Config validation at startup with clear error messages

**API**
- Cursor-based pagination — stable under concurrent inserts, unlike `OFFSET`
- Multi-parameter filtering on any indexed column
- Extended aggregation: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` on numeric fields
- Time-based grouping by hour/day using `block_time`
- Readiness probe (`/ready`) for Kubernetes liveness checks
- Prometheus `/metrics` — transaction throughput, RPC latency, slot lag
- SQL injection protection — column name allowlist + parameterized queries

**Infrastructure**
- IDL Version Manager — detects on-chain IDL upgrades, migrates schema automatically
- PostgreSQL for production, SQLite for lightweight/edge deployments
- Docker Compose with one-command startup (`docker compose up`)
- Structured JSON logging

---

## Project structure

```
src/
├── api/              Express routes and middleware
├── config/           Environment configuration with validation
├── database/         SQLite and PostgreSQL adapters, IDL migrations
├── decoder/          Instruction, account, and event decoders
├── idl/              IDL parsing, discriminator computation, schema SQL generation
├── indexer/          Core indexing engine and account watcher
├── observability/    Structured logger and Prometheus metrics
├── utils/            Retry with exponential backoff and jitter
├── __tests__/        Jest test suites
└── index.ts          Entry point and orchestration
```

---

## Quick start

### Docker (PostgreSQL — recommended for production)

```bash
git clone https://github.com/agoc01er/solana-universal-indexer
cd solana-universal-indexer
cp .env.example .env        # edit PROGRAM_ID and RPC_URL
cp your-program.json idl.json
docker compose up
```

The `idl.json` included in the repo is the **Jupiter v6 aggregator IDL** — `docker compose up` works out of the box with no changes if you just want to try it.

### Docker (SQLite — zero external dependencies)

```bash
# Only starts the SQLite indexer, no PostgreSQL server needed
docker compose --profile sqlite up indexer-sqlite
```

### Local (PostgreSQL)

```bash
npm install
cp .env.example .env        # configure DATABASE_URL
npm run dev
```

### Local (SQLite — fastest way to try it)

```bash
npm install
cp .env.example .env
# Edit .env: set DB_TYPE=sqlite and DB_PATH=./indexer.db
npm run dev
```

**Windows one-click:** double-click `start.bat` — it checks `.env`, installs dependencies, builds, and starts the server automatically.

---

## Dashboard

Once running, open **http://localhost:3000/dashboard** for a live overview:

- **Program stats** — name, instruction type count, last indexed slot, uptime
- **Instructions Schema** — all instruction types from the IDL with account and argument details
- **Indexed Counts** — real-time row counts per instruction type
- **Recent Transactions** — latest indexed transactions with signature, instruction type, slot, and time
- **Health Details** — service status, program ID, indexer running state

The dashboard polls all API endpoints every 10 seconds with no page reload required.

---

## Configuration

```env
# Solana
PROGRAM_ID=your_program_pubkey        # required
RPC_URL=https://api.mainnet-beta.solana.com
WS_URL=                               # optional, derived from RPC_URL

# IDL
IDL_PATH=./idl.json

# Storage: postgres (default) or sqlite
DB_TYPE=postgres
DATABASE_URL=postgresql://user:pass@localhost:5432/indexer

# SQLite (only used when DB_TYPE=sqlite)
DB_PATH=./indexer.db

# API
PORT=3000

# Indexing mode: realtime | batch | backfill_then_realtime
MODE=realtime
POLL_INTERVAL_MS=5000

# Batch / backfill mode
FROM_SLOT=
TO_SLOT=

# Logging
LOG_LEVEL=info
```

The indexer validates configuration at startup and prints specific error messages for missing or invalid values.

---

## API

### Health & readiness

```
GET /health    → 200 (ok) or 503 (degraded)
GET /ready     → 200 if DB connected and indexer running, 503 otherwise
```

```json
{
  "status": "ok",
  "ready": true,
  "program": "my_program",
  "indexerRunning": true,
  "lastSlot": 305000000,
  "uptime": 3600.5
}
```

### Prometheus metrics

```
GET /metrics
```

Returns metrics in Prometheus text format: transaction counts, RPC latency histograms, slot lag, events decoded, instructions indexed.

### IDL schema info

```
GET /schema
```

Returns the loaded IDL structure: instructions, accounts, events.

### Query instructions

```
GET /instructions/:name?cursor=&limit=&slot_from=&slot_to=&account_X=&arg_X=
```

- `cursor` — opaque cursor from previous response
- `limit` — max rows (default 50, max 200)
- `slot_from`, `slot_to` — slot range filter
- Any indexed column name for equality filtering

```bash
# First page
curl "http://localhost:3000/instructions/swap?limit=50"

# Filter by signer
curl "http://localhost:3000/instructions/swap?account_user=7xKp...&limit=100"

# Next page
curl "http://localhost:3000/instructions/swap?cursor=<nextCursor>"
```

Response:

```json
{
  "rows": [...],
  "total": 12345,
  "nextCursor": "eyJzbG90IjozMDUwMDAwMDAsImlkIjo5OTl9"
}
```

### Anchor events

```
GET /events?name=SwapExecuted&slot_from=300000000&limit=50
```

### Aggregation (extended)

```
GET /stats/:instruction?group_by=hour|day|total&op=count|sum|avg|min|max&field=arg_amount
```

```bash
# Total calls
curl http://localhost:3000/stats/swap

# Hourly count
curl "http://localhost:3000/stats/swap?group_by=hour"

# Sum of amounts per day
curl "http://localhost:3000/stats/swap?group_by=day&op=sum&field=arg_amount"

# Average amount
curl "http://localhost:3000/stats/swap?group_by=total&op=avg&field=arg_amount"
```

### Account history

```
GET /accounts/:type/:pubkey/history?limit=50&offset=0
```

Returns the full history of state changes for a specific account, ordered by slot descending.

### Program overview

```
GET /stats
```

Returns total indexed counts per instruction and event type.

### Trigger batch indexing

```
POST /index/batch
Content-Type: application/json

{"fromSlot": 300000000, "toSlot": 310000000}
```

### Re-sync all account states

```
POST /index/accounts
```

---

## Indexing modes

| Mode | Behavior |
|------|----------|
| `realtime` | Streams transactions via WebSocket + polling. Default mode. |
| `batch` | Indexes a specific slot range, then exits. Good for backfills. |
| `backfill_then_realtime` | Catches up from `FROM_SLOT` (or last checkpoint) to chain tip, then switches to realtime. Ideal for cold starts. |

---

## Storage backends

**PostgreSQL** is the default for production. Handles concurrent writes, scales to hundreds of millions of rows, and supports full connection pooling.

**SQLite** is available for edge deployments, single-node setups, or any environment where running a separate database process isn't practical. Uses WAL mode for concurrent reads. Set `DB_TYPE=sqlite`.

Both backends implement the same interface. Switching is a single environment variable.

---

## Architectural decisions

**Why cursor-based pagination instead of OFFSET**

`OFFSET N` scans and discards N rows on every request, and produces skipped or duplicate rows when new data is inserted between pages. Cursor pagination uses `WHERE (slot, id) > (lastSlot, lastId)` — constant cost and stable under writes.

**Why hybrid WebSocket + polling**

WebSocket subscriptions drop messages under RPC rate limits or network instability. Running a periodic polling pass alongside the WebSocket subscription lets the gap detector identify and backfill any missed transactions.

**Why IDL Version Manager**

Programs upgrade. Without tracking IDL versions, historical transactions decoded with the wrong schema produce silently incorrect data. The version manager records IDL hashes with their first valid slot and applies `ALTER TABLE ADD COLUMN` when new fields are added.

**Why both storage backends**

Different deployment contexts have different requirements. A production indexer tracking a high-volume DEX needs PostgreSQL. An indexer running on a VPS to track a small protocol, or in a CI pipeline for integration tests, benefits from SQLite's zero-configuration setup.

**Why exponential backoff with full jitter**

Pure exponential backoff causes synchronized retry storms when multiple requests fail at the same time. Full jitter (`sleep = random(0, cap)`) distributes retries evenly, preventing cascading overload on RPC endpoints.

**Why append-only account history**

Upsert-only snapshots lose the ability to track how account state evolved over time. The append-only history table (`acc_history_*`) records every state change, enabling point-in-time queries and audit trails.

---

## Running tests

```bash
npm test                 # 96 tests across 7 suites
npm run test:coverage    # with coverage report
```

**96 tests across 7 suites:**

| Suite | Tests | What is covered |
|-------|-------|-----------------|
| `dashboard.test.ts` | 26 | HTTP 200, HTML structure, all UI sections, CSS colors, JS auto-refresh, API calls, offline handling, size bounds |
| `db.test.ts` | 28 | CRUD, cursor pagination, slot filtering, SQL injection protection, deduplication |
| `idl.test.ts` | 11 | Discriminator computation, Borsh decoding (u8–u128, strings), schema SQL generation |
| `events.test.ts` | 8 | Anchor event decoding, discriminator matching, malformed data handling |
| `metrics.test.ts` | 10 | Counter/gauge/histogram rendering, Prometheus text format, HELP/TYPE deduplication per metric family |
| `config.test.ts` | 7 | Required fields, invalid modes, DB type validation, port ranges |
| `retry.test.ts` | 4 | Exponential backoff, max attempts, full jitter |

---

## Known limitations

- **Single program per instance** — each indexer instance tracks one program ID. For multi-program indexing, run multiple instances.
- **No Geyser/Yellowstone support** — relies on standard RPC endpoints. Geyser plugins would improve throughput for high-volume programs but add infrastructure complexity.
- **Account history tables grow unbounded** — the append-only `acc_history_*` tables need manual cleanup or TTL policies for long-running deployments.
- **Manual Borsh decoder is partial** — nested custom types (`defined` in IDL) fall back to null. The BorshCoder from `@coral-xyz/anchor` handles these correctly when available.

