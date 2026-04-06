import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';

export function createDashboardRouter(): Router {
  const router = Router();

  router.get('/dashboard', (_req: Request, res: Response) => {
    res.type('html').send(getDashboardHtml());
  });

  return router;
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Universal Solana Indexer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #0a0e1a;
      --surface: #111827;
      --surface2: #1a2235;
      --border: #1e2d45;
      --accent: #9945ff;
      --accent2: #14f195;
      --text: #e2e8f0;
      --text2: #94a3b8;
      --red: #f43f5e;
      --yellow: #f59e0b;
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    /* Header */
    header {
      background: linear-gradient(135deg, #0a0e1a 0%, #1a0533 50%, #0a1628 100%);
      border-bottom: 1px solid var(--border);
      padding: 20px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }

    .logo h1 {
      font-size: 18px;
      font-weight: 700;
      background: linear-gradient(90deg, #fff, var(--accent2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo p {
      font-size: 12px;
      color: var(--text2);
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
    }

    .status-badge.ok {
      background: rgba(20, 241, 149, 0.1);
      border: 1px solid rgba(20, 241, 149, 0.3);
      color: var(--accent2);
    }

    .status-badge.error {
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.3);
      color: var(--red);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Layout */
    main { padding: 32px; max-width: 1400px; margin: 0 auto; }

    /* Stats grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      transition: border-color 0.2s;
    }

    .stat-card:hover { border-color: var(--accent); }

    .stat-label {
      font-size: 12px;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .stat-sub {
      font-size: 12px;
      color: var(--text2);
      margin-top: 4px;
    }

    /* Two-column layout */
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }

    @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }

    /* Cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }

    .card-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 10px;
      background: rgba(153, 69, 255, 0.15);
      color: var(--accent);
      border: 1px solid rgba(153, 69, 255, 0.3);
    }

    .card-body { padding: 20px; }

    /* Schema list */
    .schema-list { display: flex; flex-direction: column; gap: 8px; }

    .schema-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--surface2);
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 13px;
    }

    .schema-name {
      font-family: 'JetBrains Mono', monospace;
      color: var(--accent2);
      font-weight: 500;
    }

    .schema-args {
      color: var(--text2);
      font-size: 12px;
    }

    /* Table */
    .table-wrap { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th {
      text-align: left;
      padding: 10px 16px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border);
    }

    td {
      padding: 12px 16px;
      border-bottom: 1px solid rgba(30, 45, 69, 0.5);
      color: var(--text);
    }

    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface2); }

    .mono {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }

    .truncate {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }

    .tag-ok { background: rgba(20,241,149,0.1); color: var(--accent2); }
    .tag-error { background: rgba(244,63,94,0.1); color: var(--red); }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 40px;
      color: var(--text2);
      font-size: 14px;
    }

    /* Refresh */
    .refresh-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text2);
      padding: 6px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }

    .refresh-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Loading */
    .loading {
      opacity: 0.5;
      font-size: 13px;
      color: var(--text2);
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 24px;
      color: var(--text2);
      font-size: 12px;
      border-top: 1px solid var(--border);
      margin-top: 24px;
    }

    footer a { color: var(--accent2); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <div class="logo-icon">⚡</div>
      <div>
        <h1>Universal Solana Indexer</h1>
        <p>Real-time Anchor program indexer</p>
      </div>
    </div>
    <div id="headerStatus" class="status-badge">
      <div class="dot"></div>
      <span>Connecting...</span>
    </div>
  </header>

  <main>
    <!-- Stats row -->
    <div class="stats-grid" id="statsGrid">
      <div class="stat-card">
        <div class="stat-label">Program</div>
        <div class="stat-value" id="statProgram" style="font-size:16px">—</div>
        <div class="stat-sub" id="statProgramId">Loading...</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Instructions</div>
        <div class="stat-value" id="statIxCount">—</div>
        <div class="stat-sub" id="statIxSub">indexed types</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last Slot</div>
        <div class="stat-value" id="statSlot">—</div>
        <div class="stat-sub">latest checkpoint</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="statUptime">—</div>
        <div class="stat-sub">seconds running</div>
      </div>
    </div>

    <!-- Schema + Stats -->
    <div class="two-col">
      <!-- Instructions schema -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">📋 Instructions Schema</span>
          <span class="card-badge" id="ixBadge">0 types</span>
        </div>
        <div class="card-body">
          <div class="schema-list" id="schemaList">
            <div class="loading">Loading schema...</div>
          </div>
        </div>
      </div>

      <!-- Instruction counts -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">📊 Indexed Counts</span>
          <button class="refresh-btn" onclick="loadAll()">↺ Refresh</button>
        </div>
        <div class="card-body">
          <div class="schema-list" id="countsList">
            <div class="loading">Loading stats...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent instructions table -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-header">
        <span class="card-title">🔄 Recent Transactions</span>
        <span id="ixFilter" style="font-size:12px;color:var(--text2)">all types</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SIGNATURE</th>
              <th>INSTRUCTION</th>
              <th>SLOT</th>
              <th>TIME</th>
            </tr>
          </thead>
          <tbody id="txTable">
            <tr><td colspan="4" class="empty">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Health details -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">🔍 Health Details</span>
      </div>
      <div class="card-body">
        <div class="schema-list" id="healthDetails">
          <div class="loading">Loading health...</div>
        </div>
      </div>
    </div>
  </main>

  <footer>
    Universal Solana Indexer · Built with TypeScript, @solana/web3.js, PostgreSQL/SQLite ·
    <a href="https://github.com/agoc01er/solana-universal-indexer" target="_blank">GitHub</a>
  </footer>

  <script>
    const API = window.location.origin;
    let schemaInstructions = [];

    async function fetchJSON(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    }

    function el(id) { return document.getElementById(id); }

    function timeAgo(ts) {
      if (!ts) return '—';
      const diff = Math.floor((Date.now() / 1000) - ts);
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff/60) + 'm ago';
      if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
      return Math.floor(diff/86400) + 'd ago';
    }

    async function loadHealth() {
      try {
        const h = await fetchJSON(API + '/health');
        const ok = h.status === 'ok';
        const badge = el('headerStatus');
        badge.className = 'status-badge ' + (ok ? 'ok' : 'error');
        badge.innerHTML = '<div class="dot"></div><span>' + (ok ? 'Healthy' : 'Degraded') + '</span>';

        el('statProgram').textContent = h.program || '—';
        el('statProgramId').textContent = h.programId ? h.programId.slice(0,8)+'...'+h.programId.slice(-4) : '';
        el('statSlot').textContent = h.lastSlot ? h.lastSlot.toLocaleString() : '—';
        el('statUptime').textContent = h.uptime ? Math.floor(h.uptime).toLocaleString() : '—';

        el('healthDetails').innerHTML = [
          ['Status', '<span class="tag ' + (ok?'tag-ok':'tag-error') + '">' + h.status + '</span>'],
          ['Indexer Running', '<span class="tag ' + (h.indexerRunning?'tag-ok':'tag-error') + '">' + (h.indexerRunning?'yes':'no') + '</span>'],
          ['Program ID', '<span class="mono">' + (h.programId||'—') + '</span>'],
          ['Last Slot', h.lastSlot?.toLocaleString() || '—'],
          ['Uptime', h.uptime ? Math.floor(h.uptime) + 's' : '—'],
        ].map(([k,v]) =>
          '<div class="schema-item"><span style="color:var(--text2);font-size:12px">' + k + '</span><span>' + v + '</span></div>'
        ).join('');
      } catch(e) {
        el('headerStatus').className = 'status-badge error';
        el('headerStatus').innerHTML = '<div class="dot"></div><span>Offline</span>';
      }
    }

    async function loadSchema() {
      try {
        const s = await fetchJSON(API + '/schema');
        schemaInstructions = s.instructions || [];
        const count = schemaInstructions.length;
        el('ixBadge').textContent = count + ' types';
        el('statIxCount').textContent = count;

        el('schemaList').innerHTML = schemaInstructions.length
          ? schemaInstructions.map(ix => {
              const args = ix.args?.map(a => a.name).join(', ') || 'no args';
              const accs = ix.accounts?.length || 0;
              return '<div class="schema-item">' +
                '<span class="schema-name">' + ix.name + '</span>' +
                '<span class="schema-args">' + accs + ' accounts · ' + args + '</span>' +
                '</div>';
            }).join('')
          : '<div class="empty">No instructions in schema</div>';
      } catch(e) {
        el('schemaList').innerHTML = '<div class="empty">Schema unavailable</div>';
      }
    }

    async function loadStats() {
      try {
        const stats = await fetchJSON(API + '/stats');
        const counts = stats.instructions
          ? Object.entries(stats.instructions).map(([name, v]) => ({ name, count: v.total || 0 }))
          : [];
        el('countsList').innerHTML = counts.length
          ? counts.map(item =>
              '<div class="schema-item">' +
              '<span class="schema-name">' + item.name + '</span>' +
              '<span style="font-size:14px;font-weight:700;color:var(--accent2)">' + (item.count||0).toLocaleString() + '</span>' +
              '</div>'
            ).join('')
          : '<div class="empty">No data indexed yet</div>';
      } catch(e) {
        el('countsList').innerHTML = '<div class="empty">Stats unavailable</div>';
      }
    }

    async function loadRecentTxs() {
      try {
        const rows = [];
        for (const ix of schemaInstructions.slice(0, 3)) {
          try {
            const data = await fetchJSON(API + '/instructions/' + ix.name + '?limit=5');
            (data.rows || []).forEach(r => rows.push({ ...r, _ix: ix.name }));
          } catch {}
        }
        rows.sort((a,b) => (b.slot||0) - (a.slot||0));
        const top = rows.slice(0, 20);

        el('txTable').innerHTML = top.length
          ? top.map(r =>
              '<tr>' +
              '<td class="mono truncate" title="' + r.signature + '">' + (r.signature||'—').slice(0,12) + '...' + '</td>' +
              '<td><span class="tag" style="background:rgba(153,69,255,0.1);color:var(--accent)">' + r._ix + '</span></td>' +
              '<td class="mono">' + (r.slot||'—').toLocaleString?.() + '</td>' +
              '<td style="color:var(--text2)">' + timeAgo(r.block_time) + '</td>' +
              '</tr>'
            ).join('')
          : '<tr><td colspan="4" class="empty">No transactions indexed yet — start the indexer and wait for data</td></tr>';
      } catch(e) {
        el('txTable').innerHTML = '<tr><td colspan="4" class="empty">Could not load transactions</td></tr>';
      }
    }

    async function loadAll() {
      await loadHealth();
      await loadSchema();
      await loadStats();
      await loadRecentTxs();
    }

    // Load on start, refresh every 10s
    loadAll();
    setInterval(loadAll, 10000);
  </script>
</body>
</html>`;
}
