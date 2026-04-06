import * as crypto from 'crypto';
import { EventDecoder } from '../decoder/event';
import { AnchorIdl } from '../idl/parser';

// Mock IDL with events
const mockIdl: AnchorIdl & { events: any[] } = {
  name: 'test_program',
  instructions: [],
  accounts: [],
  events: [
    {
      name: 'TradeExecuted',
      fields: [
        { name: 'amount', type: 'u64' },
        { name: 'price', type: 'u64' },
        { name: 'side', type: 'u8' },
      ],
    },
    {
      name: 'LiquidityAdded',
      fields: [
        { name: 'tokenA', type: 'u64' },
        { name: 'tokenB', type: 'u64' },
      ],
    },
  ],
};

function makeEventLog(eventName: string, dataBytes: Buffer): string {
  const disc = crypto.createHash('sha256').update(`event:${eventName}`).digest().slice(0, 8);
  const payload = Buffer.concat([disc, dataBytes]);
  return `Program data: ${payload.toString('base64')}`;
}

describe('EventDecoder', () => {
  let decoder: EventDecoder;

  beforeEach(() => {
    decoder = new EventDecoder(mockIdl as AnchorIdl);
  });

  test('hasEvents returns true when IDL has events', () => {
    expect(decoder.hasEvents).toBe(true);
  });

  test('hasEvents returns false for IDL without events', () => {
    const noEventsIdl: AnchorIdl = { name: 'x', instructions: [], accounts: [] };
    const d = new EventDecoder(noEventsIdl);
    expect(d.hasEvents).toBe(false);
  });

  test('decodes TradeExecuted event from logs', () => {
    // Encode: amount=1000 (u64 LE), price=500 (u64 LE), side=1 (u8)
    const data = Buffer.alloc(17);
    data.writeBigUInt64LE(BigInt(1000), 0);
    data.writeBigUInt64LE(BigInt(500), 8);
    data.writeUInt8(1, 16);

    const logs = [
      'Program log: test',
      makeEventLog('TradeExecuted', data),
      'Program log: success',
    ];

    const events = decoder.decodeFromLogs(logs, 12345, 'sig123');
    expect(events.length).toBe(1);
    expect(events[0].name).toBe('TradeExecuted');
    expect(events[0].slot).toBe(12345);
    expect(events[0].signature).toBe('sig123');
    expect(events[0].data.amount).toBe('1000');
    expect(events[0].data.price).toBe('500');
    expect(events[0].data.side).toBe(1);
  });

  test('decodes multiple events from same transaction', () => {
    const data1 = Buffer.alloc(16);
    data1.writeBigUInt64LE(BigInt(100), 0);
    data1.writeBigUInt64LE(BigInt(200), 8);

    const data2 = Buffer.alloc(16);
    data2.writeBigUInt64LE(BigInt(300), 0);
    data2.writeBigUInt64LE(BigInt(400), 8);

    const logs = [
      makeEventLog('TradeExecuted', Buffer.concat([data1, Buffer.alloc(1)])),
      makeEventLog('LiquidityAdded', data2),
    ];

    const events = decoder.decodeFromLogs(logs, 999, 'sig999');
    expect(events.length).toBe(2);
    expect(events[0].name).toBe('TradeExecuted');
    expect(events[1].name).toBe('LiquidityAdded');
  });

  test('ignores non-event logs', () => {
    const logs = [
      'Program log: some message',
      'Program consumed 1234 compute units',
      'Program return: abc123',
    ];
    const events = decoder.decodeFromLogs(logs, 1, 'sig1');
    expect(events.length).toBe(0);
  });

  test('ignores unknown event discriminators', () => {
    const unknownDisc = Buffer.alloc(8, 0xff); // all 0xFF — unlikely to match
    const payload = Buffer.concat([unknownDisc, Buffer.alloc(8)]);
    const logs = [`Program data: ${payload.toString('base64')}`];
    const events = decoder.decodeFromLogs(logs, 1, 'sig1');
    expect(events.length).toBe(0);
  });

  test('handles malformed base64 gracefully', () => {
    const logs = ['Program data: !!!not-valid-base64!!!'];
    expect(() => decoder.decodeFromLogs(logs, 1, 'sig1')).not.toThrow();
  });

  test('handles data shorter than discriminator gracefully', () => {
    const logs = [`Program data: ${Buffer.alloc(4).toString('base64')}`];
    const events = decoder.decodeFromLogs(logs, 1, 'sig1');
    expect(events.length).toBe(0);
  });
});
