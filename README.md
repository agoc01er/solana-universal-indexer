# Universal Solana Indexer

A production-ready, universal Solana transaction indexer that **automatically adapts to any Anchor IDL**. Provide an IDL file, set your program ID, and the indexer generates the database schema, decodes transactions, and exposes a rich REST API — all without writing any custom code.

## Features

- **IDL-driven schema generation** — database tables are auto-created from Anchor IDL
- **Instruction & account decoding** — decodes args and account keys per instruction definition
- **Batch mode** — index a specific slot range or list of signatures
- **Real-time mode with cold start** — backfills missed transactions, then streams new ones
- **Exponential backoff** — automatic retries with increasing delays on RPC failures
- **Graceful shutdown** — no data loss on SIGINT/SIGTERM
- **Advanced API** — multi-parameter filtering, aggregation, program statistics
- **Docker Compose** — single command startup with persistent storage
- **Structured JSON logging** — machine-readable logs for production monitoring

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Solana RPC Node                           │
└──────────────────────────┬──────────────────────────────────┘
                           │ getSignaturesForAddress
                           │ getParsedTransaction
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    SolanaIndexer                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │  Batch Mode │  │ Realtime Mode│  │  Retry / Backoff   │ │
│  │ (slot range)│  │+ Cold Start  │  │  withRetry()       │ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ decoded rows
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    IDL Engine                                │
│  generateSchemaSQL() → auto DDL from IDL                    │
│  decodeInstructionArgs() → BorshCoder-compatible decoder    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              SQLite (WAL mode)                               │
│  ix_{program}_{instruction}  — one table per instruction    │
│  acc_{program}_{account}     — one table per account type   │
│  _indexer_state              — checkpoint / last slot       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    REST API (Express)                        │
│  GET  /health                                               │
│  GET  /instructions                                         │
│  GET  /transactions/:instruction  (filter + paginate)       │
│  GET  /stats/:instruction         (aggregation)             │
│  GET  /program/stats                                        │
│  POST /index/batch                (manual trigger)          │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Option A: Docker (recommended)

```bash
git clone https://github.com/agoc01er/solana-universal-indexer
cd solana-universal-indexer

# Copy your Anchor IDL
cp /path/to/your/program.json idl.json

# Configure
cp .env.example .env
# Edit .env: set PROGRAM_ID

# Start
docker compose up -d

# Check health
curl http://localhost:3000/health
```

### Option B: Local Node.js

```bash
npm install
cp .env.example .env
# Edit .env

npm run dev
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | mainnet-beta | Solana RPC endpoint |
| `PROGRAM_ID` | — | Program to index (**required**) |
| `IDL_PATH` | `./idl.json` | Path to Anchor IDL JSON |
| `DB_PATH` | `./indexer.db` | SQLite database path |
| `PORT` | `3000` | REST API port |
| `MODE` | `realtime` | `realtime` or `batch` |
| `POLL_INTERVAL_MS` | `5000` | Real-time polling interval |
| `FROM_SLOT` | — | Batch mode: start slot |
| `TO_SLOT` | — | Batch mode: end slot |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

## API Examples

### Health check
```bash
curl http://localhost:3000/health
# {"status":"ok","indexerRunning":true,"program":"jupiter_aggregator_v6"}
```

### List indexed instructions
```bash
curl http://localhost:3000/instructions
```

### Query transactions with filters
```bash
# Last 50 swaps
curl "http://localhost:3000/transactions/swap?limit=50"

# Swaps by specific signer
curl "http://localhost:3000/transactions/swap?account_user_source_owner=7xKp...&limit=100"

# Swaps in slot range
curl "http://localhost:3000/transactions/swap?slot_from=260000000&slot_to=260100000"
```

### Aggregation / Statistics
```bash
# Total calls + slot range
curl http://localhost:3000/stats/swap

# Calls per hour bucket
curl "http://localhost:3000/stats/swap?group_by=slot_hour"

# Calls per day
curl "http://localhost:3000/stats/swap?group_by=slot_day"
```

### Program overview
```bash
curl http://localhost:3000/program/stats
```

### Manual batch trigger (via API)
```bash
curl -X POST http://localhost:3000/index/batch \
  -H "Content-Type: application/json" \
  -d '{"fromSlot": 260000000, "toSlot": 260100000}'
```

## Batch Mode

```bash
MODE=batch FROM_SLOT=260000000 TO_SLOT=260100000 npm start
```

## Architectural Decisions & Trade-offs

### SQLite over PostgreSQL
**Decision:** Use SQLite with WAL mode.  
**Rationale:** Zero-dependency setup, sufficient for most indexing workloads up to ~100M rows. WAL mode provides concurrent reads.  
**Trade-off:** Not horizontally scalable. For high-throughput programs, swap for PostgreSQL (schema generation logic is database-agnostic).

### Polling over WebSocket
**Decision:** Use `getSignaturesForAddress` polling instead of `accountSubscribe`.  
**Rationale:** WebSocket connections to public RPC nodes are unstable and rate-limited. Polling is simpler to make reliable.  
**Trade-off:** 5s latency. For lower latency, switch to a dedicated RPC with WebSocket support and implement `logsSubscribe`.

### IDL-based schema vs. manual
**Decision:** Auto-generate SQL tables from Anchor IDL.  
**Rationale:** Eliminates the need to write custom schema for each program. Any Anchor program works out of the box.  
**Trade-off:** Complex nested types (e.g., `Vec<Struct>`) are stored as JSON strings rather than normalized tables.

### Exponential backoff
**Decision:** Implement in `withRetry()` with configurable factor/ceiling.  
**Rationale:** Public RPC nodes have aggressive rate limits. Exponential backoff prevents cascading 429 errors.

## Key Design Patterns

- **Checkpoint-based resumption:** `_indexer_state` table stores `last_processed_slot` so restarts continue from where they left off
- **Cold start:** On launch, backfills all slots since the last checkpoint before switching to live polling
- **Graceful shutdown:** Listens for SIGINT/SIGTERM, waits for in-flight DB writes to complete before exit
