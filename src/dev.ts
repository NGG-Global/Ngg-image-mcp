/**
 * Local development server. Reads `.env`, serves the same app Vercel runs on
 * http://127.0.0.1:<PORT>/mcp/<CONNECTOR_SECRET>, and never logs the path.
 *
 *   npm run dev
 *   npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp/<secret> --transport http --method tools/list
 */

import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createApp } from './server.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on exported environment variables.
}

const port = Number(process.env['PORT'] ?? 3000);
const app = createApp();
const nodeHandler = toNodeHandler(app);

createServer((req, res) => {
  // `exactOptionalPropertyTypes` rejects IncomingMessage's optional fields; the adapter is duck-typed.
  void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
}).listen(port, '127.0.0.1', () => {
  console.log(`ngg-image-mcp listening on http://127.0.0.1:${port}${'/mcp/<CONNECTOR_SECRET>'}`);
});
