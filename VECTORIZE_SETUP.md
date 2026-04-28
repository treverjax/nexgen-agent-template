# Vectorize Documentation Ingestion

This guide explains how to populate your Vectorize index with Cloudflare documentation for enhanced chat responses.

## Overview

The system fetches Cloudflare documentation from GitHub, intelligently chunks it, generates embeddings using Workers AI, and stores them in Vectorize for semantic search.

## Prerequisites

1. **GitHub Token** (for accessing cloudflare-docs repo)
   - Create a personal access token at https://github.com/settings/tokens
   - Needs `public_repo` access
   - Add to wrangler.toml as secret:
     ```bash
     npx wrangler secret put GITHUB_TOKEN
     ```

2. **Vectorize Index** (already configured)
   - Index name: `<your-vectorize-index>`
   - Binding: `VECTORIZE_INDEX`

## Quick Start

### Option 1: Trigger via API (Recommended)

Trigger ingestion from your deployed Worker:

```bash
curl -X POST https://<your-domain>/api/v1/ingest-docs \
  -H "Content-Type: application/json" \
  -d '{
    "paths": ["content/ai-gateway", "content/workers-ai"],
    "maxChunkSize": 800
  }'
```

**Response:**
```json
{
  "success": true,
  "totalFiles": 45,
  "totalChunks": 312,
  "message": "Ingested 45 files with 312 chunks"
}
```

### Option 2: Test Query Endpoint

Test if documentation is being retrieved:

```bash
curl -X POST https://<your-domain>/api/v1/query-docs \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How do I use AI Gateway with Workers AI?",
    "topK": 3,
    "minScore": 0.7
  }'
```

## Configuration

### Customize Ingestion Paths

Ingest specific documentation sections:

```json
{
  "paths": [
    "content/ai-gateway",      // AI Gateway docs
    "content/workers-ai",       // Workers AI docs
    "content/workers",          // Workers platform
    "content/r2",               // R2 storage
    "content/vectorize",        // Vectorize docs
    "content/d1",               // D1 database
    "content/pages",            // Pages
    "content/kv"                // KV storage
  ],
  "maxChunkSize": 800
}
```

### Chunking Strategy

- **Default chunk size**: 800 tokens (~3200 characters)
- **Overlap**: 100 tokens between chunks
- **Splitting**: By markdown headings, then paragraphs
- **Metadata preserved**: Title, headings, URLs, product names

## How It Works

### 1. Ingestion Pipeline

```
GitHub Repo → Fetch Markdown → Parse & Chunk → Generate Embeddings → Store in Vectorize
```

**Steps:**
1. Fetch markdown files from `cloudflare/cloudflare-docs` repo
2. Parse frontmatter and extract metadata
3. Split by headings to preserve context
4. Generate embeddings using `@cf/baai/bge-base-en-v1.5`
5. Insert into Vectorize with metadata

### 2. Query Pipeline

```
User Query → Generate Embedding → Query Vectorize → Retrieve Top K → Enhance Chat Context
```

**Steps:**
1. User asks a question about Cloudflare
2. Generate query embedding
3. Semantic search in Vectorize (top 3 results, score > 0.7)
4. Add relevant docs as context to chat
5. LLM responds with accurate, up-to-date information

## Integration with Chat

The chat endpoint automatically queries Vectorize for relevant documentation:

```javascript
// In handleAgentChat
const docContext = await queryVectorizeForContext(query, env);

if (docContext) {
  // Add documentation context to chat
  enhancedMessages.push({
    role: 'system',
    content: `Relevant Cloudflare documentation:\n\n${docContext}`
  });
}
```

## Monitoring

### Check Vectorize Index Stats

```bash
npx wrangler vectorize get <your-vectorize-index>
```

### View Recent Ingestions

Check Worker logs:
```bash
npx wrangler tail
```

## Maintenance

### Update Documentation

Re-run ingestion to update with latest docs:

```bash
curl -X POST https://<your-domain>/api/v1/ingest-docs
```

This will **upsert** (update or insert) vectors, so existing chunks are updated.

### Scheduled Updates (Optional)

Add a cron trigger to `wrangler.toml`:

```toml
[triggers]
crons = ["0 0 * * 0"]  # Weekly on Sunday at midnight
```

Then add to your Worker:

```javascript
export default {
  async scheduled(event, env, ctx) {
    await ingestDocsFromGitHub(env, {
      paths: ['content/ai-gateway', 'content/workers-ai']
    });
  }
}
```

## Troubleshooting

### "Missing GITHUB_TOKEN"

Add your GitHub token:
```bash
npx wrangler secret put GITHUB_TOKEN
```

### "Vectorize index not found"

Verify binding in `wrangler.toml`:
```toml
[[vectorize]]
binding = "VECTORIZE_INDEX"
index_name = "<your-vectorize-index>"
```

### Low-quality results

Adjust query parameters:
- Increase `topK` (default: 3)
- Lower `minScore` threshold (default: 0.7)
- Reduce `maxChunkSize` for more granular chunks

## Example Queries

Test these queries after ingestion:

1. **"How do I set up AI Gateway?"**
   - Should return AI Gateway setup docs

2. **"What models does Workers AI support?"**
   - Should return Workers AI model catalog

3. **"How do I cache AI Gateway requests?"**
   - Should return caching documentation

## Next Steps

1. **Trigger initial ingestion** with AI Gateway docs
2. **Test queries** via `/api/v1/query-docs`
3. **Verify chat enhancement** by asking Cloudflare questions
4. **Expand to more docs** (Workers, R2, etc.)
5. **Set up scheduled updates** (optional)

## API Reference

### POST /api/v1/ingest-docs

Ingest documentation from GitHub.

**Request:**
```json
{
  "paths": ["content/ai-gateway"],
  "maxChunkSize": 800
}
```

**Response:**
```json
{
  "success": true,
  "totalFiles": 45,
  "totalChunks": 312,
  "message": "Ingested 45 files with 312 chunks"
}
```

### POST /api/v1/query-docs

Query documentation directly.

**Request:**
```json
{
  "query": "How do I use AI Gateway?",
  "topK": 3,
  "minScore": 0.7
}
```

**Response:**
```json
{
  "query": "How do I use AI Gateway?",
  "context": "[1] Getting Started\n...\nSource: https://developers.cloudflare.com/ai-gateway/get-started/",
  "hasResults": true
}
```

## Resources

- [Cloudflare Vectorize Docs](https://developers.cloudflare.com/vectorize/)
- [Workers AI Embeddings](https://developers.cloudflare.com/workers-ai/models/embedding/)
- [Cloudflare Docs GitHub](https://github.com/cloudflare/cloudflare-docs)
