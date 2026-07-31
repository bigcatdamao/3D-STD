import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cwd = process.cwd();
const outputDir = path.resolve(cwd, option('out', 'docs/ui-history/local'));
const relativeOutput = path.relative(cwd, outputDir);
const port = Number(option('port', '4187'));
const limit = Number(option('limit', '4'));
const maxBytes = 20 * 1024 * 1024;

if (
  !Number.isInteger(port)
  || port < 1024
  || port > 65_535
  || !Number.isInteger(limit)
  || limit < 1
  || relativeOutput.startsWith('..')
  || path.isAbsolute(relativeOutput)
) {
  throw new Error('Invalid local UI capture receiver options.');
}

await mkdir(outputDir, { recursive: true });
let savedCount = 0;

const server = http.createServer((request, response) => {
  const reply = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  };

  if (request.method === 'GET' && request.url === '/health') {
    reply(200, { ok: true, outputDir, savedCount, limit });
    return;
  }

  const match = request.method === 'POST'
    ? /^\/capture\/([a-z0-9][a-z0-9-]*\.png)$/i.exec(request.url ?? '')
    : null;
  if (!match || request.headers['content-type'] !== 'image/png') {
    request.resume();
    reply(404, { ok: false });
    return;
  }

  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) request.destroy(new Error('Screenshot exceeds 20 MB.'));
    else chunks.push(chunk);
  });
  request.on('error', () => {
    if (!response.headersSent) reply(413, { ok: false, error: 'capture_too_large' });
  });
  request.on('end', async () => {
    try {
      const filePath = path.join(outputDir, match[1]);
      await writeFile(filePath, Buffer.concat(chunks));
      savedCount += 1;
      reply(201, { ok: true, filePath, bytes: size, savedCount });
      if (savedCount >= limit) server.close();
    } catch (error) {
      reply(500, { ok: false, error: error instanceof Error ? error.message : 'write_failed' });
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`UI capture receiver listening on http://127.0.0.1:${port}\n`);
});
