# solana-universal-indexer

A universal Solana indexer that works with any Anchor program. Provide an IDL file, set a program ID, and the indexer handles everything: schema generation, transaction decoding, account state tracking, event parsing, and a REST API — without writing program-specific code.

Supports two storage backends: **PostgreSQL** for production workloads and **SQLite** for lightweight deployments, edge environments, and CI pipelines where running a database server isn't practical.

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
                              ├── ix_{program}_{instruction}   — one table per instruction
                              ├── acc_{program}_{account}      — account state snapshots
                              ├── {program}_events             — Anchor events
                              ├── _indexer_state               — checkpoint / last slot
                              └── _idl_versions                — IDL upgrade history
                                        │
                                        ▼
                              REST API (Express)
                              ├── /health, /metrics, /schema
                              ├── /instructions/:name  (cursor pagination)
                              ├── /events
                              ├── /stats/:instruction  (aggregation)
                              └── /stats
```

---

## Features

**Core indexing**
- IDL-driven schema — tables auto-generated from Anchor IDL on startup
- Instruction decoding with Anchor 8-byte discriminator matching and BorshCoder
- Account state snapshots via `getProgramAccounts` on startup, then real-time via `onProgramAccountChange`
- Anchor event decoding — `emit!()` events extracted from transaction logs
- CPI inner instruction tracking with `cpi_depth` and `parent_ix_index`

**Reliability**
- Real-time mode with cold start: backfills from last checkpoint, then streams live
- Hybrid WebSocket + polling with gap detection — polls every 30s to catch missed transactions
- Exponential backoff with full jitter on all RPC calls
- Atomic writes — data and checkpoint committed in the same transaction
- Graceful shutdown on `SIGINT`/`SIGTERM` with state flush

**API**
- Cursor-based pagination — stable under concurrent inserts, unlike `OFFSET`
- Multi-parameter filtering on any indexed column
- Aggregation by hour/day/total
- Prometheus `/metrics` — transaction throughput, RPC latency, slot lag
- SQL injection protection — column name allowlist + parameterized queries

**Infrastructure**
- IDL Version Manager — detects on-chain IDL upgrades, migrates schema automatically
- PostgreSQL for production, SQLite for lightweight/edge deployments
- Docker Compose with one-command startup
- Structured JSON logging

---

## Quick start

### Docker (PostgreSQL)

```bash
git clone https://github.com/agoc01er/solana-universal-indexer
cd solana-universal-indexer
cp .env.example .env        # set PROGRAM_ID and DATABASE_URL
cp your-program.json idl.json
docker compose up
```

### Docker (SQLite — no database server needed)

```bash
cp .env.example .env
# set PROGRAM_ID, set DB_TYPE=sqlite
docker compose --profile sqlite up
```

### Local

```bash
npm install
cp .env.example .env
npm run dev
```

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

# Indexing
MODE=realtime                         # realtime | batch
POLL_INTERVAL_MS=5000

# Batch mode
FROM_SLOT=
TO_SLOT=

# Logging
LOG_LEVEL=info
```

---

## API

### Health

```
GET /health
```

```json
{
  "status": "ok",
  "program": "my_program",
  "indexerRunning": true,
  "lastSlot": 305000000
}
```

### Prometheus metrics

```
GET /metrics
```

Returns metrics in Prometheus text format: transaction counts, RPC latency histograms, slot lag.

### IDL schema info

```
GET /schema
```

Returns the loaded IDL structure: instructions, accounts, events.

### Query instructions

```
GET /instructions/:name
```

Query parameters:
- `cursor` — opaque cursor from previous response
- `limit` — max rows (default 50, max 200)
- `slot_from`, `slot_to` — slot range filter
- Any indexed column name for equality filtering

```bash
# First page of swaps
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

### Aggregation

```
GET /stats/:instruction?group_by=hour|day|total&slot_from=...&slot_to=...
```

```bash
# Total calls to swap instruction
curl http://localhost:3000/stats/swap

# Hourly breakdown
curl "http://localhost:3000/stats/swap?group_by=hour"
```

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

## Storage backends

**PostgreSQL** is the default for production. It handles concurrent writes, scales to hundreds of millions of rows, and supports full connection pooling.

**SQLite** is available for edge deployments, single-node setups, or any environment where running a separate database process isn't practical. It uses WAL mode for concurrent reads. Set `DB_TYPE=sqlite` and optionally `DB_PATH`.

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

**Exponential backoff with full jitter**

Pure exponential backoff causes synchronized retry storms when multiple requests fail at the same time. Full jitter (`sleep = random(0, cap)`) distributes retries evenly, preventing cascading overload on RPC endpoints after rate limit events.

---

## Running tests

```bash
npx ts-node src/__tests__/run-tests.ts
```

Covers: IDL discriminator computation, Borsh decoding (u8–u128, strings, options, arrays), schema generation, exponential backoff, Anchor event decoding, cursor pagination, SQL injection protection.
