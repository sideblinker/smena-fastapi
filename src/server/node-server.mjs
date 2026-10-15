// Локальный сервер без npm-пакетов: Node.js 24 + встроенная SQLite.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteDatabase } from './sqlite.mjs';
import { handleApi } from './service.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(project, 'public');
const databasePath = process.env.SMENA_DB_PATH || resolve(project, 'data/smena.sqlite');
const port = Number(process.env.PORT || 4173);
const db = createSqliteDatabase(databasePath);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${incoming.headers.host || `127.0.0.1:${port}`}`;
    const url = new URL(incoming.url, origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      outgoing.writeHead(403, securityHeaders); return outgoing.end('Недопустимый адрес сервера.');
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 100 * 1024) { outgoing.writeHead(413, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }); return outgoing.end(JSON.stringify({ error: 'Слишком большой запрос.' })); }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks); const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
        else if (value !== undefined) headers.set(key, value);
      }
      const request = new Request(url, { method: incoming.method, headers, ...(!['GET', 'HEAD'].includes(incoming.method) && body.length ? { body } : {}) });
      const response = await handleApi(request, { db, allowSetup: true, secureCookies: false });
      outgoing.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) });
      return outgoing.end(Buffer.from(await response.arrayBuffer()));
    }
    if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405, securityHeaders); return outgoing.end(); }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { outgoing.writeHead(400, securityHeaders); return outgoing.end(); }
    const filename = resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(publicRoot + sep) || pathname.includes('\0')) { outgoing.writeHead(403, securityHeaders); return outgoing.end(); }
    try {
      const data = await readFile(filename);
      outgoing.writeHead(200, { ...securityHeaders, 'Content-Type': types[extname(filename)] || 'application/octet-stream' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : data);
    } catch { outgoing.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' }); outgoing.end('Страница не найдена.'); }
  } catch (error) {
    console.error('Ошибка сервера:', error.code || error.name);
    if (!outgoing.headersSent) outgoing.writeHead(500, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    outgoing.end(JSON.stringify({ error: 'Внутренняя ошибка сервера.' }));
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Смена: http://127.0.0.1:${port}`);
  console.log('Администратор: Адиль Кубентаев · логин Adilium');
  console.log('При первом запуске задайте пароль на странице настройки.');
  console.log(`SQL-база: ${databasePath}`);
});
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
