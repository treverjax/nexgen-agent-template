/**
 * Cloudflare Documentation Ingestion Script
 * 
 * This script fetches Cloudflare documentation from GitHub,
 * chunks it intelligently, generates embeddings, and stores
 * them in Cloudflare Vectorize for semantic search.
 * 
 * Usage: node scripts/ingest-docs.js
 */

import { Octokit } from "@octokit/rest";

// Configuration
const CONFIG = {
  owner: "cloudflare",
  repo: "cloudflare-docs",
  branch: "production",
  
  // Focus on these documentation areas
  targetPaths: [
    "content/ai-gateway",
    "content/workers-ai",
    "content/workers",
    "content/r2",
    "content/vectorize",
    "content/d1",
    "content/pages",
    "content/kv"
  ],
  
  // Chunking settings
  maxChunkSize: 800, // tokens (roughly 3200 chars)
  chunkOverlap: 100,  // tokens overlap between chunks
  
  // Batch settings
  batchSize: 100, // Insert this many vectors at once
};

/**
 * Main ingestion function
 */
export async function ingestCloudfareDocs(env, options = {}) {
  const config = { ...CONFIG, ...options };
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
  
  console.log("🚀 Starting Cloudflare docs ingestion...");
  console.log(`📁 Target paths: ${config.targetPaths.join(", ")}`);
  
  let totalChunks = 0;
  let totalFiles = 0;
  
  for (const path of config.targetPaths) {
    console.log(`\n📂 Processing ${path}...`);
    
    try {
      // Get all markdown files in this path
      const files = await fetchMarkdownFiles(octokit, config, path);
      console.log(`   Found ${files.length} markdown files`);
      
      for (const file of files) {
        try {
          // Fetch file content
          const content = await fetchFileContent(octokit, config, file.path);
          
          // Parse and chunk markdown
          const chunks = chunkMarkdown(content, file.path, config);
          
          // Generate embeddings and insert into Vectorize
          await insertChunks(chunks, file, env, config);
          
          totalChunks += chunks.length;
          totalFiles++;
          
          console.log(`   ✓ ${file.path} (${chunks.length} chunks)`);
          
        } catch (error) {
          console.error(`   ✗ Error processing ${file.path}:`, error.message);
        }
      }
      
    } catch (error) {
      console.error(`   ✗ Error processing path ${path}:`, error.message);
    }
  }
  
  console.log(`\n✅ Ingestion complete!`);
  console.log(`   Files processed: ${totalFiles}`);
  console.log(`   Total chunks: ${totalChunks}`);
  
  return { totalFiles, totalChunks };
}

/**
 * Fetch all markdown files from a GitHub path
 */
async function fetchMarkdownFiles(octokit, config, path) {
  const { data: tree } = await octokit.rest.git.getTree({
    owner: config.owner,
    repo: config.repo,
    tree_sha: config.branch,
    recursive: true
  });
  
  return tree.tree.filter(item => 
    item.path.startsWith(path) && 
    item.path.endsWith('.md') &&
    item.type === 'blob'
  );
}

/**
 * Fetch content of a specific file
 */
async function fetchFileContent(octokit, config, path) {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path: path,
    ref: config.branch
  });
  
  // Decode base64 content
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return content;
}

/**
 * Parse markdown and extract metadata
 */
