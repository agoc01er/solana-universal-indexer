/**
 * Dashboard endpoint tests
 *
 * Verifies that the /dashboard route:
 * - Returns HTTP 200 with text/html content type
 * - Contains all required UI sections
 * - Uses correct Solana brand colors
 * - Has auto-refresh JS
 * - Calls all required API endpoints
 */
import express from 'express';
import request from 'supertest';
import { createDashboardRouter } from '../api/dashboard';

describe('Dashboard', () => {
  const app = express();
  app.use(createDashboardRouter());

  describe('GET /dashboard', () => {
    let response: request.Response;
    let html: string;

    beforeAll(async () => {
      response = await request(app).get('/dashboard');
      html = response.text;
    });

    it('returns HTTP 200', () => {
      expect(response.status).toBe(200);
    });

    it('returns text/html content type', () => {
      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('has valid HTML structure', () => {
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
    });

    it('has correct page title', () => {
      expect(html).toContain('<title>Universal Solana Indexer</title>');
    });

    it('has viewport meta tag', () => {
      expect(html).toContain('name="viewport"');
    });

    // ── UI sections ────────────────────────────────────────────────────────────

    it('has header with logo and status badge', () => {
      expect(html).toContain('Universal Solana Indexer');
      expect(html).toContain('Real-time Anchor program indexer');
      expect(html).toContain('id="headerStatus"');
    });

    it('has 4 stat cards', () => {
      expect(html).toContain('id="statProgram"');
      expect(html).toContain('id="statIxCount"');
      expect(html).toContain('id="statSlot"');
      expect(html).toContain('id="statUptime"');
    });

    it('has instructions schema section', () => {
      expect(html).toContain('Instructions Schema');
      expect(html).toContain('id="schemaList"');
      expect(html).toContain('id="ixBadge"');
    });

    it('has indexed counts section', () => {
      expect(html).toContain('Indexed Counts');
      expect(html).toContain('id="countsList"');
    });

    it('has recent transactions table', () => {
      expect(html).toContain('Recent Transactions');
      expect(html).toContain('id="txTable"');
      expect(html).toContain('SIGNATURE');
      expect(html).toContain('INSTRUCTION');
      expect(html).toContain('SLOT');
      expect(html).toContain('TIME');
    });

    it('has health details section', () => {
      expect(html).toContain('Health Details');
      expect(html).toContain('id="healthDetails"');
    });

    it('has GitHub footer link', () => {
      expect(html).toContain('github.com/agoc01er/solana-universal-indexer');
    });

    // ── Design ────────────────────────────────────────────────────────────────

    it('uses Solana purple accent color', () => {
      expect(html).toContain('#9945ff');
    });

    it('uses Solana green accent color', () => {
      expect(html).toContain('#14f195');
    });

    it('has dark background color', () => {
      expect(html).toContain('#0a0e1a');
    });

    it('has pulsing dot animation', () => {
      expect(html).toContain('animation: pulse');
    });

    // ── JavaScript / behaviour ────────────────────────────────────────────────

    it('has auto-refresh every 10 seconds', () => {
      expect(html).toContain('setInterval(loadAll, 10000)');
    });

    it('fetches /health endpoint', () => {
      expect(html).toContain("'/health'");
    });

    it('fetches /schema endpoint', () => {
      expect(html).toContain("'/schema'");
    });

    it('fetches /stats endpoint', () => {
      expect(html).toContain("'/stats'");
    });

    it('fetches /instructions endpoint', () => {
      expect(html).toContain("'/instructions/'");
    });

    it('has timeAgo helper function', () => {
      expect(html).toContain('function timeAgo');
    });

    it('handles offline state', () => {
      expect(html).toContain('Offline');
    });

    // ── Size ─────────────────────────────────────────────────────────────────

    it('HTML is at least 10KB (rich UI, not a stub)', () => {
      expect(Buffer.byteLength(html, 'utf8')).toBeGreaterThan(10_000);
    });

    it('HTML is less than 100KB (no bloat)', () => {
      expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(100_000);
    });
  });

  describe('Non-existent routes', () => {
    it('GET /dashboard/foo returns 404', async () => {
      const res = await request(app).get('/dashboard/foo');
      expect(res.status).toBe(404);
    });
  });
});
