/**
 * Vercel Function entry point. `vercel.json` rewrites every path to this
 * function; `createApp` answers 404 for anything but the secret MCP path.
 */

import { createApp } from '../src/server.js';

const app = createApp();

export default {
  fetch: (request: Request): Promise<Response> => app.fetch(request),
};