function parseMarkdown(content) {
  const lines = content.split('\n');
  let metadata = {};
  let markdownContent = content;
  
  // Extract frontmatter if present
  if (lines[0] === '---') {
    const endIndex = lines.slice(1).findIndex(line => line === '---');
    if (endIndex !== -1) {
      const frontmatter = lines.slice(1, endIndex + 1).join('\n');
      markdownContent = lines.slice(endIndex + 2).join('\n');
      
      // Parse YAML frontmatter (simple key: value pairs)
      frontmatter.split('\n').forEach(line => {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          metadata[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
      });
    }
  }
  
  return { metadata, content: markdownContent };
}

/**
 * Chunk markdown content intelligently
 */
function chunkMarkdown(rawContent, filePath, config) {
  const { metadata, content } = parseMarkdown(rawContent);
  const chunks = [];
  
  // Split by headings to preserve context
  const sections = content.split(/^(#{1,6}\s+.+)$/gm);
  
  let currentChunk = '';
  let currentHeading = metadata.title || '';
  let chunkIndex = 0;
  
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;
    
    // Check if this is a heading
    const headingMatch = section.match(/^(#{1,6})\s+(.+)$/);
    
    if (headingMatch) {
      // Save previous chunk if it exists
      if (currentChunk.length > 100) {
        chunks.push({
          text: currentChunk.trim(),
          heading: currentHeading,
          index: chunkIndex++
        });
        currentChunk = '';
      }
      
      currentHeading = headingMatch[2];
      currentChunk += section + '\n\n';
      
    } else {
      // Regular content
      const estimatedTokens = (currentChunk + section).length / 4;
      
      if (estimatedTokens > config.maxChunkSize) {
        // Chunk is too large, split by paragraphs
        const paragraphs = section.split(/\n\n+/);
        
        for (const para of paragraphs) {
          const paraTokens = (currentChunk + para).length / 4;
          
          if (paraTokens > config.maxChunkSize && currentChunk.length > 100) {
            // Save current chunk
            chunks.push({
              text: currentChunk.trim(),
              heading: currentHeading,
              index: chunkIndex++
            });
            currentChunk = para + '\n\n';
          } else {
            currentChunk += para + '\n\n';
          }
        }
      } else {
        currentChunk += section + '\n\n';
      }
    }
  }
  
  // Save final chunk
  if (currentChunk.length > 100) {
    chunks.push({
      text: currentChunk.trim(),
      heading: currentHeading,
      index: chunkIndex++
    });
  }
  
  // Add metadata to each chunk
  return chunks.map(chunk => ({
    ...chunk,
    metadata: {
      ...metadata,
      filePath,
      url: generateDocsUrl(filePath)
    }
  }));
}

/**
 * Generate documentation URL from file path
 */
function generateDocsUrl(filePath) {
  // Convert content/ai-gateway/get-started.md -> https://developers.cloudflare.com/ai-gateway/get-started/
  const path = filePath
    .replace(/^content\//, '')
    .replace(/\.md$/, '/')
    .replace(/\/_index$/, '/');
  
  return `https://developers.cloudflare.com/${path}`;
}

/**
 * Generate embeddings and insert chunks into Vectorize
 */
async function insertChunks(chunks, file, env, config) {
  const vectors = [];
  
  for (const chunk of chunks) {
    // Generate embedding using Workers AI
    const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [chunk.text]
    });
    
    vectors.push({
      id: `${file.path}-chunk-${chunk.index}`,
      values: embedding.data[0],
      metadata: {
        text: chunk.text,
        heading: chunk.heading,
        filePath: chunk.metadata.filePath,
        url: chunk.metadata.url,
        title: chunk.metadata.title || chunk.heading,
        source: 'cloudflare-docs',
        product: extractProduct(file.path),
        ingested_at: new Date().toISOString()
      }
    });
  }
  
  // Insert in batches
  for (let i = 0; i < vectors.length; i += config.batchSize) {
    const batch = vectors.slice(i, i + config.batchSize);
    await env.VECTORIZE_INDEX.upsert(batch);
  }
}

/**
 * Extract product name from file path
 */
function extractProduct(filePath) {
  const match = filePath.match(/^content\/([^\/]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Query Vectorize for relevant documentation
 */
export async function queryDocs(query, env, options = {}) {
  const { topK = 3, filter = {} } = options;
  
  // Generate query embedding
  const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [query]
  });
  
  // Query Vectorize
  const results = await env.VECTORIZE_INDEX.query(queryEmbedding.data[0], {
    topK,
    filter,
    returnMetadata: 'all'
  });
  
  return results.matches.map(match => ({
    text: match.metadata.text,
    heading: match.metadata.heading,
    url: match.metadata.url,
    title: match.metadata.title,
    product: match.metadata.product,
    score: match.score
  }));
}
