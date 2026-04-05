import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { SchemaManager, IndexSchema, FieldConfig } from './schema';
import { config } from './config';

export class SolanaIndexer {
  private connection: Connection;
  private schemaManager: SchemaManager;
  private running = false;
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(schemaManager: SchemaManager) {
    this.connection = new Connection(config.RPC_URL, 'confirmed');
    this.schemaManager = schemaManager;
  }

  private extractField(tx: ParsedTransactionWithMeta, field: FieldConfig): any {
    try {
      const message = tx.transaction.message as any;
      switch (field.source) {
        case 'account': {
          const accounts = message.accountKeys || [];
          const parts = field.path.split('.');
          const account = accounts[parseInt(parts[0])];
          if (!account) return null;
          if (parts[1] === 'pubkey') return account.pubkey?.toString();
          if (parts[1] === 'signer') return account.signer;
          if (parts[1] === 'writable') return account.writable;
          return account.pubkey?.toString();
        }
        case 'instruction': {
          const instructions = message.instructions || [];
          const parts = field.path.split('.');
          const ix = instructions[parseInt(parts[0])];
          if (!ix) return null;
          if (parts[1] === 'programId') return ix.programId?.toString();
          if (parts[1] === 'data') return (ix as any).data;
          return null;
        }
        case 'log': {
          const logs = tx.meta?.logMessages || [];
          return logs[parseInt(field.path)] || null;
        }
        case 'meta': {
          if (field.path === 'fee') return tx.meta?.fee;
          if (field.path === 'err') return tx.meta?.err ? JSON.stringify(tx.meta.err) : null;
          if (field.path === 'computeUnitsConsumed') return tx.meta?.computeUnitsConsumed;
          return null;
        }
        default: return null;
      }
    } catch { return null; }
  }

  private matchesFilter(tx: ParsedTransactionWithMeta, schema: IndexSchema): boolean {
    const message = tx.transaction.message as any;
    const accounts: any[] = message.accountKeys || [];
    const accountStrings = accounts.map((a: any) => a.pubkey?.toString());

    if (schema.programId) {
      const instructions = message.instructions || [];
      const hasProgram = instructions.some((ix: any) => ix.programId?.toString() === schema.programId);
      if (!hasProgram) return false;
    }
    if (schema.accountFilter && !accountStrings.includes(schema.accountFilter)) return false;
    return true;
  }

  async indexForSchema(schema: IndexSchema): Promise<number> {
    let count = 0;
    try {
      const pubkey = schema.accountFilter
        ? new PublicKey(schema.accountFilter)
        : schema.programId ? new PublicKey(schema.programId) : null;
      if (!pubkey) return 0;

      const signatures: ConfirmedSignatureInfo[] = await this.connection.getSignaturesForAddress(pubkey, { limit: 10 });

      for (const sigInfo of signatures) {
        const tx = await this.connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx || !this.matchesFilter(tx, schema)) continue;

        const data: Record<string, any> = {};
        for (const field of schema.fields) {
          data[field.name] = this.extractField(tx, field);
        }
        this.schemaManager.saveTransaction(schema.id, sigInfo.signature, sigInfo.slot, data);
        count++;
      }
    } catch (err: any) {
      console.error(`Error indexing schema ${schema.id}:`, err.message);
    }
    return count;
  }

  startWatching(schema: IndexSchema) {
    if (this.intervals.has(schema.id)) return;
    const interval = setInterval(async () => {
      const count = await this.indexForSchema(schema);
      if (count > 0) console.log(`[${schema.name}] Indexed ${count} new transactions`);
    }, config.POLL_INTERVAL_MS);
    this.intervals.set(schema.id, interval);
    console.log(`Started watching schema: ${schema.name}`);
  }

  stopWatching(schemaId: string) {
    const interval = this.intervals.get(schemaId);
    if (interval) { clearInterval(interval); this.intervals.delete(schemaId); }
  }

  startAll() {
    this.running = true;
    const schemas = this.schemaManager.listSchemas();
    for (const schema of schemas) this.startWatching(schema);
    console.log(`Started indexer with ${schemas.length} active schemas`);
  }

  stop() {
    this.running = false;
    for (const [id] of this.intervals) this.stopWatching(id);
    console.log('Indexer stopped');
  }

  get isRunning() { return this.running; }
}
