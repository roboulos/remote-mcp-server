import { Hono } from "hono";
import type { Env } from "./types";
import { generateToken, saveShare, revokeShare } from "./share-store";

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
        
        <h2>Connection</h2>
        <p>Connect with your Xano token and user ID:</p>
        <pre><code>/sse?auth_token=YOUR_XANO_TOKEN&user_id=YOUR_USER_ID</code></pre>
        
        <h2>Using with Claude Desktop, Cursor, etc.</h2>
        <p>Use the <code>mcp-remote</code> proxy:</p>
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

// ---------------------------------------------------------------------------
// API: create-share & revoke-share (dev–in-memory)
// ---------------------------------------------------------------------------

app.post("/api/create-share", async (c) => {
  const body = await c.req.json<{ xanoToken: string; userId: string }>();
  if (!body?.xanoToken || !body?.userId) {
    return c.json({ error: "xanoToken and userId required" }, 400);
  }
  const token = generateToken();
  await saveShare(token, body.xanoToken, body.userId, c.env);
  return c.json({ mcpUrl: new URL("/mcp", c.req.url).href, mcpToken: token });
});

app.post("/api/revoke-share", async (c) => {
  const body = await c.req.json<{ mcpToken: string }>();
  if (!body?.mcpToken) return c.json({ error: "mcpToken required" }, 400);
  await revokeShare(body.mcpToken, c.env);
  return c.json({ ok: true });
});

export default app;