import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { XanoClient } from "./xano-client";

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0",
  });
  private xanoClient: XanoClient | null = null;

  private initXanoClient(env: any) {
    if (!this.xanoClient) {
      const xanoBaseUrl = env.XANO_BASE_URL || "https://x8ki-letl-twmt.n7.xano.io/api:snappy";
      const xanoApiKey = env.XANO_API_KEY || "";
      this.xanoClient = new XanoClient(xanoBaseUrl, xanoApiKey);
    }
    return this.xanoClient;
  }

  async init() {
    // Fallback tool
    this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));
  }

  async loadXanoTools(env: any) {
    try {
      const xanoClient = this.initXanoClient(env);
      console.log("[MCP] Loading tools from Xano...");
      const tools = await xanoClient.getTools();
      console.log("[MCP] Tools from Xano:", tools.map(t => t.name));
      const registeredToolNames = new Set(Object.keys((this.server as any)._tools ?? {}));
      for (const tool of tools) {
        if (tool.active && !registeredToolNames.has(tool.name)) {
          // For demo: treat all params as any (use a Zod object, not record)
          this.server.tool(tool.name, {}, async (params: Record<string, unknown>) => {
            try {
              const result = await xanoClient.executeTool(tool.name, params);
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              return { content: [{ type: "text", text: `Xano error: ${error instanceof Error ? error.message : String(error)}` }] };
            }
          });
        }
      }
    } catch (error) {
      console.error("[MCP] Failed to load tools from Xano:", error);
    }
  }

  // Use middleware to wrap all requests for session/logging
  middleware = async (request: Request, env: any, ctx: any, next: () => Promise<Response>) => {
    const sessionId = request.headers.get("X-Session-ID") || crypto.randomUUID();
    const userId = parseInt(request.headers.get("X-User-ID") || "0", 10);
    const startTime = Date.now();
    const xanoClient = this.initXanoClient(env);
    try {
      // Create session in Xano
      await xanoClient.createSession(sessionId, userId, {
        userAgent: request.headers.get("User-Agent"),
        ip: request.headers.get("CF-Connecting-IP"),
      });
      // Load tools from Xano
      await this.loadXanoTools(env);
      // Process the request
      const response = await next();
      // Log request
      await xanoClient.logMcpRequest(
        sessionId,
        userId,
        request.method,
        { url: request.url, headers: Object.fromEntries(request.headers.entries()) },
        { status: response.status },
        "",
        Date.now() - startTime,
        request.headers.get("CF-Connecting-IP") || ""
      );
      return response;
    } catch (error) {
      await xanoClient.logMcpRequest(
        sessionId,
        userId,
        request.method,
        { url: request.url, headers: Object.fromEntries(request.headers.entries()) },
        null,
        error instanceof Error ? error.message : String(error),
        Date.now() - startTime,
        request.headers.get("CF-Connecting-IP") || ""
      );
      throw error;
    }
  }

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // Register the middleware
    (this.server as any).use?.(this.middleware.bind(this));
  }
}


// Export the OAuth handler as the default
export default new OAuthProvider({
	apiRoute: "/sse",
	// TODO: fix these types
	// @ts-ignore
	apiHandler: MyMCP.mount("/sse"),
	// @ts-ignore
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});
