/**
 * End-to-end tests: a real MCP client talks to the web-standard app over the
 * Streamable HTTP transport, with `fetch` routed in-process (no sockets).
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySearchCache } from '../src/cache.js';
import { PixabayProvider, type PixabayResponse } from '../src/providers/pixabay.js';
import { createApp, isAuthorised } from '../src/server.js';

const SECRET = 'test-secret-9f8e7d6c';
const ORIGIN = 'https://connector.test';

function hits(n: number): PixabayResponse {
  return {
    total: n,
    totalHits: n,
    hits: Array.from({ length: n }, (_, i) => ({
      id: 100 + i,
      pageURL: `https://pixabay.com/photos/x-${100 + i}/`,
      type: 'photo',
      tags: `tag${i}, office`,
      previewURL: `https://cdn.pixabay.com/photo/x-${100 + i}_150.jpg`,
      webformatURL: `https://pixabay.com/get/x-${100 + i}_640.jpg`,
      largeImageURL: `https://pixabay.com/get/x-${100 + i}_1280.jpg`,
      imageWidth: 5000,
      imageHeight: 3333,
      user_id: 7,
      user: 'photographer',
    })),
  };
}

function pixabayFetch(handler: (url: URL) => Response | Promise<Response>): typeof fetch {
  return (async (input: URL | RequestInfo) => handler(new URL(input instanceof Request ? input.url : String(input)))) as unknown as typeof fetch;
}

async function connect(app: ReturnType<typeof createApp>, url: string, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => app.fetch(new Request(input, init)),
    requestInit: { headers },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const silent = () => {};

describe('isAuthorised', () => {
  const req = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });

  it('accepts the secret path segment, with or without a trailing slash', () => {
    expect(isAuthorised(req(`/mcp/${SECRET}`), SECRET)).toBe(true);
    expect(isAuthorised(req(`/mcp/${SECRET}/`), SECRET)).toBe(true);
  });

  it('accepts /mcp with a matching x-api-key header', () => {
    expect(isAuthorised(req('/mcp', { 'x-api-key': SECRET }), SECRET)).toBe(true);
    expect(isAuthorised(req('/mcp', { 'x-api-key': 'wrong' }), SECRET)).toBe(false);
    expect(isAuthorised(req('/mcp'), SECRET)).toBe(false);
  });

  it('rejects other paths, prefixes, sub-paths and an empty secret', () => {
    expect(isAuthorised(req('/'), SECRET)).toBe(false);
    expect(isAuthorised(req(`/mcp/${SECRET}x`), SECRET)).toBe(false);
    expect(isAuthorised(req(`/mcp/${SECRET.slice(0, -1)}`), SECRET)).toBe(false);
    expect(isAuthorised(req(`/mcp/${SECRET}/extra`), SECRET)).toBe(false);
    expect(isAuthorised(req(`/api/mcp/${SECRET}`), SECRET)).toBe(false);
    expect(isAuthorised(req(`/mcp/${SECRET}`), '')).toBe(false);
  });
});

describe('HTTP gate', () => {
  it('answers 404 on any path other than the secret one', async () => {
    const app = createApp({ env: { CONNECTOR_SECRET: SECRET, PIXABAY_API_KEY: 'k' }, cache: new MemorySearchCache(), log: silent });
    for (const path of ['/', '/mcp', '/mcp/wrong', '/api/index', '/.well-known/oauth-protected-resource']) {
      const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
      expect(res.status, path).toBe(404);
    }
  });

  it('answers 404 for everything when CONNECTOR_SECRET is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ env: { PIXABAY_API_KEY: 'k' }, cache: new MemorySearchCache(), log: silent });
    const res = await app.fetch(new Request(`${ORIGIN}/mcp/`, { method: 'POST' }));
    expect(res.status).toBe(404);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('MCP end to end', () => {
  afterEach(() => vi.restoreAllMocks());

  function appWithPixabay(fetchImpl: typeof fetch) {
    const provider = new PixabayProvider({ apiKey: 'unit-test-key', fetch: fetchImpl });
    return createApp({
      env: { CONNECTOR_SECRET: SECRET },
      providers: [provider],
      cache: new MemorySearchCache(),
      log: silent,
      timeoutMs: 1000,
    });
  }

  it('lists a single read-only search_images tool', async () => {
    const app = appWithPixabay(pixabayFetch(() => Response.json(hits(0))));
    const client = await connect(app, `${ORIGIN}/mcp/${SECRET}`);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['search_images']);
    const tool = tools[0]!;
    expect(tool.title).toBe('Search stock images');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool.description).toMatch(/translate/i);
    expect(tool.description).toMatch(/horizontal/);
    expect(tool.description).toMatch(/Never reference the provider URL/);
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(['color', 'image_type', 'min_width', 'orientation', 'per_page', 'query', 'source']);
    expect(tool.outputSchema).toBeDefined();
    await client.close();
  });

  it('calls Pixabay once and returns compact structured results', async () => {
    const fetchMock = vi.fn(pixabayFetch((url) => {
      expect(url.searchParams.get('key')).toBe('unit-test-key');
      expect(url.searchParams.get('q')).toBe('office team');
      expect(url.searchParams.get('safesearch')).toBe('true');
      expect(url.searchParams.get('orientation')).toBe('horizontal');
      return Response.json(hits(3));
    }));
    const app = appWithPixabay(fetchMock as unknown as typeof fetch);
    const client = await connect(app, `${ORIGIN}/mcp/${SECRET}`);

    const result = await client.callTool({ name: 'search_images', arguments: { query: 'office team', per_page: 2 } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: Array<{ id: string; image_url: string }>; sources_used: string[]; attribution: string[] };
    expect(structured.sources_used).toEqual(['pixabay']);
    expect(structured.results).toHaveLength(2);
    expect(structured.results[0]).toMatchObject({ source: 'pixabay', id: '100', image_url_kind: 'large_1280', width: 1280, height: 853 });
    expect(structured.attribution).toEqual(['Images from Pixabay (https://pixabay.com/)']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Text content mirrors the structured content so clients without structured support still get the data.
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
    expect(JSON.parse(text)).toEqual(structured);
    expect(text.length).toBeLessThan(150_000);
    await client.close();
  });

  it('accepts the secret in the x-api-key header on /mcp', async () => {
    const app = appWithPixabay(pixabayFetch(() => Response.json(hits(1))));
    const client = await connect(app, `${ORIGIN}/mcp`, { 'x-api-key': SECRET });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    await client.close();
  });

  it('returns a normal (non-error) result naming the source when Pixabay is down', async () => {
    const app = appWithPixabay(pixabayFetch(() => new Response('upstream broke', { status: 503 })));
    const client = await connect(app, `${ORIGIN}/mcp/${SECRET}`);
    const result = await client.callTool({ name: 'search_images', arguments: { query: 'anything' } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: unknown[]; sources_unavailable: Array<{ source: string; reason: string }> };
    expect(structured.results).toEqual([]);
    expect(structured.sources_unavailable).toEqual([{ source: 'pixabay', reason: 'provider error (HTTP 503)' }]);
    await client.close();
  });

  it('returns a validation error result for bad arguments without calling Pixabay', async () => {
    const fetchMock = vi.fn(pixabayFetch(() => Response.json(hits(1))));
    const app = appWithPixabay(fetchMock as unknown as typeof fetch);
    const client = await connect(app, `${ORIGIN}/mcp/${SECRET}`);
    const result = await client.callTool({ name: 'search_images', arguments: { query: 'x', per_page: 99 } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
  });
});
