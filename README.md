# NGG Image MCP

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude one read-only tool, `search_images`, for finding free stock images. It currently searches **Pixabay**. It is built to be added as an organization-wide custom connector in NGG's claude.ai account so that team members can place stock images into decks and designs made with Claude Design.

- TypeScript, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), Streamable HTTP transport, stateless.
- Deployed as a single Vercel Function from this repository.
- Provider abstraction: one module per image library, a shared result type, and a merge step that queries every configured provider in parallel. Adding a library does not change the tool.
- Server-side response cache (24 hours, Vercel Runtime Cache) as Pixabay's terms require.

## Contents

1. [How it works](#how-it-works)
2. [Setup, step by step](#setup-step-by-step)
3. [Connector URL and admin steps](#connector-url-and-admin-steps)
4. [Allowed network domains](#allowed-network-domains)
5. [The `search_images` tool](#the-search_images-tool)
6. [Provider terms and how this server complies](#provider-terms-and-how-this-server-complies)
7. [Security](#security)
8. [Local development and testing](#local-development-and-testing)
9. [Adding another provider](#adding-another-provider)
10. [Known limitations and unverified items](#known-limitations-and-unverified-items)

## How it works

```
Claude (claude.ai / Claude Design)
   │  Streamable HTTP, JSON-RPC
   ▼
https://<deployment>/mcp/<CONNECTOR_SECRET>      api/index.ts  → src/server.ts
   │  404 for any other path
   ▼
search_images tool                               src/tool/search-images.ts
   │  fan-out to every configured provider, 8 s timeout each
   ├─ cache lookup (24 h TTL)                     src/cache.ts
   ▼
Pixabay provider                                 src/providers/pixabay.ts
   GET https://pixabay.com/api/?key=…&q=…&safesearch=true&lang=en…
```

Each request to the function builds a fresh MCP server instance (the SDK's per-request model), so the deployment holds no session state and scales with Vercel's Fluid compute.

## Setup, step by step

### Prerequisites

- Node.js 22 (the `engines` field pins `22.x`; Vercel supports 22, 24 and 26).
- A Vercel account with access to the NGG team, and this GitHub repository connected to it.
- Owner access to the NGG claude.ai organization for the final connector step.

### Step 1: Get a Pixabay API key

1. Create or sign in to a Pixabay account at <https://pixabay.com/accounts/login/>. Use a shared NGG account, not a personal one, because the key is the organization's credential.
2. Open <https://pixabay.com/api/docs/>. While signed in, the page shows your API key in the `key` parameter row of the "Search Images" section.
3. Copy the key. This is the value of `PIXABAY_API_KEY`.
4. A standard key returns images up to 1280 px on the longest edge (`largeImageURL`). Full-resolution fields (`fullHDURL`, `imageURL`, `vectorURL`) are only returned for accounts approved for "full API access". The server uses them automatically when they appear, so applying for full access later needs no code change. The docs page says to contact Pixabay for higher limits and full access once the API is "implemented properly".

Use exactly one key for this deployment. Pixabay's limit is per key, and creating several keys to raise the limit would breach the "do not abuse the API" rule.

### Step 2: Generate the connector secret

The MCP endpoint is only reachable at a path that contains a secret. Generate a long random value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

This is the value of `CONNECTOR_SECRET`. Store it in a password manager; it is needed twice, once in Vercel and once in the connector URL.

### Step 3: Deploy on Vercel

1. In the Vercel dashboard select **Add New… > Project** and import this GitHub repository.
2. Leave **Framework Preset** on "Other". The `build` script only runs a type check; Vercel compiles `api/index.ts` itself.
3. Under **Environment Variables** add, for the Production environment (and Preview if you want preview deployments to work):

   | Name | Value |
   | --- | --- |
   | `PIXABAY_API_KEY` | the key from Step 1 |
   | `CONNECTOR_SECRET` | the value from Step 2 |

   Do not add these to the repository, `.env.example`, or `vercel.json`.
4. Click **Deploy**. When it finishes, note the production URL, for example `https://ngg-image-mcp.vercel.app`. A custom domain can be attached later under **Settings > Domains** without changing anything in the code.
5. Vercel's **Node.js Version** project setting is overridden by `package.json` (`22.x`). Fluid compute is on by default for new projects; keep it on.
6. Every later push to the branch connected to Production redeploys automatically.

### Step 4: Verify the deployment

Replace the host and secret in the commands below.

```bash
# 1. Any other path must answer 404
curl -s -o /dev/null -w "%{http_code}\n" https://ngg-image-mcp.vercel.app/
curl -s -o /dev/null -w "%{http_code}\n" https://ngg-image-mcp.vercel.app/mcp

# 2. The secret path must list exactly one tool
npx @modelcontextprotocol/inspector@latest --cli \
  "https://ngg-image-mcp.vercel.app/mcp/<CONNECTOR_SECRET>" --transport http --method tools/list

# 3. A real search
npx @modelcontextprotocol/inspector@latest --cli \
  "https://ngg-image-mcp.vercel.app/mcp/<CONNECTOR_SECRET>" --transport http \
  --method tools/call --tool-name search_images \
  --tool-arg query="team meeting office" --tool-arg per_page=3
```

The third command should return `sources_used: ["pixabay"]` and three results. If it returns `sources_unavailable` with "provider rejected the server API key", the `PIXABAY_API_KEY` value is wrong.

## Connector URL and admin steps

Give the organization Owner this URL (one line, no trailing slash):

```
https://<your-deployment-host>/mcp/<CONNECTOR_SECRET>
```

Example: `https://ngg-image-mcp.vercel.app/mcp/Qm3f…Zx9`.

Steps for the Owner, taken from Anthropic's "Add a connector that isn't in the directory" page:

1. Go to **Organization settings > Connectors** (<https://claude.ai/admin-settings/connectors>).
2. Select **Add**, then **Custom**. If asked for the connector type, choose **Web**.
3. Enter the URL above as the **MCP server URL**.
4. Under **Authentication** choose **No sign-in**. The secret in the path is the credential. Leave OAuth fields empty.
5. Click **Add**. The connector appears for members under **Customize > Connectors** with the **Custom** label; each member clicks **Connect** once.
6. In a chat or a Claude Design session, enable it from **+ > Connectors**. Because the tool is annotated `readOnlyHint: true`, Claude can call it without a confirmation prompt on every call.

Alternative for organizations that have the **Request headers** beta: enter `https://<host>/mcp` as the URL, choose **No sign-in**, and add a request header `x-api-key` with the secret as its value. The server accepts either method. Authentication settings cannot be edited after the connector is added; remove and re-add it to change them.

To rotate the secret: set a new `CONNECTOR_SECRET` in Vercel, redeploy, then remove and re-add the connector with the new URL.

## Allowed network domains

The server, not Claude, calls the Pixabay API. Claude only needs to download the image files that the tool returns. Those files are served from these hosts (taken from the example responses on <https://pixabay.com/api/docs/>):

| Host | Used for |
| --- | --- |
| `cdn.pixabay.com` | `previewURL` (the small preview) |
| `pixabay.com` | `largeImageURL`, `webformatURL`, `fullHDURL`, `imageURL` (the files Claude embeds) and the image pages |

Add both hosts to the organization's allowed domains. If only `cdn.pixabay.com` is allowed, previews will load but the full-size downloads from `pixabay.com/get/…` may be blocked. Confirm the actual hosts from a live response during the pilot, because Pixabay documents the hostnames only through examples.

Where to add them: Anthropic's help article "Create and edit files with Claude" describes the setting at **Organization settings > Capabilities** (<https://claude.ai/admin-settings/capabilities>) under "Code execution and file creation", option "Package managers plus specific domains". We could not find an official page stating that this same setting governs image downloads in Claude Design. Treat the location as unverified until the admin confirms it in the console.

## The `search_images` tool

Inputs:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `query` | string, 1 to 100 chars | required | English keywords. The description tells Claude to translate Hebrew first. Pixabay caps queries at 100 characters. |
| `orientation` | `horizontal` / `vertical` / `all` | `horizontal` | Mapped 1:1 to Pixabay `orientation`. |
| `image_type` | `photo` / `illustration` / `vector` / `all` | `photo` | Mapped 1:1 to Pixabay `image_type`. |
| `color` | one of Pixabay's colour names | none | `grayscale, transparent, red, orange, yellow, green, turquoise, blue, lilac, pink, white, gray, black, brown`. |
| `min_width` | integer px | none | Pixabay `min_width`. |
| `source` | `pixabay` / `all` | `all` | Grows automatically when providers are added. |
| `per_page` | 1 to 12 | 8 | Total across sources. Each provider is asked for `ceil(per_page / active providers)`. |

Fixed on every Pixabay request: `safesearch=true`, `lang=en`.

Output (`structuredContent`, mirrored as JSON text in `content`):

```json
{
  "results": [
    {
      "source": "pixabay",
      "id": "195893",
      "description": "blossom, bloom, flower",
      "width": 1280,
      "height": 720,
      "preview_url": "https://cdn.pixabay.com/photo/.../flower-195893_150.jpg",
      "image_url": "https://pixabay.com/get/..._1280.jpg",
      "image_url_kind": "large_1280",
      "photographer": "Josch13",
      "photographer_url": "https://pixabay.com/users/Josch13-48777/",
      "page_url": "https://pixabay.com/en/blossom-bloom-flower-195893/"
    }
  ],
  "sources_used": ["pixabay"],
  "sources_unavailable": [],
  "sources_skipped": [],
  "attribution": ["Images from Pixabay (https://pixabay.com/)"],
  "usage_note": "Download the image file from image_url and embed ..."
}
```

- `image_url` is always the highest-resolution file the key allows. `image_url_kind` is `large_1280` with a standard key, and `full_hd_1920` or `original` when Pixabay returns those fields. `vector_url` is added when present.
- `width` and `height` describe the file at `image_url`, so Claude can judge whether it is large enough for the placement.
- If a provider fails (rate limit, outage, bad key, timeout), the call still succeeds: results from the other providers are returned and the failed one is listed in `sources_unavailable` with a short reason.
- If a provider cannot honour a filter (for example a library without illustrations), it is listed in `sources_skipped` and not queried, rather than returning mismatched images.
- Twelve results are roughly 6 KB, far below Claude's 150,000-character tool-result limit. Each provider call has an 8-second timeout, far below Claude's 240-second tool-call limit.

## Provider terms and how this server complies

All quotations are from <https://pixabay.com/api/docs/> as read on 2026-11-03. Pixabay can change these terms; re-read the page before changing the caching or attribution behaviour.

| Pixabay rule (quoted) | What the server does |
| --- | --- |
| "To keep the Pixabay API fast for everyone, requests must be cached for 24 hours." | Every successful response is stored in the Vercel Runtime Cache with a 24-hour TTL, keyed by provider and normalised parameters (`src/cache.ts`). Repeated searches within 24 hours never reach Pixabay. Failures are not cached. |
| Rate limit: "100 requests per 60 seconds" per key; HTTP 429 "API rate limit exceeded". | One key, one deployment. A 429 is reported to Claude as "rate limit reached, try again later" and the call still returns results from other providers. No retries, no second key. |
| "Systematic mass downloads are not allowed." / "do not send lots of automated queries" | The tool only runs when a person asks Claude for images, returns at most 12 results, and caches for 24 hours. |
| "Returned image URLs may be used for temporarily displaying search results. However, permanent hotlinking of images (using Pixabay URLs in your app) is not allowed. If you intend to use the images, please download them to your server first." | Pixabay URLs are only used to show search candidates. The tool description and the `usage_note` field instruct Claude to download the file and embed or upload it into the design or document, and never to reference the Pixabay URL in the final output. Published Claude designs do not load images from external URLs, so embedding is the only supported flow. This is the compliance basis for using the API inside Claude Design and in exported PPTX files: the exported file contains the image bytes, not a link to Pixabay. |
| "If you make use of the API, show your users where the images and videos are from, whenever search results are displayed." | Every response carries an `attribution` array ("Images from Pixabay (https://pixabay.com/)") and the tool description asks Claude to keep it visible when presenting results. |
| `safesearch`: "only images suitable for all ages should be returned" | Always sent as `true`. |
| Full API access fields (`fullHDURL`, `imageURL`, `vectorURL`) "are only available if your account is approved for full API access". | Used when present, otherwise `largeImageURL` (max 1280 px). |

Image licence: the Pixabay Content License summary (<https://pixabay.com/service/license-summary/>) states that content may be used for free, modified, and used without attributing the author, and that it must not be sold or distributed on a standalone basis, used as part of a trademark, or used in a misleading or immoral way; content showing trademarks or logos must not be used commercially in relation to goods and services. Attribution is therefore optional under the licence, but the API documentation separately asks for the source to be shown whenever results are displayed, which this server does. Use in client presentations is permitted as long as the image is combined with other elements into a new work. NGG's legal reviewer should confirm this reading against the full Terms of Service before client use.

## Security

- **Secrets** live only in Vercel environment variables: `PIXABAY_API_KEY` and `CONNECTOR_SECRET`. `.env` is ignored by git; `.env.example` contains no values.
- **Endpoint protection**: only `/mcp/<CONNECTOR_SECRET>` (or `/mcp` with header `x-api-key: <CONNECTOR_SECRET>`) reaches the MCP handler. Every other path, including `/api/index`, answers `404 Not found`. The comparison is constant-time. If `CONNECTOR_SECRET` is unset, every request is a 404.
- **Vercel request logs record the request path**, so the secret is visible to anyone who can read the project's runtime logs. Limit log access to the project owner (Vercel **Settings > Members**, and avoid sharing the project with roles that can view logs). Anthropic's own guidance prefers credentials in request headers over URLs; switch to the `x-api-key` header method once the organization has the request-headers beta.
- **No sensitive logging**: application logs contain the provider id, timing, result count and a generic reason. Search queries, the API key, and the secret path are never written by application code.
- **Cache observability**: cache keys are hashed by `@vercel/functions` and entries are named `image-search`, so query text does not appear in the Vercel cache dashboard.
- **Read-only**: the tool is annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

## Local development and testing

```bash
npm install                 # .npmrc sets legacy-peer-deps=true (vitest's peer set trips npm 10's resolver)
cp .env.example .env        # fill in PIXABAY_API_KEY and CONNECTOR_SECRET
npm run typecheck
npm test                    # 43 unit and end-to-end tests with mocked Pixabay responses
npm run dev                 # http://127.0.0.1:3000/mcp/<CONNECTOR_SECRET>
```

With the dev server running, test it with the MCP Inspector:

```bash
# list tools
npx @modelcontextprotocol/inspector@latest --cli "http://127.0.0.1:3000/mcp/<CONNECTOR_SECRET>" \
  --transport http --method tools/list

# call the tool
npx @modelcontextprotocol/inspector@latest --cli "http://127.0.0.1:3000/mcp/<CONNECTOR_SECRET>" \
  --transport http --method tools/call --tool-name search_images \
  --tool-arg query="mountain lake" --tool-arg per_page=3

# header method
npx @modelcontextprotocol/inspector@latest --cli "http://127.0.0.1:3000/mcp" \
  --transport http --header "x-api-key: <CONNECTOR_SECRET>" --method tools/list

# graphical inspector (Streamable HTTP, paste the URL above)
npx @modelcontextprotocol/inspector@latest
```

Provider-down test: start the dev server with an invalid `PIXABAY_API_KEY` and call the tool. The result is a normal (non-error) response with `sources_unavailable: [{ "source": "pixabay", "reason": "provider rejected the server API key" }]`. Timeouts and HTTP 5xx are covered the same way in `test/search-images.test.ts` and `test/server.test.ts`.

Outside Vercel, `getCache()` falls back to an in-process cache with the same TTL, which is what the dev server and the tests use.

## Adding another provider

1. Create `src/providers/<name>.ts` implementing `ImageProvider` from `src/providers/types.ts`:
   - `supports(request)` returns `{ ok: false, reason }` for any filter the library cannot honour (for example illustrations, or a colour outside its vocabulary). The tool then skips it for that request.
   - `search(request, { signal })` maps the shared request to the library's parameters, forces safe search if the library offers it, and returns `ImageResult[]`. Throw `ProviderError` with a kind (`rate_limited`, `auth`, `upstream`, `network`, `timeout`, `invalid_response`); never include the query or key in messages.
   - Set `cacheTtlSeconds` to whatever the library's terms require, and `attribution` to the line the library asks you to show.
2. Register it in `src/providers/index.ts` (read its key from an environment variable, push the instance) and add its id to `KNOWN_PROVIDER_IDS`.
3. Add the key to `.env.example` and to the Vercel environment, and add the library's image hosts to the allowed-domains list above.
4. Write unit tests for the mapping (see `test/pixabay.test.ts`). The merge logic and server tests already cover multi-provider behaviour with fake providers.

Nothing in `src/tool/search-images.ts` or `src/server.ts` changes.

## Known limitations and unverified items

- **Pixabay only.** Pexels was dropped because new Pexels API keys are not currently being issued.
- **Cache eviction.** Vercel Runtime Cache is regional, LRU-evicted and documented as unsuitable for data that must survive its full TTL. Under memory pressure an entry can be evicted before 24 hours, which would cause a repeat request to Pixabay. For strict compliance at higher volumes, the upgrade path is a Redis store (for example Upstash through the Vercel Marketplace) behind the same `SearchCache` interface in `src/cache.ts`.
- **Vercel plan.** This project runs on the Vercel `[PLAN]` plan (fill in). On Hobby the Runtime Cache is shared by all projects in the team; on Pro and Enterprise each project has its own.
- **Image hostnames** come from the example responses in Pixabay's documentation, not from a stated rule. Confirm them from a live response during the pilot.
- **Claude Design network setting.** No official page was found that states which organization setting controls image downloads in Claude Design. The Capabilities location above is the documented setting for code execution and file creation, and is flagged as unverified.
- **Pixabay full API access** and its approval process were not tested; the code handles the extra fields when they appear.
- **Live Pixabay success path** was exercised only with mocked responses in tests. The live call path was verified with an invalid key (Pixabay answered HTTP 400, mapped to a graceful "provider rejected the server API key"). Run Step 4 after setting the real key.
- **Vercel deployment** was not performed from this repository yet; the configuration follows Vercel's current Functions documentation (web-standard `fetch` export in `api/`, `vercel.json` rewrites, `maxDuration`).
