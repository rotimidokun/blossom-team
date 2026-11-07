import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { app } from './app.js';

const PORT = Number(process.env.PORT) || 3000;

export function startServer(port: number = PORT): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once('error', reject);
  });
}

// Run directly: `npm start`
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Process-level guard: a demo/production API must survive a stray rejected
  // promise (2026-11-05: an aborted MCP response during a long image
  // generation took the whole process down — every later request 502'd).
  // Log loudly instead of exiting; real failures still surface per request.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection (process kept alive):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException (process kept alive):', err);
  });

  startServer().then((server) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : PORT;
    console.log(`Blossom vending API listening on http://localhost:${port}`);
    console.log(`Health:  GET  http://localhost:${port}/health`);
    console.log(`Auth:    Authorization: Bearer ${process.env.VENDING_API_KEY || 'test_vending_key'}`);
  });
}