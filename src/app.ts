import { Hono } from "hono";
import { layout, homeContent } from "./utils";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const app = new Hono<{ Bindings: Env }>();

// Homepage - keep this for documentation
app.get("/", async (c: any) => {
  const content = await homeContent(c.req.raw);
  return c.html(layout(content, "Snappy MCP - Home"));
});

// Simple health check endpoint
app.get("/health", (c: any) => {
  return c.json({
    status: "ok",
    message: "MCP server is running",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// Simplified token info endpoint (helpful for debugging)
app.get("/token-info", (c: any) => {
  const url = new URL(c.req.url);
  const token = url.searchParams.get('token');
  
  if (!token) {
    return c.json({ error: "No token provided" }, 400);
  }
  
  // Return basic token info (without revealing the full token)
  return c.json({
    token_provided: true,
    token_length: token.length,
    token_prefix: token.substring(0, 5) + "...",
    message: "Use this token with the SSE endpoint by appending ?auth_token=YOUR_TOKEN"
  });
});

// Connection guide endpoint
app.get("/connect-guide", (c: any) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Snappy MCP Connection Guide</title>
        <style>
          body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto; }
          code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <h1>Snappy MCP Connection Guide</h1>
        
        <h2>1. Get Authentication Token</h2>
        <p>First, authenticate with Xano to get your user token:</p>
        <pre><code>
POST https://xnwv-v1z6-dvnr.n7c.xano.io/api:e6emygx3/auth/login
{
  "email": "your-email@example.com",
  "password": "your-password"
}
        </code></pre>
        
        <h2>2. Connect to MCP Server</h2>
        <p>Use the token to connect to the MCP server:</p>
        <pre><code>
// Connect to the SSE endpoint with your token
const eventSource = new EventSource(
  "${c.req.url.split('/connect-guide')[0]}/sse?auth_token=YOUR_TOKEN&user_id=YOUR_USER_ID"
);

// Set up event listeners
eventSource.addEventListener('endpoint', (event) => {
  const messageEndpoint = JSON.parse(event.data);
  console.log('Message endpoint:', messageEndpoint);
});

// Handle messages
eventSource.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  console.log('Message received:', message);
});
        </code></pre>
        
        <h2>3. Initialize MCP Communication</h2>
        <p>After connecting, initialize the MCP protocol:</p>
        <pre><code>
// Initialize
fetch(messageEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 0,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { sampling: {} },
      clientInfo: { name: "mcp-client", version: "1.0.0" }
    }
  })
});

// Request tool list
fetch(messageEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/list"
  })
});
        </code></pre>
      </body>
    </html>
  `);
});

export default app;