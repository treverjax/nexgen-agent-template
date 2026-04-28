# NexGen Agent Template

An open-source starter for building an AI Gateway-powered chat / RAG / image-generation Worker on Cloudflare. The bundled frontend demonstrates streaming chat with Cloudflare docs RAG (via Vectorize), image generation through Replicate (FLUX, Recraft, Ideogram, Nano Banana Pro) and video generation (Kling, Wan), all routed through Cloudflare AI Gateway.

This is the cleaned-up, parameterized version of the demo deployed at `nexgenagents.co`. Configure your bindings, set your secrets, and deploy.

## Architecture

- **Cloudflare Workers** — request routing, auth middleware, streaming responses
- **AI Gateway** — single entry point for Workers AI + Replicate calls (analytics, caching, rate limiting)
- **Workers AI** — chat models (Qwen, Llama) and embeddings (`bge-large-en-v1.5`)
- **Vectorize** — RAG index over Cloudflare's public docs
- **R2** — stores generated images and saved SVG diagrams
- **Replicate** — image and video models via AI Gateway

## Prerequisites

- Cloudflare account with Workers, Workers AI, AI Gateway, R2, and Vectorize enabled
- Node.js 18+ and npm
- Wrangler 4 (`npm install` will pick it up)
- (Optional) Replicate account, with API token stored as a provider key inside your AI Gateway
- (Optional) GitHub Personal Access Token if you want to run the docs ingestion script

## Setup

### 1. Clone and install

```bash
git clone <this-repo>
cd nexgen-agent-template
npm install
```

### 2. Create Cloudflare resources

Run these once against your account:

```bash
# AI Gateway: create one in the dashboard, note the slug (e.g. "my-gateway").
# In the gateway settings, add Replicate as a provider and store your Replicate API token there.

# R2 bucket for generated assets
npx wrangler r2 bucket create my-nexgen-assets

# Vectorize index for the docs RAG (1024 dimensions for bge-large-en-v1.5)
npx wrangler vectorize create my-nexgen-index --dimensions=1024 --metric=cosine
```

### 3. Fill in `wrangler.jsonc`

Replace every `<PLACEHOLDER>` with your own values:

| Placeholder | Where to find it |
|---|---|
| `<YOUR_DOMAIN>` | A domain you've added to Cloudflare. Remove the `routes` block to deploy on `*.workers.dev`. |
| `<YOUR_R2_BUCKET_NAME>` | The bucket you created above. |
| `<YOUR_VECTORIZE_INDEX_NAME>` | The Vectorize index you created above. |
| `<YOUR_CLOUDFLARE_ACCOUNT_ID>` | Top of any Cloudflare dashboard page. |
| `<YOUR_AI_GATEWAY_ID>` | The slug of the AI Gateway you created. |

`ALLOWED_ORIGIN` should be set to your production frontend origin (e.g. `https://example.com`). For local dev, the worker echoes the incoming `Origin`.

### 4. Set secrets

```bash
# AI Gateway authenticated token — see the Gateway settings page for how to generate.
npx wrangler secret put CF_GATEWAY_TOKEN

# Bearer tokens this Worker will accept on /api/* and /chat. Comma-separated.
# Generate with: openssl rand -base64 32
npx wrangler secret put API_KEYS

# Optional, only if you'll run the docs ingestion script.
npx wrangler secret put GITHUB_TOKEN
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it in.

### 5. Wire the frontend to a key

The bundled frontend at `public/index.html` reads a hardcoded Bearer token to call its own backend. Open the file and replace `REPLACE_ME_WITH_AN_ENTRY_FROM_API_KEYS` near the top of the `<script>` block with one of the values you set in `API_KEYS`.

For anything beyond a demo we strongly recommend putting **Cloudflare Access** in front of the Worker route and removing the in-page key entirely — Access provides SSO, short-lived JWTs, and per-user audit logs without any code changes.

### 6. Populate the docs index (optional but recommended)

The chat will work without it, but RAG-augmented answers about Cloudflare products are much better with the index populated. After deploy:

```bash
curl -X POST https://<your-domain>/api/v1/ingest-docs \
  -H "Authorization: Bearer <one-of-your-API_KEYS>" \
  -H "Content-Type: application/json" \
  -d '{"paths":["src/content/docs/ai-gateway","src/content/docs/workers-ai"],"maxFilesPerPath":50}'
```

See `VECTORIZE_SETUP.md` for the full ingestion guide.

### 7. Build and deploy

```bash
npm run deploy
```

This runs Tailwind to produce `public/styles.css`, then `wrangler deploy`.

## Local development

```bash
npm run dev
```

Visit `http://localhost:8787`. Make sure `.dev.vars` has at least `CF_GATEWAY_TOKEN` and `API_KEYS` set.

## Endpoints

All `/api/*` and `/chat` routes require `Authorization: Bearer <key>` matching one entry in `API_KEYS`.

| Route | Method | Description |
|---|---|---|
| `/api/v1/chat` (also `/chat`, `/api/chat`) | POST | Streaming chat with optional RAG |
| `/api/v1/transcribe` | POST | Audio transcription via Whisper |
| `/api/v1/save-image` | POST | Save image URL or SVG content to R2 |
| `/api/v1/assets/<filename>` | GET | Serve a saved asset (public) |
| `/api/v1/ingest-docs` | POST | Run docs ingestion into Vectorize |
| `/api/v1/query-docs` | POST | Query the docs vector index |

## Customization

- **System prompt** — `SYSTEM_PROMPT` constant at the top of `src/index.js`
- **Models** — `MODELS` map inside `internalImageCall` in `src/index.js`
- **Topic detection / routing** — `CLOUDFLARE_TOPIC_PATTERNS` constant in `src/index.js`
- **Frontend theme** — `tailwind.config.js` and `public/index.html`

## Security notes

- **Always set `API_KEYS`.** The Worker fails closed if it's empty — every authenticated route returns 401.
- **Set `ALLOWED_ORIGIN`** to your production domain in `wrangler.jsonc` `vars`. Leaving it unset will echo the request's Origin (handy for dev, not for prod).
- **Rotate keys** by updating the `API_KEYS` secret. Comma-separation supports multiple active keys for rolling rotation.
- **Cloudflare Access** is the recommended path for any non-demo deployment.

## License

MIT — see `LICENSE`.
