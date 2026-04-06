describe('config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('throws when PROGRAM_ID is missing', () => {
    process.env.PROGRAM_ID = '';
    process.env.DB_TYPE = 'sqlite';
    const { validateConfig } = require('../config');
    expect(() => validateConfig()).toThrow('PROGRAM_ID is required');
  });

  test('throws when DB_TYPE=postgres but DATABASE_URL is missing', () => {
    process.env.PROGRAM_ID = 'testProgramId123456789012345678901234567890ab';
    process.env.DB_TYPE = 'postgres';
    process.env.DATABASE_URL = '';
    const { validateConfig } = require('../config');
    expect(() => validateConfig()).toThrow('DATABASE_URL is required');
  });

  test('throws for invalid MODE', () => {
    process.env.PROGRAM_ID = 'testProgramId123456789012345678901234567890ab';
    process.env.DB_TYPE = 'sqlite';
    process.env.MODE = 'invalid_mode';
    const { validateConfig } = require('../config');
    expect(() => validateConfig()).toThrow('Invalid MODE');
  });

  test('accepts valid backfill_then_realtime mode', () => {
    process.env.PROGRAM_ID = 'testProgramId123456789012345678901234567890ab';
    process.env.DB_TYPE = 'sqlite';
    process.env.MODE = 'backfill_then_realtime';
    process.env.FROM_SLOT = '100';
    const { validateConfig } = require('../config');
    expect(() => validateConfig()).not.toThrow();
  });

  test('throws for invalid PORT', () => {
    process.env.PROGRAM_ID = 'testProgramId123456789012345678901234567890ab';
    process.env.DB_TYPE = 'sqlite';
    process.env.PORT = '0';
    const { validateConfig } = require('../config');
    expect(() => validateConfig()).toThrow('Invalid PORT');
  });

  test('passes with valid minimal config', () => {
    process.env.PROGRAM_ID = 'testProgramId123456789012345678901234567890ab';
    process.env.DB_TYPE = 'sqlite';
    process.env.MODE = 'realtime';
    process.env.PORT = '3000';
    const { validateConfig } = require('../config');
    expect(() => validateConfig()).not.toThrow();
  });
});
