/**
 * Anchor Event Decoder
 *
 * Anchor programs emit structured events via the `emit!()` macro.
 * These are encoded in transaction logs as base64 data prefixed with "Program data: ".
 * First 8 bytes = sha256("event:<EventName>")[0..8] discriminator.
 *
 * This is a UNIQUE feature — no other competitor decodes Anchor events.
 */
import * as crypto from 'crypto';
import { AnchorIdl, IdlField, decodeField } from './idl';
import { logger } from './logger';

export interface IdlEvent {
  name: string;
  fields: IdlField[];
}

export interface DecodedEvent {
  name: string;
  slot: number;
  signature: string;
  data: Record<string, any>;
  rawLog: string;
}

function computeEventDiscriminator(eventName: string): Buffer {
  return crypto.createHash('sha256').update(`event:${eventName}`).digest().slice(0, 8);
}

function serializeEventValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return val.toString();
  if (Buffer.isBuffer(val)) return val.toString('base64');
  if (val && typeof val.toBase58 === 'function') return val.toBase58();
  if (Array.isArray(val)) return val.map(serializeEventValue);
  if (typeof val === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) out[k] = serializeEventValue(v);
    return out;
  }
  return val;
}

export class EventDecoder {
  private eventMap: Map<string, IdlEvent> = new Map();
  private anchorCoder: any = null;

  constructor(private idl: AnchorIdl) {
    // Build event discriminator map
    const events: IdlEvent[] = (idl as any).events ?? [];
    for (const event of events) {
      const disc = computeEventDiscriminator(event.name).toString('hex');
      this.eventMap.set(disc, event);
    }

    if (this.eventMap.size > 0) {
      logger.info('Event decoder ready', {
        events: events.map(e => e.name),
      });
    }

    // Try anchor coder
    try {
      const anchor = require('@coral-xyz/anchor');
      this.anchorCoder = new anchor.BorshEventCoder(idl as any);
    } catch {
      // anchor not available, use manual decoder
    }
  }

  get hasEvents(): boolean {
    return this.eventMap.size > 0;
  }

  /**
   * Parse all Anchor events from a transaction's log messages.
   * Logs with "Program data: <base64>" contain encoded events.
   */
  decodeFromLogs(
    logs: string[],
    slot: number,
    signature: string
  ): DecodedEvent[] {
    const events: DecodedEvent[] = [];

    for (const log of logs) {
      if (!log.startsWith('Program data: ')) continue;

      const base64 = log.slice('Program data: '.length).trim();
      let data: Buffer;
      try {
        data = Buffer.from(base64, 'base64');
      } catch {
        continue;
      }

      if (data.length < 8) continue;

      const disc = data.slice(0, 8).toString('hex');
      const eventDef = this.eventMap.get(disc);
      if (!eventDef) continue;

      let decoded: Record<string, any> = {};

      // Try anchor BorshEventCoder first
      if (this.anchorCoder) {
        try {
          const result = this.anchorCoder.decode(base64);
          if (result?.data) {
            for (const [k, v] of Object.entries(result.data as Record<string, any>)) {
              decoded[k] = serializeEventValue(v);
            }
          }
        } catch {
          decoded = this.manualDecode(eventDef, data);
        }
      } else {
        decoded = this.manualDecode(eventDef, data);
      }

      events.push({
        name: eventDef.name,
        slot,
        signature,
        data: decoded,
        rawLog: log,
      });

      logger.debug('Anchor event decoded', { event: eventDef.name, slot, signature });
    }

    return events;
  }

  private manualDecode(eventDef: IdlEvent, data: Buffer): Record<string, any> {
    const result: Record<string, any> = {};
    let offset = 8; // skip discriminator

    for (const field of eventDef.fields) {
      try {
        const [val, newOffset] = decodeField(field.type, data, offset);
        result[field.name] = serializeEventValue(val);
        offset = newOffset;
      } catch {
        result[field.name] = null;
      }
    }

    return result;
  }
}
