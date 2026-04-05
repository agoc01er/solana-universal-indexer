# Universal Solana Indexer

A flexible, schema-driven Solana transaction indexer with REST API. Define custom schemas to index exactly what you need — no code changes required.

## Features

- **Dynamic Schema** — define which fields to extract (accounts, instructions, logs, metadata)
- **REST API** — full CRUD for schemas + query indexed transactions
- **SQLite storage** — zero external database dependencies
- **Auto-polling** — continuously indexes new transactions every 5s
- **Filtering** — by program ID, account address, slot range

## Quick Start

```bash
npm install
npm run dev
```

Server starts at http://localhost:3000

## Configuration (.env)

```
RPC_URL=https://api.mainnet-beta.solana.com
PORT=3000
DB_PATH=./indexer.db
POLL_INTERVAL_MS=5000
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /schemas | List all schemas |
| POST | /schemas | Create schema |
| GET | /schemas/:id | Get schema |
| DELETE | /schemas/:id | Delete schema |
| GET | /schemas/:id/transactions | Query indexed data |
| POST | /schemas/:id/index | Manual index trigger |

## Create Schema Example

```bash
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
```

## Field Sources

| Source | Path | Description |
|--------|------|-------------|
| account | `{idx}.pubkey` | Account public key |
| account | `{idx}.signer` | Is signer |
| account | `{idx}.writable` | Is writable |
| instruction | `{idx}.programId` | Program ID |
| instruction | `{idx}.data` | Instruction data |
| log | `{idx}` | Log message at index |
| meta | `fee` | Transaction fee |
| meta | `err` | Error string |
| meta | `computeUnitsConsumed` | Compute units |
