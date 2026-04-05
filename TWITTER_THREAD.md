# Twitter Thread — Universal Solana Indexer

## Thread text (copy-paste to Twitter/X):

---

**Tweet 1:**
Built a production-ready Universal Solana Indexer as part of @SuperteamUA bounty 🧵

Point it at any Anchor program + IDL → it automatically generates the DB schema, decodes all transactions, and serves a rich REST API.

No custom code per program. Ever.

github.com/agoc01er/solana-universal-indexer

---

**Tweet 2:**
The core problem: every Solana dApp needs an indexer.

Current options:
→ Hosted (Helius, Shyft) = expensive + locked schemas
→ Custom = weeks of work per program
→ Generic JSONB dump = not queryable

Our solution: IDL-driven schema generation. Feed it the IDL, it creates typed SQL tables automatically.

---

**Tweet 3:**
What sets this apart from every other indexer I found:

🔥 Anchor EVENT decoding — emit!() logs decoded and stored (nobody else does this)
📊 Prometheus /metrics — slot lag, tx latency, RPC errors
🔄 IDL Version Manager — handles program upgrades automatically
🔍 Gap Detection — WebSocket + polling combined to never miss a tx

---

**Tweet 4:**
Architecture decisions + trade-offs:

SQLite (default) → zero-dep, great for dev, swap to PostgreSQL via DB_TYPE=postgres
WebSocket (realtime) + polling (gap detection) → both, not either/or
Cursor pagination → stable under high insert load (offset/limit breaks)
BorshCoder via @coral-xyz/anchor → proper discriminator matching, not manual parsing

---

**Tweet 5:**
The indexer catches things others miss:

CPI inner instructions (nested program calls) — indexed with cpi_depth
Anchor events from program logs — separate events table
Account state snapshots — background daemon via getProgramAccounts + onProgramAccountChange

Full picture of what happened in a transaction, not just the top-level call.

---

**Tweet 6:**
Reliability features:

⚡ Exponential backoff with full jitter on all RPC calls
🔁 WebSocket subscription with polling fallback
🛡️ SQL injection protection (allowlist + schema introspection)
🔄 Atomic DB writes (data + checkpoint in one transaction)
🛑 Graceful shutdown — SIGINT/SIGTERM with state flush

---

**Tweet 7:**
One command to run:

docker compose up

SQLite mode: zero external deps
PostgreSQL mode: docker compose --profile postgres up

github.com/agoc01er/solana-universal-indexer

Built for @SuperteamUA bounty. Feedback welcome 🙏

---

## Notes:
- Post as a thread (reply to each previous tweet)
- Add the GitHub link to Tweet 1 and Tweet 7
- Optional: screenshot of /metrics or /health response
