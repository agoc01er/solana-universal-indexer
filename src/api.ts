import express, { Request, Response } from 'express';
import { SolanaIndexer } from './indexer';
import { IndexerRepository } from './db';
import { AnchorIdl } from './idl';
import { metrics } from './metrics';
import { logger } from './logger';

export function createApp(
  repo: IndexerRepository,
  indexer: SolanaIndexer,
  idl: AnchorIdl
) {
  const app = express();
  app.use(express.json());

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      program: idl.name,
      indexerRunning: indexer.isRunning,
      lastSlot: repo.getLastProcessedSlot(),
      uptime: process.uptime(),
    });
  });

  // ── Prometheus metrics (UNIQUE FEATURE) ────────────────────────────────────
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

  // ── Anchor Events (UNIQUE FEATURE) ─────────────────────────────────────────
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

  // ── Aggregation ────────────────────────────────────────────────────────────
  // GET /stats/:instruction?group_by=hour|day|total&slot_from=&slot_to=
  app.get('/stats/:instruction', (req: Request, res: Response) => {
    const ixDef = idl.instructions.find(ix => ix.name === req.params.instruction);
    if (!ixDef) return res.status(404).json({ error: `Unknown instruction: ${req.params.instruction}` });

    const groupBy = (req.query.group_by as string || 'total') as 'hour' | 'day' | 'total';
    const slotFrom = req.query.slot_from ? parseInt(req.query.slot_from as string) : undefined;
    const slotTo = req.query.slot_to ? parseInt(req.query.slot_to as string) : undefined;

    try {
      res.json(repo.aggregate(req.params.instruction, groupBy, slotFrom, slotTo));
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
