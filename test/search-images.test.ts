import { describe, expect, it, vi } from 'vitest';
import { MemorySearchCache } from '../src/cache.js';
import {
  ProviderError,
  type ImageProvider,
  type ImageResult,
  type ProviderSearchResult,
  type SearchRequest,
  type SupportDecision,
} from '../src/providers/types.js';
import { buildInputSchema, interleave, searchImages, type SearchImagesInput } from '../src/tool/search-images.js';

function img(source: string, n: number): ImageResult {
  return {
    source,
    id: `${source}-${n}`,
    description: `image ${n}`,
    width: 1920,
    height: 1080,
    preview_url: `https://cdn.example/${source}/${n}_150.jpg`,
    image_url: `https://cdn.example/${source}/${n}_1920.jpg`,
    image_url_kind: 'full_hd_1920',
    photographer: 'Someone',
    photographer_url: `https://example/${source}/users/someone`,
    page_url: `https://example/${source}/${n}`,
  };
}

interface FakeOptions {
  results?: ImageResult[];
  fail?: ProviderError | Error;
  supports?: SupportDecision;
  delayMs?: number;
}

function fakeProvider(id: string, opts: FakeOptions = {}): ImageProvider & { calls: SearchRequest[] } {
  const calls: SearchRequest[] = [];
  return {
    id,
    label: id,
    attribution: `Images from ${id}`,
    homepage: `https://${id}.example/`,
    cacheTtlSeconds: 3600,
    calls,
    supports: () => opts.supports ?? { ok: true },
    async search(request, { signal }): Promise<ProviderSearchResult> {
      calls.push(request);
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new ProviderError('timeout', 'timed out'));
          });
        });
      }
      if (opts.fail) throw opts.fail;
      return { results: opts.results ?? [], total: opts.results?.length ?? 0 };
    },
  };
}

const schema = buildInputSchema(['alpha', 'beta']);
function input(overrides: Partial<SearchImagesInput> = {}): SearchImagesInput {
  return schema.parse({ query: 'mountain lake', ...overrides });
}

describe('input schema', () => {
  it('applies the agreed defaults', () => {
    const parsed = input();
    expect(parsed.orientation).toBe('horizontal');
    expect(parsed.image_type).toBe('photo');
    expect(parsed.source).toBe('all');
    expect(parsed.per_page).toBe(8);
  });

  it('caps per_page at 12 and rejects an empty query', () => {
    expect(() => schema.parse({ query: 'x', per_page: 13 })).toThrow();
    expect(() => schema.parse({ query: '   ' })).toThrow();
    expect(() => schema.parse({ query: 'x', source: 'gamma' })).toThrow();
  });
});

describe('interleave', () => {
  it('alternates between lists and respects the limit', () => {
    const a = [img('a', 1), img('a', 2), img('a', 3)];
    const b = [img('b', 1)];
    const merged = interleave([a, b], 10);
    expect(merged.map((r) => r.id)).toEqual(['a-1', 'b-1', 'a-2', 'a-3']);
    expect(interleave([a, b], 2).map((r) => r.id)).toEqual(['a-1', 'b-1']);
  });

  it('handles empty input', () => {
    expect(interleave([], 5)).toEqual([]);
    expect(interleave([[], []], 5)).toEqual([]);
  });
});

