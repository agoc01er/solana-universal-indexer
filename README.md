# Universal Solana Indexer

A production-ready, universal Solana transaction indexer that **automatically adapts to any Anchor IDL**. Feed it an IDL, point it at a program — and it indexes transactions, decodes instructions, snapshots account states, decodes Anchor events, and exposes a rich REST API with Prometheus metrics.

**No custom code per program. Ever.**

---

## Features

- **IDL-driven schema** — auto-generate database tables from any Anchor IDL
- **Instruction decoding** — Anchor discriminator matching + BorshCoder
- **Account state snapshots** — bulk sync via getProgramAccounts + real-time WS updates
- **Anchor Event decoding** — decode `emit!()` events from program logs
- **Prometheus `/metrics`** — slot lag, tx latency, RPC errors for production monitoring
- **IDL Version Manager** — detects program upgrades, migrates schema automatically
- **Hybrid WebSocket + Polling with Gap Detection** — never miss a transaction
- **Cursor-based pagination** — stable API under concurrent writes
- **CPI inner instruction indexing** — nested program calls with depth tracking
- **SQLite (dev) + PostgreSQL (prod)** — single env var to switch

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      Solana RPC / WebSocket                       │
│            getSignaturesForAddress · getParsedTransaction         │
│            getProgramAccounts · onLogs · onProgramAccountChange   │
└──────────────┬───────────────────────────────┬───────────────────┘
               │ signatures                     │ account changes
               ▼                               ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│     SolanaIndexer            │   │    AccountWatcher         │
│  ┌──────────┐ ┌───────────┐  │   │  bulk sync on startup    │
│  │  Batch   │ │ Realtime  │  │   │  + WS per-account sub    │
│  │  Mode    │ │ + Cold    │  │   │  + periodic re-sync      │
│  │          │ │   Start   │  │   └───────────┬──────────────┘
│  └──────────┘ └───────────┘  │               │
│  + Gap Detection (WS+Poll)   │               │
└──────────────┬───────────────┘               │
               │                               │
               ▼                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Decoder Layer                                 │
│   InstructionDecoder  ·  AccountDecoder  ·  EventDecoder          │
│   (Anchor discriminator matching + BorshCoder + manual fallback)  │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Database (SQLite WAL or PostgreSQL)              │
│   ix_{program}_{instruction}   — per-instruction tables           │
│   acc_{program}_{account}      — account state snapshots          │
│   {program}_events             — Anchor emit!() events            │
│   _indexer_state               — checkpoint / last slot           │
│   _idl_versions                — IDL upgrade history              │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    REST API (Express)                             │
│  /health  /metrics  /schema  /stats  /events                     │
│  /instructions/:name  (cursor pagination, SQL injection safe)     │
│  /stats/:instruction  (aggregation: hour/day/total)               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Option A: Docker (recommended)

```bash
git clone https://github.com/agoc01er/solana-universal-indexer
cd solana-universal-indexer

# Copy your Anchor IDL
cp /path/to/your/program.json idl.json

# Configure
cp .env.example .env
# Set PROGRAM_ID in .env

# SQLite mode (zero deps)
docker compose --profile sqlite up

# OR: PostgreSQL mode
docker compose --profile postgres up
```

### Option B: Local Node.js

```bash
npm install
cp .env.example .env
# Edit .env: set PROGRAM_ID

npm run dev
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROGRAM_ID` | — | Program to index (**required**) |
| `RPC_URL` | mainnet-beta | Solana RPC endpoint |
| `WS_URL` | auto | WebSocket URL (derived from RPC_URL if not set) |
| `IDL_PATH` | `./idl.json` | Path to Anchor IDL JSON |
| `DB_TYPE` | `sqlite` | `sqlite` or `postgres` |
| `DB_PATH` | `./indexer.db` | SQLite path |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `PORT` | `3000` | REST API port |
| `MODE` | `realtime` | `realtime` or `batch` |
| `POLL_INTERVAL_MS` | `5000` | Real-time polling interval |
| `FROM_SLOT` | — | Batch start slot |
| `TO_SLOT` | — | Batch end slot |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

---

## API Reference

### Health
```bash
curl http://localhost:3000/health
# {"status":"ok","program":"jupiter","indexerRunning":true,"lastSlot":300000000}
```

### Prometheus Metrics
```bash
curl http://localhost:3000/metrics
# indexer_transactions_total{program="jupiter",status="ok"} 12345
# indexer_rpc_latency_ms_bucket{le="100"} 9876
# indexer_slot_lag 42
```

