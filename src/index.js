import OpenAI from 'openai';
import { queryVectorizeForContext, ingestDocsFromGitHub } from './vectorize-helpers.js';

const CLOUDFLARE_TOPIC_PATTERNS = [
    /SSL\s+(for\s+)?SaaS/i,
    /SaaS\s+SSL/i,
    /SSL\s+implementation/i,
    /AI Gateway/i,
    /dynamic routing/i,
    /rate limiting/i,
    /Workers AI/i,
    /Vectorize/i,
    /R2/i,
    /cost management/i,
    /security/i,
    /load balancing/i,
    /CDN/i,
    /WAF/i,
    /Zero Trust/i,
    /tenant isolation/i,
    /full\s*stack/i,
    /implementation/i,
    /architecture/i,
    /Cloudflare/i
];

const SYSTEM_PROMPT = `You are "NextGen", the official AI Assistant for Cloudflare.

CAPABILITIES:
1. Answer questions about Cloudflare (Workers, R2, Gateway).
2. Generate images using the 'generate_image' tool.

INSTRUCTIONS:
- Keep text responses concise.
- If the user asks for a diagram, architecture, or visual, do NOT write code. Trigger the image tool.`;

// Routes that DO NOT require an API key. Everything else routed under /api/* requires auth.
const PUBLIC_ROUTES = new Set([
  '/',
]);

// GET-only public routes (e.g. serving generated assets back to the browser).
const PUBLIC_GET_PREFIXES = ['/api/v1/assets/'];

function buildCorsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  // If ALLOWED_ORIGIN is unset, fall back to echo-origin (dev convenience).
  // In production, set ALLOWED_ORIGIN to your domain(s).
  let allowOrigin;
  if (allowed.length === 0) allowOrigin = origin || '*';
  else if (allowed.includes('*')) allowOrigin = '*';
  else allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function unauthorized(corsHeaders, message = 'Unauthorized') {
  return new Response(JSON.stringify({ error: 'Unauthorized', message }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Validates Bearer token against the comma-separated list in env.API_KEYS.
// Returns true if request is authorized, false otherwise.
function isAuthorized(request, env) {
  const keys = (env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (keys.length === 0) return false; // fail closed if no keys configured
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice(7).trim();
  return keys.includes(presented);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = buildCorsHeaders(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // Public routes (static frontend served by Workers Assets, plus /).
    if (PUBLIC_ROUTES.has(url.pathname)) {
      return new Response('NexGen Platform Online', { headers: corsHeaders });
    }

    // Public GET prefixes (e.g. asset retrieval — readers don't get a list,
    // and filenames are random/timestamped).
    if (request.method === 'GET' && PUBLIC_GET_PREFIXES.some(p => url.pathname.startsWith(p))) {
      return handleServeAsset(url, env, corsHeaders);
    }

    // Everything below requires a valid API key.
    if (url.pathname.startsWith('/api/') || url.pathname === '/chat') {
      if (!isAuthorized(request, env)) {
        return unauthorized(corsHeaders, 'Missing or invalid Bearer token. Set env.API_KEYS and send Authorization: Bearer <key>.');
      }
      if (url.pathname === '/chat' || url.pathname === '/api/chat' || url.pathname === '/api/v1/chat') {
        return handleAgentChat(request, env, corsHeaders);
      }
      if (url.pathname === '/api/v1/transcribe') return handleTranscribe(request, env, ctx, corsHeaders);
      if (url.pathname === '/api/v1/save-image') return handleSaveToR2(request, env, corsHeaders);
      if (url.pathname === '/api/v1/ingest-docs') return handleIngestDocs(request, env, corsHeaders);
      if (url.pathname === '/api/v1/query-docs') return handleQueryDocs(request, env, corsHeaders);
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('NexGen Platform Online', { headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    // Automatically update documentation weekly
    console.log('Running scheduled documentation update...');
    
    try {
      const result = await ingestDocsFromGitHub(env, {
        paths: ['src/content/docs/ai-gateway', 'src/content/docs/workers-ai']
      });
      
      console.log(`Scheduled update complete: ${result.totalFiles} files, ${result.totalChunks} chunks`);
    } catch (error) {
      console.error('Scheduled update failed:', error);
    }
  }
};

async function handleAgentChat(request, env, corsHeaders) {
    const url = new URL(request.url);
    
    // Support both GET (legacy) and POST (with history)
    let query = "Hello";
    let history = [];
    
    if (request.method === 'POST') {
        try {
            const body = await request.json();
            query = body.query || "Hello";
            history = Array.isArray(body.history) ? body.history : [];
        } catch (e) {
            query = url.searchParams.get('q') || "Hello";
        }
    } else {
        query = url.searchParams.get('q') || "Hello";
    }
    
    const mode = url.searchParams.get('mode');
    const shouldStream = url.searchParams.get('stream') === '1' || url.searchParams.get('stream') === 'true';
    const imageModel = url.searchParams.get('model'); // User-selected image model
    const provider = url.searchParams.get('provider'); // User-selected text model provider
    const routeModelOverride = url.searchParams.get('route_model');
    const workersModelOverride = url.searchParams.get('workers_model');
    const lowerQ = query.toLowerCase();

    // --- INTENT DETECTION ---
    const isExplicitImage = (mode === 'image') || query.includes("(User explicitly selected Create Image Tool)");
    const isExplicitVideo = (mode === 'video');
    
    // Check for implementation/workflow/setup requests that should be diagrams
    const isImplementationRequest = /\b(implementation|workflow|setup|integration|pipeline|example|how\s+to\s+(set\s+up|configure|use))\b/i.test(lowerQ);
    
    // Check if this is a follow-up confirmation to generate a diagram from previous description
    const isFollowUpConfirmation = /^(yes|yeah|yep|sure|ok|okay|please|do it|go ahead|generate\s*(it|that|the\s*(image|diagram))?|create\s*(it|that|the\s*(image|diagram))?)$/i.test(query.trim()) ||
        /\b(generate|create|make|show)\s+(it|that|this|the\s*(image|diagram|picture))(\s+for\s+me)?$/i.test(lowerQ) ||
        /\bfrom\s+(the|that|this)\s+(description|text|above)/i.test(lowerQ);
    
    // Only trigger diagram mode if explicitly requested or if diagram-specific phrases are used
    const isDiagramRequest = (mode === 'diagram') || 
        /\b(show|create|draw|generate|make|visualize)\s+(me\s+)?(a\s+|an\s+|other\s+)?(diagram|architecture|flow|visualization|flowchart)s?\b/i.test(lowerQ) ||
        /\bdiagrams?\s+(of|showing|for)\b/i.test(lowerQ) ||
        // Treat implementation/workflow/setup requests as diagram requests when they include "show", "example", etc.
        (isImplementationRequest && /\b(show|example|visualize|display|create)\b/i.test(lowerQ)) ||
        // Follow-up confirmation after a diagram description was provided
        isFollowUpConfirmation;
    
    const imageKeywords = ["draw", "image", "picture", "photo", "generate", "design", "illustration", "poster", "artwork", "render"];
    const isGeneralImage = !isDiagramRequest && imageKeywords.some(k => lowerQ.includes(k));
    
    // Detect vague follow-up requests that lack context
    // Only block truly vague requests without any subject matter
    const vaguePatterns = [
        /^(a\s+)?(more\s+)?detailed\s+(image|diagram|picture)$/i,  // Just "detailed diagram" with nothing else
        /^(show|make|create)\s+(it|that|this)\s+(more\s+)?detailed$/i,  // Just "make it detailed"
        /^more\s+detail$/i,  // Just "more detail"
        /^better\s+(image|diagram|version)$/i,  // Just "better diagram"
        /^(another|different)\s+(one|image|diagram)$/i,  // Just "different diagram" with no context
    ];
    const isVagueFollowUp = vaguePatterns.some(p => p.test(query.trim()));
    
    // If it's a vague follow-up without clear subject, ask for clarification instead of generating random art
    if (isVagueFollowUp && !isDiagramRequest) {
        return new Response(JSON.stringify({
            response: "I'd be happy to create a more detailed diagram! Could you specify what you'd like me to visualize? For example:\n\n- **AI Gateway architecture** - showing request flow through the gateway\n- **Workers + R2 pipeline** - data processing and storage flow\n- **Full Cloudflare stack** - CDN, Workers, AI, and storage integration\n\nJust let me know which aspect you'd like to see in more detail!"
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Handle video generation
    if (isExplicitVideo) {
        let prompt = query.trim();
        
        if (prompt.length < 10) {
            return new Response(JSON.stringify({
                response: "What would you like me to create a video of? Please describe the scene or action you'd like to visualize."
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        try {
            // Video generation uses Kling V2.5 Turbo Pro
            const videoRes = await internalImageCall(prompt, env, false, imageModel || 'kling-v2.5');
            
            // Handle response that includes prediction URL
            const videoUrl = typeof videoRes === 'object' && videoRes.url ? videoRes.url : videoRes;
            const predictionUrl = typeof videoRes === 'object' && videoRes.predictionUrl ? videoRes.predictionUrl : null;
            
            return new Response(JSON.stringify({
                type: "tool_result", 
                tool: "generate_video", 
                content: videoUrl, 
                prediction_url: predictionUrl,
                is_video: true,
                model_used: imageModel || 'kling-v2.5',
                text: `Generated video: ${prompt}`
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (e) { 
            return new Response(JSON.stringify({ error: "Video gen failed: " + e.message }), { headers: corsHeaders }); 
        }
    }

    if (isExplicitImage || isDiagramRequest || isGeneralImage) {
        let prompt = query;
        let isDiagram = isDiagramRequest;
        
        // Special case: Return pre-built SVG for "this demo's architecture"
        const isDemoArchitecture = /this\s+demo('s)?\s+architecture|nexgen\s+architecture|demo\s+architecture/i.test(query);
        if (isDemoArchitecture) {
            return new Response(JSON.stringify({
                type: "tool_result",
                tool: "generate_diagram",
                content: "/diagrams/nexgen-architecture.svg",
                is_svg: true,
                text: "Here's the NexGen Agents architecture diagram showing the complete system design:\n\n**Frontend Layer:** Custom domain with static assets served via Cloudflare\n\n**Backend Layer:** Workers handling requests, with Vectorize for semantic search, R2 for asset storage, KV for caching, and D1 for structured data\n\n**AI Infrastructure:** AI Gateway as the central routing layer, connecting to Workers AI and embeddings\n\n**External Services:** Integration with OpenAI, Anthropic, Replicate, and Google AI through the gateway\n\n**CI/CD:** Wrangler CLI and GitHub Actions for deployment\n\nThe orange highlights show the primary request flow from user through the AI Gateway."
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // Extract the actual subject for diagram requests
        if (isDiagramRequest) {
            // Try to extract the main subject from the query
            let subject = query
                .replace(/^(show|draw|create|generate|make|visualize)\s+(me\s+)?(a\s+)?/i, '')
                .replace(/(diagram|architecture|flow|visualization)\s*(of)?/gi, '')
                .replace(/cloudflare('s)?\s*/gi, 'Cloudflare ')
                .trim();
            
            // If subject is vague (e.g., "implementation", "it", "that"), use conversation history for context
            if (!subject || subject.length < 5 || /^(implementation|it|that|this|setup|architecture)$/i.test(subject)) {
                // Look through recent conversation history for context
                const recentContext = history.slice(-4).map(m => m.content).join(' ');
                
                // Extract key topics from conversation history
                let contextTopic = null;
                for (const pattern of CLOUDFLARE_TOPIC_PATTERNS) {
                    if (pattern.test(recentContext)) {
                        contextTopic = recentContext.match(pattern)[0];
                        break;
                    }
                }
                
                // Use context topic if found, otherwise default
                subject = contextTopic || 'Cloudflare AI Gateway';
                
                // If subject is still "implementation", make it more specific
                if (/implementation/i.test(query)) {
                    subject = `${subject} implementation and integration`;
                }
            }
            
            // Enhanced prompt for technical accuracy and Cloudflare-specific architecture
            const isAIGatewayRelated = /ai\s+gateway|workers\s+ai|inference|llm|model/i.test(subject);
            const isFullStack = /fullstack|full\s+stack|application|implementation/i.test(subject);
            
            if (isAIGatewayRelated) {
                // AI Gateway specific architecture diagram
                prompt = `Professional technical architecture diagram for ${subject} showing Cloudflare Developer Platform flow.

COMPONENTS (left to right):
1. CLIENT: Browser/Mobile App
2. EDGE: WAF Security → CDN Cache → AI Gateway (orange)
3. COMPUTE: Workers → Workers AI → Durable Objects  
4. STORAGE: R2 → D1 → KV → Vectorize
5. EXTERNAL: OpenAI, Anthropic, Replicate

TEXT REQUIREMENTS:
- Large, bold, sans-serif font for all labels
- High contrast black text on white/light backgrounds
- Generous padding inside boxes (minimum 20px)
- Component names clearly readable at 14-16pt font size
- NO overlapping text
- NO cramped spacing
- Each box large enough to fit text comfortably

VISUAL STYLE:
- Clean rectangular boxes with rounded corners
- Thick directional arrows between components
- Cloudflare orange (#F38020) for AI Gateway and key elements
- White background, professional technical diagram
- Horizontal flow layout for clarity
- NO isometric 3D, NO decorative art
- Enterprise-grade technical documentation quality`;
            } else if (isFullStack) {
                // Full stack application architecture
                prompt = `Professional full stack architecture diagram for ${subject} on Cloudflare Developer Platform.

LAYERS (top to bottom):
1. CLIENT: Browser/Mobile
2. EDGE: Security (WAF) → CDN → Routing
3. COMPUTE: Workers → Pages → Durable Objects
4. AI: Workers AI → AI Gateway → Vectorize
5. STORAGE: R2 → D1 → KV
6. ORCHESTRATION: Queues → Workflows → Pipelines
7. OBSERVABILITY: Logs → Analytics

TEXT REQUIREMENTS:
- Large, bold, sans-serif font (14-18pt)
- Black text with high contrast
- Wide boxes with generous internal padding
- Layer names in bold uppercase
- Component names clearly separated
- NO text overlap or cramping
- Professional typography

VISUAL STYLE:
- Vertical flow with clear layer separation
- Large rectangular boxes per layer
- Thick downward arrows between layers
- Cloudflare orange (#F38020) accents
- White background
- Clean, spacious layout
- Technical documentation quality
- NO isometric or decorative elements`;
            } else {
                // Generic Cloudflare architecture
                prompt = `Professional architecture diagram for ${subject} on Cloudflare platform.

COMPONENTS: Client → Edge Network → Workers (compute) → Storage (R2/D1/KV) → External APIs

TEXT REQUIREMENTS:
- Bold sans-serif font, 14-16pt minimum
- High contrast black text
- Generous box padding (20px+)
- Clear, readable component labels
- NO overlapping or cramped text

VISUAL STYLE:
- Clean rectangular boxes
- Directional arrows showing flow
- Cloudflare orange (#F38020) highlights
- White background
- Professional technical diagram
- NO isometric 3D or decorative art`;
            }
        } else {
            prompt = query.replace("(User explicitly selected Create Image Tool).", "")
                          .replace(/^(draw|create|generate|make|show)\s+(me\s+)?(an?\s+)?(image|picture)\s+(of\s+)?/i, "")
                          .trim();
            
            // Check if this is a vague follow-up that refers to a previous image/diagram
            const isVagueImageFollowUp = prompt.length < 15 || 
                /^(provide|give|show|get)\s+(me\s+)?(a\s+)?description/i.test(query) ||
                /^(the|this|that)\s+(image|diagram|picture)/i.test(prompt) ||
                /^description\s+(of|for)/i.test(prompt);
            
            // If the cleaned prompt is too short/vague, use conversation history for context
            if (isVagueImageFollowUp) {
                // Look through recent conversation history for the previous image/diagram topic
                const recentContext = history.slice(-6).map(m => m.content).join(' ');
                
                // Check if there was a recent diagram or image generated
                let previousTopic = null;
                for (const pattern of CLOUDFLARE_TOPIC_PATTERNS) {
                    if (pattern.test(recentContext)) {
                        previousTopic = recentContext.match(pattern)[0];
                        break;
                    }
                }
                
                if (previousTopic) {
                    // User is asking about a previous diagram - provide a text description instead of generating a new image
                    return new Response(JSON.stringify({
                        response: `Based on the previous ${previousTopic} diagram, here's a description:\n\nThe diagram shows the architecture flow for ${previousTopic} on the Cloudflare platform. It illustrates how requests flow from clients through Cloudflare's edge network, including security layers (WAF), CDN caching, and routing to the appropriate backend services.\n\nWould you like me to generate a different diagram or provide more specific details about any component?`
                    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }
                
                // No context found - ask for clarification
                return new Response(JSON.stringify({
                    response: "What would you like me to create an image of? Please describe the subject or scene you'd like to visualize."
                }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
        }
        
        try {
            const imgRes = await internalImageCall(prompt, env, isDiagram, imageModel);
            return new Response(JSON.stringify({
                type: "tool_result", 
                tool: "generate_image", 
                content: imgRes, 
                is_diagram: isDiagram,
                model_used: imageModel || (isDiagram ? 'recraft-v3' : 'flux-schnell'),
                text: isDiagram ? "Here is a visualization of the architecture:" : `Generated: ${prompt}`
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (e) { return new Response(JSON.stringify({ error: "Image gen failed: " + e.message }), { headers: corsHeaders }); }
    }

    // --- VECTORIZE RETRIEVAL FOR DOCUMENTATION QUERIES ---
    const docContext = await queryVectorizeForContext(query, env);
    
    // Enhance query with documentation context if relevant
    const enhancedMessages = [
        { role: 'system', content: SYSTEM_PROMPT }
    ];
    
    if (docContext) {
        enhancedMessages.push({
            role: 'system',
            content: `Relevant Cloudflare documentation:\n\n${docContext}\n\nUse this information to provide accurate, up-to-date answers about Cloudflare products.`
        });
    }
    
    enhancedMessages.push(...history.slice(-8).map(m => ({ role: m.role, content: m.content })));
    enhancedMessages.push({ role: 'user', content: query });

    // --- DYNAMIC ROUTING CHAT (Fixed Authentication) ---
    const gatewayId = env.AI_GATEWAY_ID;
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const gatewayToken = env.CF_GATEWAY_TOKEN;

    if (!gatewayId) {
        return new Response(JSON.stringify({ error: 'Missing AI_GATEWAY_ID env var' }), { status: 500, headers: corsHeaders });
    }

    if (!gatewayToken) {
        return new Response(JSON.stringify({ error: "Missing CF_GATEWAY_TOKEN" }), { status: 500, headers: corsHeaders });
    }

    // To use Dynamic Routes with stored keys (BYOK), we must separate Gateway Auth from Provider Auth.
    const client = new OpenAI({
        apiKey: gatewayToken,
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`,
    });

    if (shouldStream) {
        // Map provider selection to actual model
        const providerModelMap = {
            'qwen-reasoning': '@cf/qwen/qwen3-30b-a3b-fp8',
            'qwen-fast': '@cf/qwen/qwen2.5-coder-32b-instruct',
            'llama-70b': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'llama-405b': 'meta/llama-3.1-405b-instruct', // Replicate
            'mistral-large': 'mistralai/mistral-large-2411' // Replicate
        };
        
        const selectedModel = provider && providerModelMap[provider] ? providerModelMap[provider] : '@cf/qwen/qwen3-30b-a3b-fp8';
        const isReplicate = provider === 'llama-405b' || provider === 'mistral-large';
        
        // Use appropriate endpoint based on provider
        const gatewayUrl = isReplicate 
            ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/replicate/v1/chat/completions`
            : `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1/chat/completions`;
        
        const model = workersModelOverride || selectedModel;
        const upstream = await fetch(gatewayUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${gatewayToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages: enhancedMessages,
                stream: true,
                max_tokens: 2048,
            })
        });

        if (!upstream.ok) {
            const text = await upstream.text();
            return new Response(JSON.stringify({
                error: "AI Gateway Error",
                status: upstream.status,
                cf_ray: upstream.headers.get('cf-ray'),
                body: text,
            }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Pass through Gateway metadata headers for analytics display
        // Note: Header names from AI Gateway may vary, try multiple variations
        const traceId = upstream.headers.get('cf-aig-trace-id') || 
                       upstream.headers.get('x-cf-aig-trace-id') || 
                       upstream.headers.get('cf-aig-request-id') || '';
        const cacheStatus = upstream.headers.get('cf-cache-status') || 
                           upstream.headers.get('x-cf-cache-status') || '';
        const cfRay = upstream.headers.get('cf-ray') || 
                     upstream.headers.get('x-cf-ray') || '';
        
        return new Response(upstream.body, {
            headers: {
                ...corsHeaders,
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-CF-AIG-Trace-ID": traceId,
                "X-CF-Cache-Status": cacheStatus,
                "X-CF-Ray": cfRay,
                "X-Vectorize-Used": docContext ? "true" : "false",
            }
        });
    }

    try {
        const requestPayload = {
            model: "dynamic/support-agent",
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: query }
            ],
            stream: false,
        };

        if (routeModelOverride) {
            requestPayload.metadata = { model: routeModelOverride };
        }

        if (!shouldStream) {
            const completion = await client.chat.completions.create(requestPayload);
            const text = completion.choices?.[0]?.message?.content ?? "";
            const responseBody = { response: text };

            if (debugRaw) {
                const raw = JSON.parse(JSON.stringify(completion));
                if (Array.isArray(raw?.choices)) {
                    raw.choices = raw.choices.map((c) => {
                        const msg = c?.message;
                        if (msg && typeof msg === 'object') {
                            delete msg.reasoning_content;
                            delete msg.tool_calls;
                            delete msg.function_call;
                            delete msg.audio;
                            delete msg.annotations;
                        }
                        return c;
                    });
                }
                responseBody.raw = raw;
            }

            return new Response(JSON.stringify(responseBody), {
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const completion = await client.chat.completions.create(requestPayload);
        const fullText = completion.choices?.[0]?.message?.content ?? "";
        return new Response(JSON.stringify({ response: fullText }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (error) {
        const status = error?.status || error?.response?.status;
        const headers = error?.headers || error?.response?.headers;
        const requestId = headers?.get?.('cf-ray') || headers?.get?.('x-request-id') || headers?.get?.('cf-request-id');
        const errorMessage = error?.message;
        const errorBody = error?.response ? await error.response.text() : undefined;

        return new Response(JSON.stringify({
            error: "AI Gateway Error",
            status,
            request_id: requestId,
            message: errorMessage,
            body: errorBody,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
}

async function internalImageCall(prompt, env, isDiagram = false, selectedModel = null) {
    const baseGatewayUrl = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/replicate`;
    
    // Model configurations
    const MODELS = {
        'flux-schnell': {
            endpoint: `${baseGatewayUrl}/predictions`,
            version: "c846a69991daf4c0e5d016514849d14ee5b2e6846ce6b9d6f21369e564cfe51e",
            input: { go_fast: true, megapixels: "1", output_format: "png" },
            type: 'image'
        },
        'recraft-v3': {
            endpoint: `${baseGatewayUrl}/models/recraft-ai/recraft-v3/predictions`,
            input: { size: "1365x1024" },
            type: 'image'
        },
        'recraft-v3-svg': {
            endpoint: `${baseGatewayUrl}/models/recraft-ai/recraft-v3-svg/predictions`,
            input: { size: "1365x1024" },
            type: 'image',
            outputFormat: 'svg'
        },
        'nano-banana-pro': {
            endpoint: `${baseGatewayUrl}/models/google/nano-banana-pro/predictions`,
            input: { aspect_ratio: "16:9" },
            type: 'image'
        },
        'ideogram': {
            endpoint: `${baseGatewayUrl}/models/ideogram-ai/ideogram-v2/predictions`,
            input: { aspect_ratio: "1:1" },
            type: 'image'
        },
        'stable-diffusion': {
            endpoint: `${baseGatewayUrl}/predictions`,
            version: "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
            input: { width: 1024, height: 1024 },
            type: 'image'
        },
        'kling-v2.5': {
            endpoint: `${baseGatewayUrl}/models/kwaivgi/kling-v2.5-turbo-pro/predictions`,
            input: { duration: 5, aspect_ratio: "16:9" },
            type: 'video'
        },
        'wan-video': {
            endpoint: `${baseGatewayUrl}/models/wan-video/wan-2.2-t2v-fast/predictions`,
            input: { num_frames: 81 },
            type: 'video'
        }
    };
    
    let requestBody;
    let endpoint;
    
    // Determine which model to use
    let modelKey = selectedModel;
    if (!modelKey || modelKey === 'auto') {
        // Use Nano Banana Pro for diagrams (better text/layout), FLUX for general images
        modelKey = isDiagram ? 'nano-banana-pro' : 'flux-schnell';
    }
    
    const modelConfig = MODELS[modelKey] || MODELS['flux-schnell'];
    endpoint = modelConfig.endpoint;
    
    if (modelConfig.version) {
        // Version-based API (FLUX)
        requestBody = {
            version: modelConfig.version,
            input: { prompt, ...modelConfig.input }
        };
    } else {
        // Model name-based API (Recraft, Ideogram, SDXL)
        requestBody = {
            input: { prompt, ...modelConfig.input }
        };
    }
    
    let resp = await fetch(endpoint, {
        method: "POST", 
        headers: { 
            "Authorization": `Bearer ${env.CF_GATEWAY_TOKEN}`, 
            "Content-Type": "application/json", 
            "Prefer": "wait" 
        },
        body: JSON.stringify(requestBody)
    });
    
    let data = await resp.json();
    
    console.log('Replicate initial response:', JSON.stringify(data));
    
    // Handle timeout errors - retry with faster model for diagrams
    if (!resp.ok || data.error) {
        const errorStr = JSON.stringify(data.error || data);
        const isTimeout = errorStr.includes('deadline exceeded') || errorStr.includes('timeout');
        
        // If nano-banana-pro timed out, fallback to recraft-v3 which is faster
        if (isTimeout && modelKey === 'nano-banana-pro') {
            console.log('Nano Banana Pro timed out, falling back to Recraft V3...');
            const fallbackConfig = MODELS['recraft-v3'];
            const fallbackBody = { input: { prompt, ...fallbackConfig.input } };
            
            resp = await fetch(fallbackConfig.endpoint, {
                method: "POST", 
                headers: { 
                    "Authorization": `Bearer ${env.CF_GATEWAY_TOKEN}`, 
                    "Content-Type": "application/json", 
                    "Prefer": "wait" 
                },
                body: JSON.stringify(fallbackBody)
            });
            data = await resp.json();
            console.log('Fallback response:', JSON.stringify(data));
            
            if (!resp.ok || data.error) {
                throw new Error(JSON.stringify(data.error || data) || `Replicate error: ${resp.status}`);
            }
        } else {
            throw new Error(errorStr || `Replicate error: ${resp.status}`);
        }
    }
    
    // Handle async predictions that haven't completed yet
    if (data.status && (data.status === 'starting' || data.status === 'processing')) {
        console.log('Prediction is async, starting polling...');
        // If prediction is still processing, poll for completion
        const predictionId = data.id;
        const predictionUrl = data.urls?.web || (data.id ? `https://replicate.com/p/${data.id}` : null);
        
        // Construct poll URL through AI Gateway instead of using direct Replicate API
        const baseGatewayUrl = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/replicate`;
        const pollUrl = `${baseGatewayUrl}/predictions/${predictionId}`;
        
        console.log('Poll URL (via Gateway):', pollUrl);
        console.log('Prediction URL:', predictionUrl);
        
        if (predictionId) {
            let attempts = 0;
            const maxAttempts = 180; // 180 seconds (3 minutes) max wait
            
            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                
                console.log(`Polling attempt ${attempts + 1}/${maxAttempts}`);
                
                const pollResp = await fetch(pollUrl, {
                    headers: { "Authorization": `Bearer ${env.CF_GATEWAY_TOKEN}` }
                });
                const pollData = await pollResp.json();
                
                console.log(`Poll status: ${pollData.status}`);
                
                if (pollData.status === 'succeeded' && pollData.output) {
                    console.log('Video generation succeeded!');
                    console.log('Full pollData.output:', JSON.stringify(pollData.output));
                    
                    // Return the video URL and prediction URL
                    let videoUrl;
                    
                    // Handle different output formats
                    if (Array.isArray(pollData.output)) {
                        // Output is an array of URLs
                        videoUrl = pollData.output[0];
                    } else if (typeof pollData.output === 'string') {
                        // Output is a direct URL string
                        videoUrl = pollData.output;
                    } else if (typeof pollData.output === 'object' && pollData.output.url) {
                        // Output is an object with url property
                        videoUrl = pollData.output.url;
                    } else {
                        console.error('Unexpected output format:', pollData.output);
                        throw new Error('Unexpected video output format');
                    }
                    
                    console.log('Extracted video URL:', videoUrl);
                    
                    if (!videoUrl) {
                        console.error('No video URL found in output');
                        throw new Error('No video URL in successful response');
                    }
                    
                    // Return object with both video URL and prediction URL
                    return { url: videoUrl, predictionUrl };
                }
                
                if (pollData.status === 'failed' || pollData.status === 'canceled') {
                    console.error('Video generation failed:', pollData.error);
                    throw new Error(`Video generation ${pollData.status}: ${pollData.error || 'Unknown error'}`);
                }
                
                attempts++;
            }
            
            console.error('Video generation timed out');
            throw new Error('Video generation timed out after 180 seconds');
        } else {
            console.error('No prediction ID available');
            throw new Error('No prediction ID available for async prediction');
        }
    }
    
    // Recraft returns output differently - check for URL in output object
    if (data.output && typeof data.output === 'object' && data.output.url) {
        return data.output.url;
    }
    
    return Array.isArray(data.output) ? data.output[0] : data.output;
}

async function handleTranscribe(request, env, ctx, corsHeaders) {
    try {
        const body = await request.json();
        const dataUri = `data:${body.type};base64,${body.audio}`;
        const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/replicate/predictions`;
        const WHISPER_VERSION = "8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e";
        
        console.log('Transcription request started');
        
        const resp = await fetch(gatewayUrl, {
            method: "POST", 
            headers: { 
                "Authorization": `Bearer ${env.CF_GATEWAY_TOKEN}`, 
                "Content-Type": "application/json", 
                "Prefer": "wait" 
            },
            body: JSON.stringify({ 
                version: WHISPER_VERSION, 
                input: { 
                    audio: dataUri, 
                    transcription: "plain text" 
                } 
            })
        });
        
        if (!resp.ok) {
            console.error('Transcription API error:', resp.status, await resp.text());
            return new Response(JSON.stringify({ error: 'Transcription service error', text: null }), { 
                status: 500, 
                headers: { ...corsHeaders, "Content-Type": "application/json" } 
            });
        }
        
        const data = await resp.json();
        console.log('Transcription response:', JSON.stringify(data));
        
        // Extract text from various possible response formats
        let transcribedText = null;
        if (data.output) {
            if (typeof data.output === 'string') {
                transcribedText = data.output;
            } else if (data.output.transcription) {
                transcribedText = data.output.transcription;
            } else if (data.output.text) {
                transcribedText = data.output.text;
            }
        }
        
        console.log('Extracted text:', transcribedText);
        
        return new Response(JSON.stringify({ text: transcribedText }), { 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
    } catch (e) { 
        console.error('Transcription error:', e);
        return new Response(JSON.stringify({ error: e.message, text: null }), { 
            status: 500, 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }); 
    }
}

async function handleSaveToR2(request, env, corsHeaders) {
    try {
        const body = await request.json();
        
        // Handle SVG content directly
        if (body.isSvg && body.svgContent) {
            const filename = `diagram-${Date.now()}.svg`;
            await env.ASSETS_BUCKET.put(filename, body.svgContent, { 
                httpMetadata: { contentType: 'image/svg+xml' }, 
                customMetadata: { prompt: body.prompt || 'architecture diagram' } 
            });
            return new Response(JSON.stringify({ asset_url: `/api/v1/assets/${filename}` }), { 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            });
        }
        
        // Handle regular image URLs
        const imageResp = await fetch(body.imageUrl);
        const blob = await imageResp.blob();
        const contentType = imageResp.headers.get('content-type') || 'image/png';
        const ext = contentType.includes('svg') ? 'svg' : contentType.includes('webp') ? 'webp' : 'png';
        const filename = `gen-${Date.now()}.${ext}`;
        await env.ASSETS_BUCKET.put(filename, blob, { httpMetadata: { contentType }, customMetadata: { prompt: body.prompt } });
        return new Response(JSON.stringify({ asset_url: `/api/v1/assets/${filename}` }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
    } catch(e) { 
        return new Response(JSON.stringify({ error: e.message }), { 
            status: 500, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }); 
    }
}

async function handleServeAsset(url, env, corsHeaders) {
    const raw = decodeURIComponent(url.pathname.split('/').pop() || '');
    // Reject path traversal and absolute paths. Allow only safe filename characters.
    if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || !/^[A-Za-z0-9._-]+$/.test(raw)) {
        return new Response('Not found', { status: 404, headers: corsHeaders });
    }
    const object = await env.ASSETS_BUCKET.get(raw);
    if (!object) return new Response('Not found', { status: 404, headers: corsHeaders });
    const headers = new Headers(corsHeaders);
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    return new Response(object.body, { headers });
}

async function handleIngestDocs(request, env, corsHeaders) {
    try {
        // Parse options from request body
        const body = await request.json().catch(() => ({}));
        const options = {
            paths: body.paths || ['src/content/docs/ai-gateway'],
            maxChunkSize: body.maxChunkSize || 800,
            maxFilesPerPath: body.maxFilesPerPath || 20,
            offset: body.offset || 0
        };
        
        console.log('Starting documentation ingestion...', options);
        
        const result = await ingestDocsFromGitHub(env, options);
        
        return new Response(JSON.stringify({
            success: true,
            ...result,
            message: `Ingested ${result.totalFiles} files with ${result.totalChunks} chunks`
        }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        
    } catch (error) {
        console.error('Ingestion error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), { 
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

async function handleQueryDocs(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const query = body.query || body.q;
        
        if (!query) {
            return new Response(JSON.stringify({
                error: 'Missing query parameter'
            }), { 
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        
        const context = await queryVectorizeForContext(query, env, {
            topK: body.topK || 3,
            minScore: body.minScore || 0.7
        });
        
        return new Response(JSON.stringify({
            query,
            context,
            hasResults: !!context
        }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        
    } catch (error) {
        console.error('Query error:', error);
        return new Response(JSON.stringify({
            error: error.message
        }), { 
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}