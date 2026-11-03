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
  startServer().then((server) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : PORT;
    console.log(`Blossom vending API listening on http://localhost:${port}`);
    console.log(`Health:  GET  http://localhost:${port}/health`);
    console.log(`Auth:    Authorization: Bearer ${process.env.VENDING_API_KEY || 'test_vending_key'}`);
  });
}