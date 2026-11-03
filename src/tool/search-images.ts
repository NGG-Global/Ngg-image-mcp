/**
 * The `search_images` tool: input schema, provider fan-out, merging, and the
 * compact result Claude receives. The execution logic is a plain function so
 * it can be unit-tested without an MCP server.
 */

import * as z from 'zod';
import { cacheKey, type SearchCache } from '../cache.js';
import { COLORS, type ImageProvider, type ImageResult, type ProviderSearchResult, type SearchRequest } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';

export const PER_PAGE_DEFAULT = 8;
export const PER_PAGE_MAX = 12;
export const PROVIDER_TIMEOUT_MS = 8_000;

export function buildInputSchema(providerIds: readonly string[]) {
  const sourceValues: [string, ...string[]] = ['all', ...providerIds];
  return z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('Search keywords in English (translate Hebrew or other languages first). Example: "team meeting office".'),
    orientation: z
      .enum(['horizontal', 'vertical', 'all'])
      .default('horizontal')
      .describe('Image orientation. Use "horizontal" for slides; default horizontal.'),
    image_type: z
      .enum(['photo', 'illustration', 'vector', 'all'])
      .default('photo')
      .describe('Kind of image. Default "photo".'),
    color: z
      .enum(COLORS)
      .optional()
      .describe('Optional dominant colour filter. Providers that cannot filter by this colour are skipped.'),
    min_width: z
      .number()
      .int()
      .min(0)
      .max(20_000)
      .optional()
      .describe('Optional minimum width in pixels of the original image. For a full-slide photo use 1280 or more.'),
    source: z
      .enum(sourceValues)
      .default('all')
      .describe('Which library to search. Default "all".'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(PER_PAGE_MAX)
      .default(PER_PAGE_DEFAULT)
      .describe(`How many results to return in total across sources (default ${PER_PAGE_DEFAULT}, max ${PER_PAGE_MAX}).`),
  });
}

export type SearchImagesInput = z.infer<ReturnType<typeof buildInputSchema>>;

export const resultSchema = z.object({
  source: z.string(),
  id: z.string(),
  description: z.string(),
  width: z.number(),
  height: z.number(),
  preview_url: z.string(),
  image_url: z.string(),
  image_url_kind: z.enum(['original', 'full_hd_1920', 'large_1280']),
  vector_url: z.string().optional(),
  photographer: z.string(),
  photographer_url: z.string(),
  page_url: z.string(),
});

export const outputSchema = z.object({
  results: z.array(resultSchema),
  sources_used: z.array(z.string()),
  sources_unavailable: z.array(z.object({ source: z.string(), reason: z.string() })),
  sources_skipped: z.array(z.object({ source: z.string(), reason: z.string() })),
  attribution: z.array(z.string()),
  usage_note: z.string(),
});

export type SearchImagesOutput = z.infer<typeof outputSchema>;

export const USAGE_NOTE =
  'Download the image file from image_url and embed or upload it into the design or document. ' +
  'Never reference the provider URL directly in the final output (hotlinking is not permitted). ' +
  'Credit the photographer and source where the design allows it, e.g. "Photo: {photographer} / {source}".';

export interface SearchImagesDeps {
  providers: ImageProvider[];
  /** Providers known to this build but not configured (no key). Reported as unavailable. */
  unconfigured?: string[];
  cache: SearchCache;
  timeoutMs?: number;
  /** Minimal logger; must never receive query text or keys. */
  log?: (event: string, fields?: Record<string, string | number>) => void;
}

/** Execute a search across the selected providers and merge the results. */
export async function searchImages(input: SearchImagesInput, deps: SearchImagesDeps): Promise<SearchImagesOutput> {
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const log = deps.log ?? (() => {});

  const selected =
    input.source === 'all' ? deps.providers : deps.providers.filter((p) => p.id === input.source);

  const sources_unavailable: SearchImagesOutput['sources_unavailable'] = [];
  const sources_skipped: SearchImagesOutput['sources_skipped'] = [];

  for (const id of deps.unconfigured ?? []) {
    if (input.source === 'all' || input.source === id) {
      sources_unavailable.push({ source: id, reason: 'not configured on the server (missing API key)' });
    }
  }

  const baseRequest: Omit<SearchRequest, 'perPage'> = {
    query: input.query,
    orientation: input.orientation,
    imageType: input.image_type,
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.min_width !== undefined && input.min_width > 0 ? { minWidth: input.min_width } : {}),
  };

  // Drop providers that cannot honour the filters instead of returning mismatched images.
  const active: ImageProvider[] = [];
  for (const provider of selected) {
    const decision = provider.supports({ ...baseRequest, perPage: input.per_page });
    if (decision.ok) {
      active.push(provider);
    } else {
      sources_skipped.push({ source: provider.id, reason: decision.reason });
    }
  }

  const perProvider = active.length > 0 ? Math.ceil(input.per_page / active.length) : 0;
  const request: SearchRequest = { ...baseRequest, perPage: perProvider };

  const settled = await Promise.all(
    active.map(async (provider) => {
      const started = Date.now();
      try {
        const result = await searchWithCache(provider, request, deps.cache, timeoutMs, log);
        log('provider_ok', { provider: provider.id, ms: Date.now() - started, results: result.results.length });
        return { provider, result };
      } catch (error) {
        const reason = describeError(error);
        log('provider_failed', { provider: provider.id, ms: Date.now() - started, reason });
        sources_unavailable.push({ source: provider.id, reason });
        return { provider, result: null };
      }
    }),
  );

  const successful = settled.filter((s): s is { provider: ImageProvider; result: ProviderSearchResult } => s.result !== null);

  const results = interleave(
    successful.map((s) => s.result.results),
    input.per_page,
  );

  const attribution = successful.map((s) => s.provider.attribution);

  return {
    results,
    sources_used: successful.map((s) => s.provider.id),
    sources_unavailable,
    sources_skipped,
    attribution,
    usage_note: USAGE_NOTE,
  };
}

async function searchWithCache(
  provider: ImageProvider,
  request: SearchRequest,
  cache: SearchCache,
  timeoutMs: number,
  log: NonNullable<SearchImagesDeps['log']>,
): Promise<ProviderSearchResult> {
  const key = cacheKey(provider.id, request);
  const cached = await cache.get(key);
  if (cached) {
    log('cache_hit', { provider: provider.id });
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await provider.search(request, { signal: controller.signal });
    await cache.set(key, result, provider.cacheTtlSeconds);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Round-robin merge: first of each provider, then second of each, and so on. */
export function interleave(lists: ImageResult[][], limit: number): ImageResult[] {
  const out: ImageResult[] = [];
  const longest = lists.reduce((max, l) => Math.max(max, l.length), 0);
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) {
        out.push(item);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

function describeError(error: unknown): string {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case 'rate_limited':
        return 'rate limit reached, try again later';
      case 'auth':
        return 'provider rejected the server API key';
      case 'timeout':
        return 'provider did not answer in time';
      case 'network':
        return 'network error reaching the provider';
      case 'upstream':
        return `provider error (HTTP ${error.status ?? 'unknown'})`;
      case 'invalid_response':
        return 'provider returned an unreadable response';
    }
  }
  return 'unexpected error';
}
