import { Hono } from "hono";
import { layout } from "./utils";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";

// Define app with the imported Env type
const app = new Hono<{ Bindings: Env }>();

// Homepage - keep this for documentation
app.get("/", async (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Xano MCP Server</title>
        <style>
          body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto; }
          code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <h1>Xano MCP Server</h1>
        
        <h2>Connection Options</h2>
        
        <h3>1. Direct Token Authentication (For Web App)</h3>
        <p>Connect directly with your existing Xano token:</p>
        <pre><code>/sse?auth_token=YOUR_XANO_TOKEN&user_id=YOUR_USER_ID</code></pre>
        
        <h3>2. OAuth Flow (For External Clients)</h3>
        <p>Connect without a token to trigger the authentication flow:</p>
        <pre><code>/sse</code></pre>
        
        <h2>Using with Claude Desktop, Cursor, etc.</h2>
        <p>Use the <code>mcp-remote</code> proxy:</p>
        <pre><code>npx mcp-remote ${new URL("/sse", c.req.url).href}</code></pre>
        <p>Or with a direct token:</p>
        <pre><code>npx mcp-remote ${new URL("/sse", c.req.url).href}?auth_token=YOUR_XANO_TOKEN&user_id=YOUR_USER_ID</code></pre>
      </body>
    </html>
  `);
});

// Simple health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    message: "MCP server is running",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// Simple authorize endpoint that redirects to Xano login
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid request", 400);
  }

  // Store the state for callback
  const state = btoa(JSON.stringify(oauthReqInfo));
  
  // Redirect to Xano login
  const redirectUri = `${c.env.XANO_BASE_URL}/auth/login?callback=${
    encodeURIComponent(new URL("/callback", c.req.url).href)
  }&state=${encodeURIComponent(state)}`;
  
  return Response.redirect(redirectUri);
});

// Callback handler for OAuth flow
app.get("/callback", async (c) => {
  try {
    // Get state and token from query parameters
    const state = c.req.query("state");
    const token = c.req.query("token");
    const userId = c.req.query("user_id");
    
    if (!state || !token || !userId) {
      return c.text("Missing required parameters", 400);
    }
    
    // Parse the state
    const oauthReqInfo = JSON.parse(atob(state));
    if (!oauthReqInfo.clientId) {
      return c.text("Invalid state", 400);
    }
    
    // Complete the OAuth flow
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: userId,
      metadata: {},
      scope: [], // Replace with actual scopes/permissions if needed
      props: {
        accessToken: token,
        user: { id: userId }
      },
    });
    
    return Response.redirect(redirectTo);
  } catch (error) {
    console.error("Callback error:", error);
    return c.text("Authentication error", 500);
  }
});

// Simple token endpoint required by OAuth spec
app.post("/token", async (c) => {
  try {
    // Generate a token based on the code provided
    const tokenResponse = await c.env.OAUTH_PROVIDER.handleTokenRequest(c.req.raw);
    return new Response(tokenResponse.body, {
      status: tokenResponse.status,
      headers: tokenResponse.headers,
    });
  } catch (error) {
    console.error("Token error:", error);
    return c.json({ error: "invalid_request" }, 400);
  }
});

// Simple registration endpoint required by OAuth spec
app.post("/register", async (c) => {
  // This is a minimal implementation
  const registrationResponse = await c.env.OAUTH_PROVIDER.handleRegistrationRequest(c.req.raw);
  return new Response(registrationResponse.body, {
    status: registrationResponse.status,
    headers: registrationResponse.headers,
  });
});

export default app;