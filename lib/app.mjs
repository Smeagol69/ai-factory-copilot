import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../app/public/', import.meta.url));
const pages = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const checkNames = new Set(['mcp', 'rea', 'native', 'companion', 'start-companion', 'architect']);
const cleanError = error => String(error?.message ?? 'Check failed').replace(/(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 500);

export async function createAppServer({ root, project, port, readStatus, runCheck }) {
  const state = join(root, 'state/app');
  mkdirSync(state, { recursive: true });
  const historyPath = join(state, 'checks.json');
  let history = [];
  try {
    if (existsSync(historyPath) && readFileSync(historyPath).length <= 1048576) {
      const saved = JSON.parse(readFileSync(historyPath, 'utf8'));
      if (Array.isArray(saved)) history = saved.slice(-20);
    }
  } catch { /* Corrupt check history cannot masquerade as a passing check. */ }
  let running = null;
  const server = createServer(async (req, res) => {
    const authority = `127.0.0.1:${req.socket.localPort}`, origin = `http://${authority}`;
    const json = (code, data) => {
      const text = JSON.stringify(data);
      if (Buffer.byteLength(text) > 1048576) { res.writeHead(503).end('Result exceeds response limit'); return; }
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(text);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      json(403, { error: 'Local application origin required' }); return;
    }
    if (req.method === 'GET' && pages[req.url]) {
      const [file, type] = pages[req.url];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(readFileSync(join(publicRoot, file))); return;
    }
    if (req.url === '/api/identity' && req.method === 'GET') {
      json(200, { application: 'copilot-control-room/v1', root, project, pid: process.pid }); return;
    }
    if (req.url === '/api/status' && req.method === 'GET') {
      try { json(200, { ...await readStatus(), checks: history, runningCheck: running }); }
      catch (error) { json(503, { error: cleanError(error), checks: history, runningCheck: running }); }
      return;
    }
    const name = req.url?.startsWith('/api/checks/') ? req.url.slice('/api/checks/'.length) : null;
    if (!checkNames.has(name)) { json(404, { error: 'Unknown application route' }); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); json(405, { error: 'Use POST for a check' }); return; }
    if (running) { json(409, { error: 'A check is already running', runningCheck: running }); return; }
    // There is no request-defined command, path, target, environment or model budget.
    req.resume();
    running = name;
    const startedAt = new Date().toISOString();
    let receipt;
    try {
      const result = await runCheck(name);
      receipt = { name, status: result?.ok === false ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), result };
    } catch (error) {
      receipt = { name, status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: cleanError(error) };
    }
    try {
      // Keep bounded durable receipts rather than dumping unrestricted tool payloads.
      if (Buffer.byteLength(JSON.stringify(receipt)) > 32768) {
        const evidenceFile = typeof receipt.result?.evidenceFile === 'string' ? receipt.result.evidenceFile.slice(0, 500) : undefined;
        receipt = { name, status: 'failed', startedAt, finishedAt: receipt.finishedAt,
          error: 'Check result exceeds the display limit; inspect its saved evidence file.', result: { evidenceFile } };
      }
      const nextHistory = [...history, receipt].slice(-20);
      const temporary = join(state, 'checks.tmp');
      writeFileSync(temporary, JSON.stringify(nextHistory) + '\n');
      renameSync(temporary, historyPath);
      history = nextHistory;
      json(receipt.status === 'passed' ? 200 : 502, receipt);
    } catch (error) { json(503, { status: 'failed', error: cleanError(error) }); }
    finally { running = null; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