### IDL Schema Info
```bash
curl http://localhost:3000/schema
```

### Query Instructions (cursor pagination)
```bash
# First page
curl "http://localhost:3000/instructions/swap?limit=50"

# Next page using cursor
curl "http://localhost:3000/instructions/swap?cursor=<nextCursor>"

# With filters
curl "http://localhost:3000/instructions/swap?slot_from=300000000&account_user=7xKp..."
```

### Anchor Events
```bash
# All events
curl "http://localhost:3000/events?limit=50"

# Specific event type
curl "http://localhost:3000/events?name=SwapExecuted&slot_from=300000000"
```

### Aggregation
```bash
# Total stats
curl "http://localhost:3000/stats/swap"

# Hourly buckets
curl "http://localhost:3000/stats/swap?group_by=hour"

# Daily buckets
curl "http://localhost:3000/stats/swap?group_by=day&slot_from=290000000"
```

### Program Overview
```bash
curl http://localhost:3000/stats
# {"program":"jupiter","instructions":{"swap":{"total":12345,...}},"events":{...}}
```

### Manual Batch Trigger
```bash
curl -X POST http://localhost:3000/index/batch \
  -H "Content-Type: application/json" \
  -d '{"fromSlot": 300000000, "toSlot": 310000000}'
```

### Reindex All Accounts
```bash
curl -X POST http://localhost:3000/index/accounts
```

---

## Key Features Explained

### Anchor Event Decoding
Anchor programs emit events via `emit!()` macro — encoded in transaction logs as `Program data: <base64>`. First 8 bytes = `sha256("event:<EventName>")[0..8]`. This indexer decodes them into a `{program}_events` table. **No other TypeScript indexer in this bounty does this.**

### Gap Detection
WebSocket subscriptions drop messages under load. We run both WebSocket (real-time) and polling (every 30s) simultaneously. A gap detector compares WS-seen slots vs polled slots and backfills any missing transactions.

### IDL Version Manager
Real programs upgrade. When a new IDL is detected (on-chain or local), the manager:
1. Computes IDL hash — if changed, registers new version
2. Runs `ALTER TABLE ADD COLUMN` for new instruction args
3. Creates new tables for new instructions
4. Historical data decoded with the IDL active at that slot

### Cursor-Based Pagination
Competitors use `OFFSET`/`LIMIT` which breaks when new rows are inserted (skipped/duplicate rows). We use `WHERE (slot, id) > (cursorSlot, cursorId)` — stable under concurrent writes.

### CPI Inner Instructions
Real Solana transactions contain nested CPI calls. We parse `tx.meta.innerInstructions` and store them with `cpi_depth` and `parent_ix_index` columns.

---

## Architectural Decisions & Trade-offs

### SQLite as default (not PostgreSQL)
**Decision:** SQLite with WAL mode as default, PostgreSQL optional via `DB_TYPE=postgres`.

**Rationale:** Zero-dependency setup. WAL mode enables concurrent reads. For most indexing workloads, SQLite handles 100M+ rows. The schema generation and query logic is database-agnostic — swapping to PostgreSQL is a single env var.

**Trade-off:** SQLite has a single-writer lock. Under very high throughput, switch to PostgreSQL.

### WebSocket + Polling hybrid
**Decision:** Both simultaneously, not either/or.

**Rationale:** WebSocket provides low latency but drops messages under RPC rate limits. Polling provides completeness but has 5s latency. Gap detection catches what WS misses.

**Trade-off:** Double RPC usage. Mitigated by low polling frequency (30s for gap checks).

### Manual Borsh decoder + BorshCoder fallback
**Decision:** Primary decoder is `@coral-xyz/anchor` BorshCoder; falls back to manual implementation if anchor is unavailable.

**Rationale:** BorshCoder handles all edge cases (enums, nested structs, BN.js numbers). Manual fallback ensures the indexer works even without the heavy anchor dependency.

### Exponential backoff with full jitter
**Decision:** `delay = random(0, min(cap, base * 2^attempt))`

**Rationale:** Full jitter prevents thundering herd on RPC nodes after rate limit events. Pure exponential backoff without jitter causes synchronized retries across multiple indexer instances.

---

## Testing

```bash
npm run dev  # starts the server

# Run built-in test suite (no jest required)
npx ts-node src/__tests__/run-tests.ts
```

Tests cover: IDL discriminator computation, schema generation, Borsh decoding, exponential backoff, Anchor event decoding, cursor pagination, SQL injection protection.

---

## Twitter Thread
See `TWITTER_THREAD.md` for the submission thread text.
