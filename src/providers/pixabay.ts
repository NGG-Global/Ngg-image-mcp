/**
 * Pixabay provider.
 *
 * Reference: https://pixabay.com/api/docs/ (read on 2026-11-03).
 *
 * Rules from that page that this module implements:
 * - Endpoint `GET https://pixabay.com/api/` with `key`, `q` (URL encoded, max
 *   100 characters), `lang`, `image_type`, `orientation`, `min_width`,
 *   `colors`, `safesearch`, `per_page` (3 to 200).
 * - Rate limit: 100 requests per 60 seconds per key; HTTP 429 on breach.
 * - "requests must be cached for 24 hours" -> `cacheTtlSeconds = 86400`.
 * - With a standard key the largest file is `largeImageURL` (max 1280 px).
 *   `fullHDURL`, `imageURL` and `vectorURL` are only present for accounts
 *   approved for full API access; they are used automatically when present.
 * - Contributor profile URL format: `https://pixabay.com/users/{USERNAME}-{ID}/`.
 */

import {
  ProviderError,
  type ImageProvider,
  type ImageResult,
  type ProviderSearchResult,
  type SearchRequest,
  type SupportDecision,
} from './types.js';

export const PIXABAY_API_URL = 'https://pixabay.com/api/';
const PIXABAY_QUERY_MAX_CHARS = 100;
const PIXABAY_PER_PAGE_MIN = 3;
const PIXABAY_PER_PAGE_MAX = 200;

export interface PixabayHit {
  id: number;
  pageURL: string;
  type: string;
  tags: string;
  previewURL: string;
  previewWidth?: number;
  previewHeight?: number;
  webformatURL: string;
  webformatWidth?: number;
  webformatHeight?: number;
  largeImageURL: string;
  imageWidth?: number;
  imageHeight?: number;
  fullHDURL?: string;
  imageURL?: string;
  vectorURL?: string;
  user_id: number;
  user: string;
}

export interface PixabayResponse {
  total: number;
  totalHits: number;
  hits: PixabayHit[];
}

export interface PixabayProviderOptions {
  apiKey: string;
  /** Override for tests. Defaults to the public API URL. */
  baseUrl?: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** Build the exact query string Pixabay receives. Exported for unit tests. */
export function buildPixabayParams(request: SearchRequest, apiKey: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('q', request.query.trim().slice(0, PIXABAY_QUERY_MAX_CHARS));
  params.set('lang', 'en');
  params.set('image_type', request.imageType);
  params.set('orientation', request.orientation);
  // Always on: the connector is used by a business team and must never surface adult content.
  params.set('safesearch', 'true');
  if (request.minWidth !== undefined && request.minWidth > 0) {
    params.set('min_width', String(Math.floor(request.minWidth)));
  }
  if (request.color !== undefined) {
    params.set('colors', request.color);
  }
  const perPage = Math.min(PIXABAY_PER_PAGE_MAX, Math.max(PIXABAY_PER_PAGE_MIN, Math.floor(request.perPage)));
  params.set('per_page', String(perPage));
  return params;
}

/** Map one Pixabay hit to the shared result type. Exported for unit tests. */
export function mapPixabayHit(hit: PixabayHit): ImageResult {
  // Prefer the largest rendition the key is allowed to see.
  let image_url = hit.largeImageURL;
  let image_url_kind: ImageResult['image_url_kind'] = 'large_1280';
  if (typeof hit.imageURL === 'string' && hit.imageURL.length > 0) {
    image_url = hit.imageURL;
    image_url_kind = 'original';
  } else if (typeof hit.fullHDURL === 'string' && hit.fullHDURL.length > 0) {
    image_url = hit.fullHDURL;
    image_url_kind = 'full_hd_1920';
  }

  const originalWidth = hit.imageWidth ?? hit.webformatWidth ?? 0;
  const originalHeight = hit.imageHeight ?? hit.webformatHeight ?? 0;
  const { width, height } = renditionSize(originalWidth, originalHeight, image_url_kind);

  const result: ImageResult = {
    source: 'pixabay',
    id: String(hit.id),
    description: hit.tags,
    width,
    height,
    preview_url: hit.previewURL,
    image_url,
    image_url_kind,
    photographer: hit.user,
    photographer_url: `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/`,
    page_url: hit.pageURL,
  };
  if (typeof hit.vectorURL === 'string' && hit.vectorURL.length > 0) {
    result.vector_url = hit.vectorURL;
  }
  return result;
}

/**
 * Pixabay scales `largeImageURL` to a maximum of 1280 px and `fullHDURL` to a
 * maximum of 1920 px on the longer edge; the original keeps its size. Report
 * the dimensions of the file we actually point at so Claude can judge whether
 * it is large enough for a slide.
 */
function renditionSize(
  width: number,
  height: number,
  kind: ImageResult['image_url_kind'],
): { width: number; height: number } {
  const maxEdge = kind === 'large_1280' ? 1280 : kind === 'full_hd_1920' ? 1920 : Infinity;
  const longest = Math.max(width, height);
  if (longest === 0 || longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export class PixabayProvider implements ImageProvider {
  readonly id = 'pixabay';
  readonly label = 'Pixabay';
  readonly attribution = 'Images from Pixabay (https://pixabay.com/)';
  readonly homepage = 'https://pixabay.com/';
  readonly cacheTtlSeconds = 24 * 60 * 60;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PixabayProviderOptions) {
    if (!options.apiKey) {
      throw new Error('PixabayProvider requires an API key');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? PIXABAY_API_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  supports(_request: SearchRequest): SupportDecision {
    // Pixabay accepts every orientation, image type and colour in the shared vocabulary.
    return { ok: true };
  }

  async search(request: SearchRequest, options: { signal: AbortSignal }): Promise<ProviderSearchResult> {
    const url = new URL(this.baseUrl);
    url.search = buildPixabayParams(request, this.apiKey).toString();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError('timeout', 'Pixabay request timed out');
      }
      throw new ProviderError('network', `Pixabay request failed: ${errorName(error)}`);
    }

    if (response.status === 429) {
      throw new ProviderError('rate_limited', 'Pixabay rate limit exceeded (100 requests per 60 seconds)', 429);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Pixabay answers 400 with a text body for an invalid key. Do not echo the body.
      throw new ProviderError('auth', `Pixabay rejected the request (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      throw new ProviderError('upstream', `Pixabay returned HTTP ${response.status}`, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError('invalid_response', 'Pixabay returned a non-JSON body', response.status);
    }
    if (!isPixabayResponse(body)) {
      throw new ProviderError('invalid_response', 'Pixabay returned an unexpected JSON shape', response.status);
    }

    return {
      results: body.hits.map(mapPixabayHit),
      total: body.totalHits,
    };
  }
}

function isPixabayResponse(value: unknown): value is PixabayResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v['hits']) && typeof v['totalHits'] === 'number';
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'unknown error';
}
