/**
 * MCP server assembly and the HTTP gate that protects it.
 *
 * `createApp()` returns a web-standard `{ fetch }` object:
 * - `/mcp/<CONNECTOR_SECRET>`            -> MCP endpoint (primary method)
 * - `/mcp` with header `x-api-key: <CONNECTOR_SECRET>` -> MCP endpoint
 * - anything else                        -> 404
 */

import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { VercelRuntimeSearchCache, type SearchCache } from './cache.js';
import { buildProviders, KNOWN_PROVIDER_IDS, type ProviderEnv } from './providers/index.js';
import type { ImageProvider } from './providers/types.js';
import { buildInputSchema, outputSchema, searchImages, type SearchImagesDeps } from './tool/search-images.js';

export const SERVER_INFO = { name: 'ngg-image-search', version: '0.1.0' } as const;
export const MCP_PATH = '/mcp';

export const TOOL_DESCRIPTION = [
  'Search free stock images (currently Pixabay) for use in slides, documents and designs.',
  'Write the query as short English keywords; if the user asked in Hebrew or another language, translate the subject into English keywords first (for example "ישיבת צוות" -> "team meeting office").',
  'For slide backgrounds and hero images prefer orientation "horizontal", image_type "photo" and min_width 1280 or more; pick results whose width and height are large enough for the placement.',
  'Each result includes a small preview_url for choosing and an image_url that is the highest-resolution file our licence allows. image_url_kind tells you which rendition it is.',
  'To use an image: download the file from image_url and embed or upload it into the design or document. Never reference the provider URL directly in the final output, because hotlinking is not permitted by the provider.',
  'Credit the photographer and the source where the design allows it (for example "Photo: {photographer} / Pixabay") and keep the attribution line returned in the response visible when you present search results.',
  'If a source is listed under sources_unavailable, the remaining sources were still searched; tell the user which source was unavailable.',
].join(' ');

export interface AppOptions {
  env?: ProviderEnv & { CONNECTOR_SECRET?: string | undefined };
  /** Override the provider list (tests). */
  providers?: ImageProvider[];
  unconfigured?: string[];
  cache?: SearchCache;
  timeoutMs?: number;
  log?: SearchImagesDeps['log'];
}

export interface App {
  fetch: (request: Request) => Promise<Response>;
  handler: McpHttpHandler;
}

export function createApp(options: AppOptions = {}): App {
  const env = options.env ?? process.env;
  const registry = options.providers
    ? { providers: options.providers, unconfigured: options.unconfigured ?? [] }
    : buildProviders(env);
  const deps: SearchImagesDeps = {
    providers: registry.providers,
    unconfigured: registry.unconfigured,
    cache: options.cache ?? new VercelRuntimeSearchCache(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    log: options.log ?? defaultLog,
  };

  const secret = env.CONNECTOR_SECRET?.trim() ?? '';
  if (secret.length === 0) {
    // Fail closed: without a secret every request is answered 404.
    console.error('[config] CONNECTOR_SECRET is not set; the endpoint is disabled');
  }
  if (registry.providers.length === 0) {
    console.error('[config] no image provider is configured; set PIXABAY_API_KEY');
  }

  const handler = createMcpHandler(() => buildServer(deps), {
    onerror: (error) => {
      // Protocol-level problems only; never includes tool arguments.
      console.error('[mcp]', error.name, error.message);
    },
  });

  return {
    handler,
    fetch: async (request: Request): Promise<Response> => {
      if (!isAuthorised(request, secret)) {
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return handler.fetch(request);
    },
  };
}

export function buildServer(deps: SearchImagesDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  const inputSchema = buildInputSchema(KNOWN_PROVIDER_IDS);

  server.registerTool(
    'search_images',
    {
      title: 'Search stock images',
      description: TOOL_DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const output = await searchImages(input, deps);
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

/**
 * Accept `/mcp/<secret>` or `/mcp` + `x-api-key: <secret>`. A trailing slash is
 * tolerated. Comparison is constant-time.
 */
export function isAuthorised(request: Request, secret: string): boolean {
  if (secret.length === 0) return false;
  const path = new URL(request.url).pathname.replace(/\/+$/, '');

  if (path === MCP_PATH) {
    const header = request.headers.get('x-api-key');
    return header !== null && safeEqual(header.trim(), secret);
  }
  if (path.startsWith(`${MCP_PATH}/`)) {
    const candidate = decodeURIComponent(path.slice(MCP_PATH.length + 1));
    return !candidate.includes('/') && safeEqual(candidate, secret);
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function defaultLog(event: string, fields?: Record<string, string | number>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
