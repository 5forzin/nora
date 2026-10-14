import { createServer } from 'node:http';
import { FIXTURE_TOKEN, responses, SESSION_COOKIE } from './api-fixtures.mts';

// Both SSR and browser requests use this isolated fixture API. It does not verify JWTs
// or exercise backend authorization; those contracts belong to the API test suite.
const servers = ['127.0.0.1', '::1'].map((host) => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.origin === 'http://localhost:3100') {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.writeHead(204).end();
      return;
    }

    const path = new URL(request.url ?? '/', 'http://localhost:8080').pathname;
    if (path === '/__e2e/health') {
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    const hasSession = request.headers.cookie?.split(';').some(
      (cookie) => cookie.trim() === `${SESSION_COOKIE}=${FIXTURE_TOKEN}`,
    );
    if (!hasSession) {
      response.writeHead(401).end(JSON.stringify({ message: 'Missing E2E fixture session' }));
      return;
    }
    if (request.method !== 'GET' || !Object.hasOwn(responses, path)) {
      console.error(`Unhandled E2E API request: ${request.method} ${path}`);
      response.writeHead(404).end(JSON.stringify({ message: 'No E2E fixture for this request' }));
      return;
    }
    response.end(JSON.stringify(responses[path]));
  });
  server.listen(8080, host);
  return server;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    for (const server of servers) server.close();
  });
}
