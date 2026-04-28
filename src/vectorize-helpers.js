/**
 * Vectorize Helper Functions
 * 
 * Functions for querying and ingesting documentation into Vectorize
 */

/**
 * Query Vectorize for relevant documentation context
 */
export async function queryVectorizeForContext(query, env, options = {}) {
    const { topK = 3, minScore = 0.7 } = options;
    
    try {
        // Generate query embedding (1024 dimensions)
        const queryEmbedding = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
            text: [query]
        });
        
        // Query Vectorize
        const results = await env.VECTORIZE_INDEX.query(queryEmbedding.data[0], {
            topK,
            returnMetadata: 'all'
        });
        
        // Filter by score and format context
        const relevantDocs = results.matches
            .filter(match => match.score >= minScore)
            .map(match => ({
                text: match.metadata.text,
                heading: match.metadata.heading,
                url: match.metadata.url,
                score: match.score
            }));
        
        if (relevantDocs.length === 0) {
            return null;
        }
        
        // Format context for LLM - clean up MDX/JSX imports and limit size
        const context = relevantDocs
            .map((doc, i) => {
                // Remove MDX/JSX import statements and component tags
                let cleanText = doc.text
                    .replace(/import\s+\{[^}]+\}\s+from\s+["'][^"']+["'];?/g, '')
                    .replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '')
                    .replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '')
                    .trim();
                return `[${i + 1}] ${doc.heading}\n${cleanText}\nSource: ${doc.url}`;
            })
            .join('\n\n---\n\n');
        
        // Limit context size to avoid overwhelming the model
        const maxContextLength = 3000;
        return context.length > maxContextLength 
            ? context.substring(0, maxContextLength) + '...'
            : context;
        
    } catch (error) {
        console.error('Vectorize query error:', error);
        return null; // Fail gracefully
    }
}

/**
 * Ingest documentation from GitHub
 */
export async function ingestDocsFromGitHub(env, options = {}) {
    const {
        owner = 'cloudflare',
        repo = 'cloudflare-docs',
        branch = 'production',
        paths = ['src/content/docs/ai-gateway', 'src/content/docs/workers-ai', 'src/content/docs/workers', 'src/content/docs/r2'],
        maxChunkSize = 800
    } = options;
    
    const githubToken = env.GITHUB_TOKEN;
    if (!githubToken) {
        throw new Error('GITHUB_TOKEN not configured');
    }
    
    let totalChunks = 0;
    let totalFiles = 0;
    
    for (const path of paths) {
        try {
            // Fetch files from GitHub
            const files = await fetchGitHubFiles(owner, repo, branch, path, githubToken);
            
            // Limit files per path to avoid subrequest limits (Workers limit: ~50-1000 subrequests)
            // Each file generates multiple subrequests (fetch + embeddings per chunk)
            const maxFilesPerPath = options.maxFilesPerPath || 20;
            const offset = options.offset || 0;
            const filesToProcess = files.slice(offset, offset + maxFilesPerPath);
            
            console.log(`📁 Processing ${filesToProcess.length} files from ${path} (offset: ${offset}, total: ${files.length})`);
            
            if (files.length > offset + maxFilesPerPath) {
                console.log(`⚠️  More files available. Run again with offset=${offset + maxFilesPerPath} to continue.`);
            }
            
            for (const file of filesToProcess) {
                try {
                    const content = await fetchGitHubFileContent(owner, repo, branch, file.path, githubToken);
                    const chunks = chunkMarkdown(content, file.path, maxChunkSize);
                    
                    // Insert chunks into Vectorize
                    await insertChunksIntoVectorize(chunks, file.path, env);
                    
                    totalChunks += chunks.length;
                    totalFiles++;
                } catch (fileError) {
                    console.error(`Error processing file ${file.path}:`, fileError.message);
                    // Continue processing other files even if one fails
                }
            }
        } catch (error) {
            console.error(`Error processing path ${path}:`, error);
        }
    }
    
    return { totalFiles, totalChunks };
}

/**
 * Fetch markdown files from GitHub
 */
