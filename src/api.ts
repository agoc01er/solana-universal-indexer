import express, { Request, Response } from 'express';
import Database from 'better-sqlite3';
import { SolanaIndexer } from './indexer';
import { AnchorIdl, getInstructionTableName } from './idl';
import { logger } from './logger';

export function createApp(db: Database.Database, indexer: SolanaIndexer, idl: AnchorIdl) {
  const app = express();
  app.use(express.json());

  // ─── Health ──────────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', indexerRunning: indexer.isRunning, program: idl.name });
  });

  // ─── Instructions list ───────────────────────────────────────────────────────
  app.get('/instructions', (_req: Request, res: Response) => {
    res.json(idl.instructions.map(ix => ({
      name: ix.name,
      table: getInstructionTableName(idl.name, ix.name),
      args: ix.args,
      accounts: ix.accounts,
    })));
  });

  // ─── Query transactions ──────────────────────────────────────────────────────
  // GET /transactions/:instruction?slot_from=&slot_to=&limit=&offset=&<filter>=
  app.get('/transactions/:instruction', (req: Request, res: Response) => {
    const ixDef = idl.instructions.find(ix => ix.name === req.params.instruction);
    if (!ixDef) return res.status(404).json({ error: `Unknown instruction: ${req.params.instruction}` });

    const tableName = getInstructionTableName(idl.name, req.params.instruction);
    const limit = Math.min(parseInt(req.query.limit as string || '100'), 1000);
    const offset = parseInt(req.query.offset as string || '0');

    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.slot_from) {
      conditions.push('slot >= ?');
      params.push(parseInt(req.query.slot_from as string));
    }
    if (req.query.slot_to) {
      conditions.push('slot <= ?');
      params.push(parseInt(req.query.slot_to as string));
    }
    if (req.query.signature) {
      conditions.push('signature = ?');
      params.push(req.query.signature);
    }

    // Dynamic column filters (arg_* and account_*)
    for (const [key, val] of Object.entries(req.query)) {
      if (['slot_from', 'slot_to', 'limit', 'offset', 'signature', 'group_by'].includes(key)) continue;
      conditions.push(`${key} = ?`);
      params.push(val);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const total = (db.prepare(`SELECT COUNT(*) as cnt FROM ${tableName} ${where}`).get(...params) as any).cnt;
      const rows = db.prepare(`SELECT * FROM ${tableName} ${where} ORDER BY slot DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      res.json({ total, count: rows.length, rows });
    } catch (err: any) {
      logger.error('Query error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Aggregation ─────────────────────────────────────────────────────────────
  // GET /stats/:instruction?group_by=slot_hour&slot_from=&slot_to=
  app.get('/stats/:instruction', (req: Request, res: Response) => {
    const ixDef = idl.instructions.find(ix => ix.name === req.params.instruction);
    if (!ixDef) return res.status(404).json({ error: `Unknown instruction: ${req.params.instruction}` });

    const tableName = getInstructionTableName(idl.name, req.params.instruction);

    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.slot_from) {
      conditions.push('slot >= ?');
      params.push(parseInt(req.query.slot_from as string));
    }
    if (req.query.slot_to) {
      conditions.push('slot <= ?');
      params.push(parseInt(req.query.slot_to as string));
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const groupBy = req.query.group_by as string;

    try {
      let query: string;
      if (groupBy === 'slot_hour') {
        query = `SELECT (slot / 216000) as hour_bucket, COUNT(*) as count FROM ${tableName} ${where} GROUP BY hour_bucket ORDER BY hour_bucket DESC LIMIT 24`;
      } else if (groupBy === 'slot_day') {
        query = `SELECT (slot / 216000 / 24) as day_bucket, COUNT(*) as count FROM ${tableName} ${where} GROUP BY day_bucket ORDER BY day_bucket DESC LIMIT 30`;
      } else {
        query = `SELECT COUNT(*) as total_calls, MIN(slot) as first_slot, MAX(slot) as last_slot, MAX(indexed_at) as last_indexed FROM ${tableName} ${where}`;
      }

      const result = groupBy
        ? db.prepare(query).all(...params)
        : db.prepare(query).get(...params);

      res.json(result);
    } catch (err: any) {
      logger.error('Stats error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Program overview ─────────────────────────────────────────────────────────
  app.get('/program/stats', (_req: Request, res: Response) => {
    const stats: Record<string, any> = { program: idl.name, instructions: {} };

    for (const ix of idl.instructions) {
      const tableName = getInstructionTableName(idl.name, ix.name);
      try {
        const row = db.prepare(
          `SELECT COUNT(*) as total, MIN(slot) as first_slot, MAX(slot) as last_slot FROM ${tableName}`
        ).get() as any;
        stats.instructions[ix.name] = row;
      } catch {
        stats.instructions[ix.name] = { total: 0 };
      }
    }

    res.json(stats);
  });

  // ─── Manual index trigger ────────────────────────────────────────────────────
  app.post('/index/batch', async (req: Request, res: Response) => {
    const { fromSlot, toSlot, signatures } = req.body;
    try {
      const count = await indexer.runBatch({ fromSlot, toSlot, signatures });
      res.json({ indexed: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
