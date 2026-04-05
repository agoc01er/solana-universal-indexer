import express, { Request, Response } from 'express';
import { SchemaManager } from './schema';
import { SolanaIndexer } from './indexer';

function genId() {
  return Math.random().toString(36).substr(2, 9);
}

export function createApp(schemaManager: SchemaManager, indexer: SolanaIndexer) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', indexerRunning: indexer.isRunning });
  });

  app.get('/schemas', (_req: Request, res: Response) => {
    res.json(schemaManager.listSchemas());
  });

  app.post('/schemas', (req: Request, res: Response) => {
    const { name, programId, accountFilter, fields } = req.body;
    if (!name || !fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'name and fields[] are required' });
    }
    const schema = schemaManager.createSchema({ id: genId(), name, programId, accountFilter, fields });
    indexer.startWatching(schema);
    res.status(201).json(schema);
  });

  app.get('/schemas/:id', (req: Request, res: Response) => {
    const schema = schemaManager.getSchema(req.params.id);
    if (!schema) return res.status(404).json({ error: 'Schema not found' });
    res.json(schema);
  });

  app.delete('/schemas/:id', (req: Request, res: Response) => {
    indexer.stopWatching(req.params.id);
    const deleted = schemaManager.deleteSchema(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Schema not found' });
    res.json({ success: true });
  });

  app.get('/schemas/:id/transactions', (req: Request, res: Response) => {
    const schema = schemaManager.getSchema(req.params.id);
    if (!schema) return res.status(404).json({ error: 'Schema not found' });
    const filters = {
      slot_from: req.query.slot_from ? parseInt(req.query.slot_from as string) : undefined,
      slot_to: req.query.slot_to ? parseInt(req.query.slot_to as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
    };
    const txs = schemaManager.queryTransactions(req.params.id, filters);
    const total = schemaManager.countTransactions(req.params.id);
    res.json({ total, count: txs.length, transactions: txs });
  });

  app.post('/schemas/:id/index', async (req: Request, res: Response) => {
    const schema = schemaManager.getSchema(req.params.id);
    if (!schema) return res.status(404).json({ error: 'Schema not found' });
    const count = await indexer.indexForSchema(schema);
    res.json({ indexed: count });
  });

  return app;
}
