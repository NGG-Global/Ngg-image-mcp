/**
 * Shared provider contract.
 *
 * The `search_images` tool only talks to this interface. Adding a new stock
 * image source means adding one module that implements `ImageProvider` and
 * registering it in `src/providers/index.ts`; the tool itself does not change.
 */

export type Orientation = 'horizontal' | 'vertical' | 'all';
export type ImageType = 'photo' | 'illustration' | 'vector' | 'all';

/**
 * Colour vocabulary accepted by the tool. It is the Pixabay list verbatim
 * (https://pixabay.com/api/docs/, `colors` parameter). A provider that cannot
 * honour a requested colour must decline the request in `supports()` rather
 * than return mismatched images.
 */
export const COLORS = [
  'grayscale',
  'transparent',
  'red',
  'orange',
  'yellow',
  'green',
  'turquoise',
  'blue',
  'lilac',
  'pink',
  'white',
  'gray',
  'black',
  'brown',
] as const;
export type Color = (typeof COLORS)[number];

/** Normalised search request handed to every provider. */
export interface SearchRequest {
  /** English keywords. */
  query: string;
  orientation: Orientation;
  imageType: ImageType;
  color?: Color;
  /** Minimum image width in pixels, if the caller asked for one. */
  minWidth?: number;
  /** How many results this provider should return (already divided per provider). */
  perPage: number;
}

/** One image, reduced to what Claude needs to choose and place it. */
export interface ImageResult {
  /** Provider id, e.g. "pixabay". */
  source: string;
  /** Provider-scoped id, kept as a string for JSON stability. */
  id: string;
  /** Short description or comma-separated tags. */
  description: string;
  /** Dimensions of the largest file referenced by `image_url`, when known; otherwise of the original. */
  width: number;
  height: number;
  /** Small preview for choosing between candidates. */
  preview_url: string;
  /** Highest-resolution file the provider allows with the current key. */
  image_url: string;
  /** Which rendition `image_url` points to. */
  image_url_kind: 'original' | 'full_hd_1920' | 'large_1280';
  /** Vector source file when the provider returns one (Pixabay full API access only). */
  vector_url?: string;
  photographer: string;
  photographer_url: string;
  /** Public image page, used for attribution and manual download. */
  page_url: string;
}

export interface ProviderSearchResult {
  results: ImageResult[];
  /** Total matches the provider reports, if any. */
  total?: number;
}

export type ProviderErrorKind = 'rate_limited' | 'auth' | 'upstream' | 'network' | 'timeout' | 'invalid_response';

/** Error raised by a provider. Messages must never contain the query or the API key. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export type SupportDecision = { ok: true } | { ok: false; reason: string };

export interface ImageProvider {
  /** Stable id used in tool input (`source`) and output (`source`). */
  readonly id: string;
  /** Human-readable name. */
  readonly label: string;
  /** Attribution line the provider asks us to show whenever results are displayed. */
  readonly attribution: string;
  /** Home page of the provider, for the attribution link. */
  readonly homepage: string;
  /** How long a successful response must be cached, in seconds (provider terms). */
  readonly cacheTtlSeconds: number;
  /** Decide whether this provider can honour every filter in the request. */
  supports(request: SearchRequest): SupportDecision;
  /** Run the search. Must throw `ProviderError` on failure. */
  search(request: SearchRequest, options: { signal: AbortSignal }): Promise<ProviderSearchResult>;
}
