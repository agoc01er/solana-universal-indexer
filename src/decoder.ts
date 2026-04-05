/**
 * Anchor BorshCoder-based instruction and account decoder.
 * Uses @coral-xyz/anchor for proper Borsh deserialization.
 *
 * Falls back to manual discriminator matching if anchor is unavailable.
 */
import { AnchorIdl, IdlInstruction, computeDiscriminator } from './idl';
import { logger } from './logger';

export interface DecodedInstruction {
  name: string;
  args: Record<string, any>;
  accounts: Record<string, string>;
}

export interface DecodedAccount {
  name: string;
  data: Record<string, any>;
}

/**
 * Safely serialize any value for SQL storage.
 * Converts BigInt, Buffer, PublicKey-like objects to strings/JSON.
 */
function serializeValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return val.toString();
  if (Buffer.isBuffer(val)) return val.toString('base64');
  if (val && typeof val.toBase58 === 'function') return val.toBase58(); // PublicKey
  if (val && typeof val.toString === 'function' && val.constructor?.name === 'BN') {
    return val.toString(); // BN.js
  }
  if (typeof val === 'object' && !Array.isArray(val)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) out[k] = serializeValue(v);
    return JSON.stringify(out);
  }
  if (Array.isArray(val)) {
    return JSON.stringify(val.map(serializeValue));
  }
  return val;
}

export class InstructionDecoder {
  private discriminatorMap: Map<string, IdlInstruction>;
  private coder: any = null; // @coral-xyz/anchor BorshInstructionCoder if available

  constructor(private idl: AnchorIdl) {
    // Build discriminator map for fallback
    this.discriminatorMap = new Map();
    for (const ix of idl.instructions) {
      const disc = computeDiscriminator(ix.name).toString('hex');
      this.discriminatorMap.set(disc, ix);
    }

    // Try to load @coral-xyz/anchor for full decoding
    this.tryLoadAnchorCoder();
  }

  private tryLoadAnchorCoder() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const anchor = require('@coral-xyz/anchor');
      this.coder = new anchor.BorshInstructionCoder(this.idl as any);
      logger.info('Using @coral-xyz/anchor BorshInstructionCoder');
    } catch {
      logger.info('Anchor not available, using manual discriminator decoder');
    }
  }

  /**
   * Decode instruction data from base64-encoded raw bytes.
   * Returns null if the instruction doesn't match any known discriminator.
   */
  decode(
    base64Data: string,
    accountKeys: string[]
  ): DecodedInstruction | null {
    const rawData = Buffer.from(base64Data, 'base64');
    if (rawData.length < 8) return null;

    const disc = rawData.slice(0, 8).toString('hex');
    const idlIx = this.discriminatorMap.get(disc);
    if (!idlIx) return null;

    let args: Record<string, any> = {};

    // Try anchor BorshCoder first
    if (this.coder) {
      try {
        const decoded = this.coder.decode(rawData);
        if (decoded?.data) {
          for (const [k, v] of Object.entries(decoded.data as Record<string, any>)) {
            args[k] = serializeValue(v);
          }
        }
      } catch {
        args = this.fallbackDecodeArgs(idlIx, rawData);
      }
    } else {
      args = this.fallbackDecodeArgs(idlIx, rawData);
    }

    // Map accounts by position
    const accounts: Record<string, string> = {};
    idlIx.accounts.forEach((acc, i) => {
      accounts[acc.name] = accountKeys[i] ?? null;
    });

    return { name: idlIx.name, args, accounts };
  }

  private fallbackDecodeArgs(idlIx: IdlInstruction, rawData: Buffer): Record<string, any> {
    // Import inline to avoid circular deps
    const { decodeInstructionArgs } = require('./idl');
    const decoded = decodeInstructionArgs(idlIx.args, rawData);
    return decoded;
  }
}

export class AccountDecoder {
  private coder: any = null;

  constructor(private idl: AnchorIdl) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const anchor = require('@coral-xyz/anchor');
      this.coder = new anchor.BorshAccountsCoder(this.idl as any);
      logger.info('Using @coral-xyz/anchor BorshAccountsCoder');
    } catch {
      logger.info('Anchor not available for account decoding');
    }
  }

  /**
   * Decode on-chain account data buffer into typed object.
   */
  decode(accountTypeName: string, data: Buffer): DecodedAccount | null {
    if (this.coder) {
      try {
        const decoded = this.coder.decode(accountTypeName, data);
        const result: Record<string, any> = {};
        for (const [k, v] of Object.entries(decoded as Record<string, any>)) {
          result[k] = serializeValue(v);
        }
        return { name: accountTypeName, data: result };
      } catch (err: any) {
        logger.warn('Anchor account decode failed', { accountTypeName, error: err.message });
      }
    }

    // Fallback: return raw hex
    return {
      name: accountTypeName,
      data: { raw_hex: data.toString('hex') },
    };
  }
}
