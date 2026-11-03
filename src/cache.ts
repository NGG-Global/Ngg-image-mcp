/**
 * Response cache.
 *
 * Pixabay's terms state that "requests must be cached for 24 hours". On Vercel
 * the entries live in the Vercel Runtime Cache (regional, LRU-evicted, TTL in
 * seconds, 2 MB per item). Outside Vercel (local dev, tests) `getCache()` from
 * `@vercel/functions` transparently falls back to an in-process map that
 * honours the same TTL.
 *
 * Keys are hashed by `@vercel/functions`, so the query text never appears as a
 * raw cache key in Vercel's observability views.
 */

import { getCache } from '@vercel/functions';
import type { ProviderSearchResult, SearchRequest } from './providers/types.js';

export interface SearchCache {
  get(key: string): Promise<ProviderSearchResult | null>;
  set(key: string, value: ProviderSearchResult, ttlSeconds: number): Promise<void>;
}

const NAMESPACE = 'ngg-image-mcp:v1';

/** Deterministic key: provider id plus the normalised request. */
export function cacheKey(providerId: string, request: SearchRequest): string {
  const normalised = {
    q: request.query.trim().toLowerCase(),
    o: request.orientation,
    t: request.imageType,
    c: request.color ?? '',
    w: request.minWidth ?? 0,
    n: request.perPage,
  };
  return `${providerId}:${JSON.stringify(normalised)}`;
}

export class VercelRuntimeSearchCache implements SearchCache {
  private readonly cache = getCache({ namespace: NAMESPACE });

  async get(key: string): Promise<ProviderSearchResult | null> {
    try {
      const value = await this.cache.get(key);
      return isProviderSearchResult(value) ? value : null;
    } catch {
      // A cache outage must never fail a search.
      return null;
    }
  }

  async set(key: string, value: ProviderSearchResult, ttlSeconds: number): Promise<void> {
    try {
      // `name` is shown in Vercel's cache observability; keep it free of query text.
      await this.cache.set(key, value, { ttl: ttlSeconds, name: 'image-search' });
    } catch {
      // Ignore write failures for the same reason.
    }
  }
}

/** Simple in-memory cache for unit tests. */
export class MemorySearchCache implements SearchCache {
  private readonly entries = new Map<string, { value: ProviderSearchResult; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<ProviderSearchResult | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: ProviderSearchResult, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  get size(): number {
    return this.entries.size;
  }
}

function isProviderSearchResult(value: unknown): value is ProviderSearchResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { results?: unknown }).results);
}
