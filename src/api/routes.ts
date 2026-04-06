import express, { Request, Response } from 'express';
import { SolanaIndexer } from '../indexer/indexer';
import { IndexerRepository } from '../database/sqlite';
import { AnchorIdl } from '../idl/parser';
import { metrics } from '../observability/metrics';
import { logger } from '../observability/logger';
import { createDashboardRouter } from './dashboard';

export function createApp(
  repo: IndexerRepository,
  indexer: SolanaIndexer,
  idl: AnchorIdl
) {
  const app = express();
  app.use(express.json());
  app.use(createDashboardRouter());

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    const ready = repo.isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      ready,
      program: idl.name,
      indexerRunning: indexer.isRunning,
      lastSlot: repo.getLastProcessedSlot(),
      uptime: process.uptime(),
    });
  });

  // ── Readiness probe (for K8s liveness/readiness) ──────────────────────────
  app.get('/ready', (_req: Request, res: Response) => {
    const ready = repo.isReady() && indexer.isRunning;
    res.status(ready ? 200 : 503).json({ ready });
  });

  // ── Prometheus metrics ─────────────────────────────────────────────────────
  app.get('/metrics', (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics.render());
  });

  // ── IDL info ───────────────────────────────────────────────────────────────
  app.get('/schema', (_req: Request, res: Response) => {
    res.json({
      program: idl.name,
      version: idl.version,
      instructions: idl.instructions.map(ix => ({
        name: ix.name,
        accounts: ix.accounts,
        args: ix.args,
      })),
      accounts: idl.accounts ?? [],
      events: (idl as any).events ?? [],
    });
  });

  // ── Program stats ──────────────────────────────────────────────────────────
  app.get('/stats', (_req: Request, res: Response) => {
    res.json(repo.getProgramStats());
  });

  // ── Instructions (cursor-based pagination) ─────────────────────────────────
  // GET /instructions/:name?cursor=&limit=&slot_from=&slot_to=&account_X=&arg_X=
  app.get('/instructions/:name', (req: Request, res: Response) => {
    const ixDef = idl.instructions.find(ix => ix.name === req.params.name);
    if (!ixDef) {
      return res.status(404).json({ error: `Unknown instruction: ${req.params.name}` });
    }

    const filters: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (['cursor', 'limit'].includes(k)) continue;
      filters[k] = v;
    }

    try {
      const result = repo.queryInstructions(req.params.name, filters, {
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
        cursor: req.query.cursor as string | undefined,
      });
      res.json(result);
    } catch (err: any) {
      logger.error('Query error', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  // ── Anchor Events ──────────────────────────────────────────────────────────
  // GET /events?name=SwapExecuted&slot_from=&slot_to=&cursor=&limit=
  app.get('/events', (req: Request, res: Response) => {
    const eventName = req.query.name as string | undefined;
    const filters: Record<string, any> = {};
    if (req.query.slot_from) filters.slot_from = parseInt(req.query.slot_from as string);
    if (req.query.slot_to) filters.slot_to = parseInt(req.query.slot_to as string);

    try {
      const result = repo.queryEvents(eventName, filters, {
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
        cursor: req.query.cursor as string | undefined,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Aggregation (extended: SUM/AVG/MIN/MAX) ────────────────────────────────
  // GET /stats/:instruction?group_by=hour|day|total&op=count|sum|avg|min|max&field=arg_amount
  app.get('/stats/:instruction', (req: Request, res: Response) => {
    const ixDef = idl.instructions.find(ix => ix.name === req.params.instruction);
    if (!ixDef) return res.status(404).json({ error: `Unknown instruction: ${req.params.instruction}` });

    const groupBy = (req.query.group_by as string || 'total') as 'hour' | 'day' | 'total';
    const op = (req.query.op as string || 'count') as 'count' | 'sum' | 'avg' | 'min' | 'max';
    const field = req.query.field as string | undefined;
    const slotFrom = req.query.slot_from ? parseInt(req.query.slot_from as string) : undefined;
    const slotTo = req.query.slot_to ? parseInt(req.query.slot_to as string) : undefined;

    // Validate op
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(op)) {
      return res.status(400).json({ error: `Invalid op: ${op}. Use count, sum, avg, min, or max` });
    }
    if (op !== 'count' && !field) {
      return res.status(400).json({ error: `Field is required for ${op} operation` });
    }

    try {
      res.json(repo.aggregate(req.params.instruction, groupBy, slotFrom, slotTo, op, field));
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Account history ────────────────────────────────────────────────────────
  // GET /accounts/:type/:pubkey/history?limit=&offset=
  app.get('/accounts/:type/:pubkey/history', (req: Request, res: Response) => {
    const accDef = (idl.accounts ?? []).find(a => a.name === req.params.type);
    if (!accDef) return res.status(404).json({ error: `Unknown account type: ${req.params.type}` });

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    try {
      const history = repo.queryAccountHistory(req.params.type, req.params.pubkey, { limit, offset });
      res.json({ pubkey: req.params.pubkey, type: req.params.type, history });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Manual batch trigger ───────────────────────────────────────────────────
  app.post('/index/batch', async (req: Request, res: Response) => {
    const { fromSlot, toSlot, signatures } = req.body;
    try {
      const count = await indexer.runBatch({ fromSlot, toSlot, signatures });
      res.json({ indexed: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Index all program accounts ─────────────────────────────────────────────
  app.post('/index/accounts', async (_req: Request, res: Response) => {
    try {
      const count = await indexer.indexAllAccounts();
      res.json({ indexed: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