describe('searchImages', () => {
  it('queries providers in parallel, splits per_page and interleaves results', async () => {
    const alpha = fakeProvider('alpha', { results: [img('alpha', 1), img('alpha', 2), img('alpha', 3)] });
    const beta = fakeProvider('beta', { results: [img('beta', 1), img('beta', 2), img('beta', 3)] });
    const out = await searchImages(input({ per_page: 5 }), { providers: [alpha, beta], cache: new MemorySearchCache() });

    expect(alpha.calls[0]?.perPage).toBe(3);
    expect(beta.calls[0]?.perPage).toBe(3);
    expect(out.results.map((r) => r.id)).toEqual(['alpha-1', 'beta-1', 'alpha-2', 'beta-2', 'alpha-3']);
    expect(out.sources_used).toEqual(['alpha', 'beta']);
    expect(out.sources_unavailable).toEqual([]);
    expect(out.attribution).toEqual(['Images from alpha', 'Images from beta']);
    expect(out.usage_note).toMatch(/Never reference the provider URL/);
  });

  it('returns the other provider\'s results when one provider fails, and names the failed source', async () => {
    const alpha = fakeProvider('alpha', { fail: new ProviderError('rate_limited', 'limit', 429) });
    const beta = fakeProvider('beta', { results: [img('beta', 1), img('beta', 2)] });
    const out = await searchImages(input({ per_page: 4 }), { providers: [alpha, beta], cache: new MemorySearchCache() });

    expect(out.results.map((r) => r.id)).toEqual(['beta-1', 'beta-2']);
    expect(out.sources_used).toEqual(['beta']);
    expect(out.sources_unavailable).toEqual([{ source: 'alpha', reason: 'rate limit reached, try again later' }]);
  });

  it('does not throw when every provider is down', async () => {
    const alpha = fakeProvider('alpha', { fail: new ProviderError('network', 'down') });
    const out = await searchImages(input(), { providers: [alpha], cache: new MemorySearchCache() });
    expect(out.results).toEqual([]);
    expect(out.sources_used).toEqual([]);
    expect(out.sources_unavailable).toEqual([{ source: 'alpha', reason: 'network error reaching the provider' }]);
  });

  it('treats a non-ProviderError failure as unexpected without leaking its message', async () => {
    const alpha = fakeProvider('alpha', { fail: new Error('stack trace with q=secret') });
    const out = await searchImages(input(), { providers: [alpha], cache: new MemorySearchCache() });
    expect(out.sources_unavailable[0]?.reason).toBe('unexpected error');
  });

  it('times out a slow provider and keeps the fast one', async () => {
    const slow = fakeProvider('alpha', { delayMs: 500, results: [img('alpha', 1)] });
    const fast = fakeProvider('beta', { results: [img('beta', 1)] });
    const out = await searchImages(input(), { providers: [slow, fast], cache: new MemorySearchCache(), timeoutMs: 20 });
    expect(out.results.map((r) => r.id)).toEqual(['beta-1']);
    expect(out.sources_unavailable).toEqual([{ source: 'alpha', reason: 'provider did not answer in time' }]);
  });

  it('skips a provider that cannot honour a filter instead of returning mismatched images', async () => {
    const alpha = fakeProvider('alpha', { results: [img('alpha', 1)] });
    const beta = fakeProvider('beta', { supports: { ok: false, reason: 'does not offer illustrations' }, results: [img('beta', 1)] });
    const out = await searchImages(input({ image_type: 'illustration' }), { providers: [alpha, beta], cache: new MemorySearchCache() });
    expect(beta.calls).toHaveLength(0);
    expect(alpha.calls[0]?.perPage).toBe(8); // the whole budget goes to the remaining provider
    expect(out.sources_skipped).toEqual([{ source: 'beta', reason: 'does not offer illustrations' }]);
    expect(out.results.map((r) => r.id)).toEqual(['alpha-1']);
  });

  it('honours source=<id>', async () => {
    const alpha = fakeProvider('alpha', { results: [img('alpha', 1)] });
    const beta = fakeProvider('beta', { results: [img('beta', 1)] });
    const out = await searchImages(input({ source: 'beta' }), { providers: [alpha, beta], cache: new MemorySearchCache() });
    expect(alpha.calls).toHaveLength(0);
    expect(out.results.map((r) => r.id)).toEqual(['beta-1']);
  });

  it('reports providers that are known but not configured', async () => {
    const alpha = fakeProvider('alpha', { results: [img('alpha', 1)] });
    const out = await searchImages(input(), { providers: [alpha], unconfigured: ['beta'], cache: new MemorySearchCache() });
    expect(out.sources_unavailable).toEqual([{ source: 'beta', reason: 'not configured on the server (missing API key)' }]);
    expect(out.results).toHaveLength(1);
  });

  it('passes the colour and min_width filters through to providers', async () => {
    const alpha = fakeProvider('alpha');
    await searchImages(input({ color: 'blue', min_width: 1600, orientation: 'vertical' }), {
      providers: [alpha],
      cache: new MemorySearchCache(),
    });
    expect(alpha.calls[0]).toMatchObject({ query: 'mountain lake', color: 'blue', minWidth: 1600, orientation: 'vertical', imageType: 'photo' });
  });

  it('serves repeat searches from the cache for the provider TTL', async () => {
    let now = 1_000_000;
    const cache = new MemorySearchCache(() => now);
    const alpha = fakeProvider('alpha', { results: [img('alpha', 1)] });
    const log = vi.fn();

    await searchImages(input(), { providers: [alpha], cache, log });
    await searchImages(input({ query: '  Mountain Lake ' }), { providers: [alpha], cache, log });
    expect(alpha.calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('cache_hit', { provider: 'alpha' });

    now += (alpha.cacheTtlSeconds + 1) * 1000;
    await searchImages(input(), { providers: [alpha], cache, log });
    expect(alpha.calls).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    const cache = new MemorySearchCache();
    const alpha = fakeProvider('alpha', { fail: new ProviderError('upstream', 'boom', 502) });
    await searchImages(input(), { providers: [alpha], cache });
    expect(cache.size).toBe(0);
  });

  it('never passes query text to the logger', async () => {
    const log = vi.fn();
    const alpha = fakeProvider('alpha', { results: [img('alpha', 1)] });
    await searchImages(input({ query: 'very secret keywords' }), { providers: [alpha], cache: new MemorySearchCache(), log });
    for (const call of log.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret keywords');
    }
  });
});
