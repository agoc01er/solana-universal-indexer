# Universal Solana Indexer — Submission

## What I Built

A production-ready **Universal Solana Indexer** with Dynamic Schema support and REST API.

Instead of a fixed indexer for one protocol, this tool lets anyone define exactly what data to extract from Solana transactions — without writing code.

## Problem Solved

Every Solana dApp needs transaction indexing. Developers currently either:
- Pay for expensive hosted indexers (Helius, Shyft) locked to predefined schemas
- Write custom indexers from scratch for each use case

This project provides a **schema-driven middle ground**: deploy once, configure infinitely via API.

## Key Features

- **Dynamic Schema Engine** — define fields from accounts, instructions, logs, or metadata via JSON config
- **REST API** — create/manage schemas and query indexed data via HTTP
- **Auto-polling** — continuously watches Solana RPC for new transactions (configurable interval)
- **SQLite storage** — zero external database dependencies, runs anywhere
- **Filtering** — by program ID, account address, slot range

## Tech Stack

- TypeScript / Node.js
- `@solana/web3.js` — Solana RPC connection
- `better-sqlite3` — embedded database
- `express` — REST API

## How to Run

```bash
git clone <repo-url>
cd solana-universal-indexer
npm install
npm run dev
# Server starts at http://localhost:3000
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /schemas | List all schemas |
| POST | /schemas | Create new schema |
| GET | /schemas/:id | Get schema details |
| DELETE | /schemas/:id | Remove schema |
| GET | /schemas/:id/transactions | Query indexed transactions |
| POST | /schemas/:id/index | Trigger manual indexing |

## Example: Track Jupiter Swaps

```bash
# Create schema
curl -X POST http://localhost:3000/schemas \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jupiter Swaps",
    "programId": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "fields": [
      {"name": "signer", "source": "account", "path": "0.pubkey", "type": "string"},
      {"name": "fee", "source": "meta", "path": "fee", "type": "number"},
      {"name": "compute_units", "source": "meta", "path": "computeUnitsConsumed", "type": "number"}
    ]
  }'

# Query results
curl http://localhost:3000/schemas/{id}/transactions?limit=10
```

## GitHub

GitHub: [to be added before submission]

## Wallet

9NG518WEqqEfmSynqLyWDCpakJacXEoMdJCszAVw8SnC
