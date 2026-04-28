#!/bin/bash

# Automated Cloudflare Documentation Ingestion Script
# This script handles pagination automatically and ingests all documentation

API_URL="https://nexgenagents.co/api/v1/ingest-docs"
BATCH_SIZE=20

# Color output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "🚀 Starting automated documentation ingestion..."
echo ""

# Function to ingest a path with automatic pagination
ingest_path() {
    local path=$1
    local offset=0
    local total_files=0
    local total_chunks=0
    
    echo -e "${YELLOW}📂 Processing: ${path}${NC}"
    
    while true; do
        # Make API request
        response=$(curl -s -X POST "$API_URL" \
            -H "Content-Type: application/json" \
            -d "{\"paths\": [\"${path}\"], \"offset\": ${offset}}")
        
        # Extract results
        files=$(echo "$response" | grep -o '"totalFiles":[0-9]*' | grep -o '[0-9]*')
        chunks=$(echo "$response" | grep -o '"totalChunks":[0-9]*' | grep -o '[0-9]*')
        
        # Check if we got any files
        if [ "$files" = "0" ] || [ -z "$files" ]; then
            break
        fi
        
        total_files=$((total_files + files))
        total_chunks=$((total_chunks + chunks))
        
        echo -e "  ✓ Offset ${offset}: ${files} files, ${chunks} chunks"
        
        # If we got fewer files than batch size, we're done
        if [ "$files" -lt "$BATCH_SIZE" ]; then
            break
        fi
        
        # Move to next batch
        offset=$((offset + BATCH_SIZE))
        
        # Small delay to avoid rate limits
        sleep 1
    done
    
    echo -e "${GREEN}  ✅ Completed: ${total_files} files, ${total_chunks} chunks${NC}"
    echo ""
}

# Documentation paths to ingest
PATHS=(
    "src/content/docs/ai-gateway"
    "src/content/docs/workers-ai"
    "src/content/docs/workers"
    "src/content/docs/r2"
    "src/content/docs/vectorize"
    "src/content/docs/d1"
    "src/content/docs/kv"
    "src/content/docs/pages"
)

# Process each path
for path in "${PATHS[@]}"; do
    ingest_path "$path"
done

echo -e "${GREEN}🎉 All documentation ingested successfully!${NC}"
echo ""
echo "Check your Vectorize index:"
echo "  npx wrangler vectorize get nexgen-index"
