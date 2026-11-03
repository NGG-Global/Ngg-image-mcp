import { describe, expect, it, vi } from 'vitest';
import { buildPixabayParams, mapPixabayHit, PixabayProvider, type PixabayHit, type PixabayResponse } from '../src/providers/pixabay.js';
import { ProviderError, type SearchRequest } from '../src/providers/types.js';

const baseRequest: SearchRequest = {
  query: 'team meeting office',
  orientation: 'horizontal',
  imageType: 'photo',
  perPage: 4,
};

/** Shape taken from the example response on https://pixabay.com/api/docs/ */
const standardHit: PixabayHit = {
  id: 195893,
  pageURL: 'https://pixabay.com/en/blossom-bloom-flower-195893/',
  type: 'photo',
  tags: 'blossom, bloom, flower',
  previewURL: 'https://cdn.pixabay.com/photo/2013/10/15/09/12/flower-195893_150.jpg',
  previewWidth: 150,
  previewHeight: 84,
  webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
  webformatWidth: 640,
  webformatHeight: 360,
  largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
  imageWidth: 4000,
  imageHeight: 2250,
  user_id: 48777,
  user: 'Josch13',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('buildPixabayParams', () => {
  it('maps every supported filter and forces safe search and English', () => {
    const params = buildPixabayParams(
      { ...baseRequest, color: 'blue', minWidth: 1920, imageType: 'illustration', orientation: 'vertical' },
      'KEY',
    );
    expect(params.get('key')).toBe('KEY');
    expect(params.get('q')).toBe('team meeting office');
    expect(params.get('lang')).toBe('en');
    expect(params.get('safesearch')).toBe('true');
    expect(params.get('image_type')).toBe('illustration');
    expect(params.get('orientation')).toBe('vertical');
    expect(params.get('colors')).toBe('blue');
    expect(params.get('min_width')).toBe('1920');
    expect(params.get('per_page')).toBe('4');
  });

  it('omits optional filters that were not requested', () => {
    const params = buildPixabayParams(baseRequest, 'KEY');
    expect(params.has('colors')).toBe(false);
    expect(params.has('min_width')).toBe(false);
  });

  it('truncates the query to the documented 100-character maximum', () => {
    const params = buildPixabayParams({ ...baseRequest, query: 'x'.repeat(150) }, 'KEY');
    expect(params.get('q')).toHaveLength(100);
  });

  it('clamps per_page to the documented 3..200 range', () => {
    expect(buildPixabayParams({ ...baseRequest, perPage: 1 }, 'KEY').get('per_page')).toBe('3');
    expect(buildPixabayParams({ ...baseRequest, perPage: 500 }, 'KEY').get('per_page')).toBe('200');
  });
});

describe('mapPixabayHit', () => {
  it('uses largeImageURL (max 1280 px) with a standard key and scales the reported size', () => {
    const result = mapPixabayHit(standardHit);
    expect(result).toMatchObject({
      source: 'pixabay',
      id: '195893',
      description: 'blossom, bloom, flower',
      preview_url: standardHit.previewURL,
      image_url: standardHit.largeImageURL,
      image_url_kind: 'large_1280',
      photographer: 'Josch13',
      photographer_url: 'https://pixabay.com/users/Josch13-48777/',
      page_url: standardHit.pageURL,
    });
    // 4000x2250 scaled to a 1280 px longest edge.
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.vector_url).toBeUndefined();
  });

  it('prefers imageURL, then fullHDURL, when full API access fields are present', () => {
    const full = mapPixabayHit({
      ...standardHit,
      fullHDURL: 'https://pixabay.com/get/full_1920.jpg',
      imageURL: 'https://pixabay.com/get/original.jpg',
      vectorURL: 'https://pixabay.com/get/original.svg',
    });
    expect(full.image_url).toBe('https://pixabay.com/get/original.jpg');
    expect(full.image_url_kind).toBe('original');
    expect(full.width).toBe(4000);
    expect(full.height).toBe(2250);
    expect(full.vector_url).toBe('https://pixabay.com/get/original.svg');

    const hd = mapPixabayHit({ ...standardHit, fullHDURL: 'https://pixabay.com/get/full_1920.jpg' });
    expect(hd.image_url).toBe('https://pixabay.com/get/full_1920.jpg');
    expect(hd.image_url_kind).toBe('full_hd_1920');
    expect(hd.width).toBe(1920);
    expect(hd.height).toBe(1080);
  });

  it('does not upscale images already smaller than the rendition limit', () => {
    const small = mapPixabayHit({ ...standardHit, imageWidth: 1000, imageHeight: 500 });
    expect(small.width).toBe(1000);
    expect(small.height).toBe(500);
  });
});

describe('PixabayProvider.search', () => {
  it('calls the API with the key and returns mapped results', async () => {
    const body: PixabayResponse = { total: 1, totalHits: 1, hits: [standardHit] };
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin + url.pathname).toBe('https://pixabay.com/api/');
      expect(url.searchParams.get('key')).toBe('SECRET-KEY');
      expect(url.searchParams.get('safesearch')).toBe('true');
      return jsonResponse(body);
    });
    const provider = new PixabayProvider({ apiKey: 'SECRET-KEY', fetch: fetchMock as unknown as typeof fetch });

    const out = await provider.search(baseRequest, { signal: new AbortController().signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.total).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.id).toBe('195893');
  });

  it.each([
    [429, 'rate_limited'],
    [400, 'auth'],
    [403, 'auth'],
    [500, 'upstream'],
    [503, 'upstream'],
  ])('maps HTTP %s to a ProviderError of kind %s', async (status, kind) => {
    const provider = new PixabayProvider({
      apiKey: 'K',
      fetch: (async () => new Response('[ERROR 400] "key" is invalid', { status })) as unknown as typeof fetch,
    });
    const error = await provider.search(baseRequest, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(kind);
    expect((error as ProviderError).status).toBe(status);
    // The message must not leak the upstream body or the key.
    expect((error as ProviderError).message).not.toContain('invalid');
    expect((error as ProviderError).message).not.toContain('K=');
  });

  it('reports a timeout when the abort signal fires', async () => {
    const controller = new AbortController();
    const provider = new PixabayProvider({
      apiKey: 'K',
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })) as unknown as typeof fetch,
    });
    const pending = provider.search(baseRequest, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('timeout');
  });

  it('reports a network error when fetch rejects', async () => {
    const provider = new PixabayProvider({
      apiKey: 'K',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const error = await provider.search(baseRequest, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('network');
  });

  it('rejects an unexpected JSON shape', async () => {
    const provider = new PixabayProvider({
      apiKey: 'K',
      fetch: (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch,
    });
    const error = await provider.search(baseRequest, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('invalid_response');
  });

  it('refuses to construct without a key', () => {
    expect(() => new PixabayProvider({ apiKey: '' })).toThrow();
  });
});
