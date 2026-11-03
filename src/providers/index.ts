/**
 * Provider registry.
 *
 * Builds the list of configured providers from environment variables. A
 * provider whose key is missing is simply not registered, so the server still
 * starts and the tool reports it as unavailable.
 */

import { PixabayProvider } from './pixabay.js';
import type { ImageProvider } from './types.js';

export interface ProviderEnv {
  PIXABAY_API_KEY?: string | undefined;
}

export interface ProviderRegistry {
  providers: ImageProvider[];
  /** Ids of providers that are known to this build but have no key configured. */
  unconfigured: string[];
}

export function buildProviders(env: ProviderEnv = process.env): ProviderRegistry {
  const providers: ImageProvider[] = [];
  const unconfigured: string[] = [];

  const pixabayKey = env.PIXABAY_API_KEY?.trim();
  if (pixabayKey) {
    providers.push(new PixabayProvider({ apiKey: pixabayKey }));
  } else {
    unconfigured.push('pixabay');
  }

  // To add a provider: implement `ImageProvider` in its own module, read its key
  // here, and push it. The tool, cache and tests for merging do not change.

  return { providers, unconfigured };
}

/** All provider ids this build knows about, used for the `source` enum. */
export const KNOWN_PROVIDER_IDS = ['pixabay'] as const;