async function fetchGitHubFiles(owner, repo, branch, path, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker'
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.tree.filter(item => 
        item.path.startsWith(path) && 
        (item.path.endsWith('.md') || item.path.endsWith('.mdx')) &&
        item.type === 'blob'
    );
}

/**
 * Fetch file content from GitHub
 */
async function fetchGitHubFileContent(owner, repo, branch, path, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker'
        }
    });
    
    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
    }
    
    const data = await response.json();
    const content = atob(data.content); // Decode base64
    return content;
}

/**
 * Chunk markdown content intelligently
 */
function chunkMarkdown(content, filePath, maxChunkSize) {
    const chunks = [];
    
    // Parse frontmatter
    const { metadata, markdownContent } = parseFrontmatter(content);
    
    // Split by headings
    const sections = markdownContent.split(/^(#{1,6}\s+.+)$/gm);
    
    let currentChunk = '';
    let currentHeading = metadata.title || '';
    let chunkIndex = 0;
    
    for (let i = 0; i < sections.length; i++) {
        const section = sections[i].trim();
        if (!section) continue;
        
        const headingMatch = section.match(/^(#{1,6})\s+(.+)$/);
        
        if (headingMatch) {
            // Save previous chunk
            if (currentChunk.length > 100) {
                chunks.push({
                    text: currentChunk.trim(),
                    heading: currentHeading,
                    index: chunkIndex++,
                    metadata
                });
                currentChunk = '';
            }
            currentHeading = headingMatch[2];
            currentChunk += section + '\n\n';
        } else {
            const estimatedTokens = (currentChunk + section).length / 4;
            
            if (estimatedTokens > maxChunkSize && currentChunk.length > 100) {
                chunks.push({
                    text: currentChunk.trim(),
                    heading: currentHeading,
                    index: chunkIndex++,
                    metadata
                });
                currentChunk = section + '\n\n';
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
            index: chunkIndex++,
            metadata
        });
    }
    
    return chunks.map(chunk => ({
        ...chunk,
        filePath,
        url: generateDocsUrl(filePath)
    }));
}

/**
 * Parse YAML frontmatter
 */
function parseFrontmatter(content) {
    const lines = content.split('\n');
    let metadata = {};
    let markdownContent = content;
    
    if (lines[0] === '---') {
        const endIndex = lines.slice(1).findIndex(line => line === '---');
        if (endIndex !== -1) {
            const frontmatter = lines.slice(1, endIndex + 1).join('\n');
            markdownContent = lines.slice(endIndex + 2).join('\n');
            
            frontmatter.split('\n').forEach(line => {
                const match = line.match(/^(\w+):\s*(.+)$/);
                if (match) {
                    metadata[match[1]] = match[2].replace(/^["']|["']$/g, '');
                }
            });
        }
    }
    
    return { metadata, markdownContent };
}

/**
 * Generate documentation URL
 */
function generateDocsUrl(filePath) {
    const path = filePath
        .replace(/^content\//, '')
        .replace(/\.md$/, '/')
        .replace(/\/_index$/, '/');
    
    return `https://developers.cloudflare.com/${path}`;
}

/**
 * Insert chunks into Vectorize
 */
async function insertChunksIntoVectorize(chunks, filePath, env) {
    const vectors = [];
    
    for (const chunk of chunks) {
        // Generate embedding (1024 dimensions)
        const embedding = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
            text: [chunk.text]
        });
        
        // Create short ID using hash (max 64 bytes)
        const hashInput = `${filePath}-${chunk.index}`;
        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
        
        // Truncate text to fit within 10KB metadata limit (keep ~8KB for safety)
        const maxTextLength = 8000;
        const truncatedText = chunk.text.length > maxTextLength 
            ? chunk.text.substring(0, maxTextLength) + '...' 
            : chunk.text;
        
        vectors.push({
            id: hashHex,
            values: embedding.data[0],
            metadata: {
                text: truncatedText,
                heading: chunk.heading,
                filePath: chunk.filePath,
                url: chunk.url,
                title: chunk.metadata.title || chunk.heading,
                source: 'cloudflare-docs',
                product: extractProduct(filePath),
                chunkIndex: chunk.index,
                ingested_at: new Date().toISOString()
            }
        });
    }
    
    // Insert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
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
