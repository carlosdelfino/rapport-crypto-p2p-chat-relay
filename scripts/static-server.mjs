/**
 * Servidor estático mínimo para validação E2E da saída de produção.
 *
 * Serve `public/` com a mesma semântica de cleanUrls da Vercel
 * (`/tokens` -> `/tokens/index.html`), sem directory listing e sem cache.
 * Usado pelo `webServer` do playwright.config.ts — não é o servidor de
 * produção (esse é a Vercel), apenas uma réplica local do comportamento
 * de entrega dos assets estáticos.
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);

    // Bloqueia path traversal.
    const resolved = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!resolved.startsWith(PUBLIC_DIR)) {
      return send(res, 403, 'Forbidden');
    }

    let file = resolved;
    let info = await stat(file).catch(() => null);

    // cleanUrls: /tokens -> /tokens/index.html ; /tokens/ idem.
    if (info?.isDirectory() || info === null) {
      const candidate = path.join(resolved, 'index.html');
      const candidateInfo = await stat(candidate).catch(() => null);
      if (candidateInfo?.isFile()) {
        file = candidate;
        info = candidateInfo;
      } else if (info === null) {
        // Vercel aplica também a tentativa de "<path>.html"
        const htmlFile = `${resolved}.html`;
        const htmlInfo = await stat(htmlFile).catch(() => null);
        if (htmlInfo?.isFile()) {
          file = htmlFile;
          info = htmlInfo;
        }
      }
    }

    if (info?.isDirectory()) {
      return send(res, 403, 'Forbidden');
    }
    if (!info?.isFile()) {
      return send(res, 404, 'Not Found');
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 500, `Internal Server Error: ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`static-server: serving ${PUBLIC_DIR} on http://127.0.0.1:${PORT}`);
});
