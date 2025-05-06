import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import app from "./app";
import { XanoClient } from "./xano-client";
import { getShare } from "./share-store";

/**
 * Props for authenticated sessions - passed directly via URL parameters
 */
export interface Props {
  user: { id: string };
  accessToken: string;
  [key: string]: unknown;
}

/**
 * Minimal MCP agent that delegates tool discovery & execution to Xano.
 */
export class MyMCP extends McpAgent<Env, unknown, Props> {
  /** Core MCP server instance exposed on `/mcp`. */
  public readonly server = new McpServer({
    name: "Xano MCP Server",
    version: "1.0.0",
  });
  public sessionId!: string;

  private _xano?: XanoClient;
  private get xano() {
    if (!this._xano) {
      this._xano = new XanoClient(this.env.XANO_BASE_URL, this.props.accessToken);
    }
    return this._xano;
  }
  
  /**
   * Handle HTTP requests according to the MCP protocol.
   * GET requests use SSE for streaming, POST requests use JSON-RPC.
   */
  async fetch(request: Request): Promise<Response> {
    // For GET requests, set up SSE transport
    if (request.method === "GET") {
      // Create a TransformStream for the SSE response
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      
      // Create a proper SSE transport with all required methods
      const transport = {
        type: "sse",
        start: async () => {
          // Send the initial connection event
          await writer.write(new TextEncoder().encode(`event: open
data: {"sessionId":"${this.sessionId}"}

`));
        },
        send: async (message: string) => {
          await writer.write(new TextEncoder().encode(`data: ${message}

`));
        },
        close: async () => {
          await writer.close();
        }
      };
      
      // Connect the transport to the MCP server
      await this.server.connect(transport);
      
      // Return an SSE response
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    } 
    // For POST requests, handle JSON-RPC
    else if (request.method === "POST") {
      try {
        // Get the JSON-RPC request body
        const body = await request.json() as any;
        
        // Process the JSON-RPC message
        // Create a one-time transport for handling this request
        let responseData = null;
        const transport = {
          type: "json-rpc",
          start: async () => {},
          send: async (message) => {
            // Store the response to return it when done
            responseData = message;
          },
          close: async () => {}
        };
        
        // Connect and process the request
        await this.server.connect(transport);
        
        // Process the message on the transport
        if (typeof body === 'object') {
          // Send the request to the server for processing
          await transport.send(body);
        }
        
        // Return the JSON response
        return new Response(JSON.stringify(responseData), {
          headers: {
            "Content-Type": "application/json"
          }
        });
      } catch (error) {
        console.error("Error handling JSON-RPC request:", error);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error",
            data: error.message
          },
          id: null
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
    }
    
    // Method not allowed for other request types
    return new Response("Method Not Allowed", { status: 405 });
  }

  /**
   * Extract access token (Bearer) and user ID from headers on first request.
   * Falls back to query params for legacy clients.
   */
  async onConnect(request: Request) {
    // Prefer Authorization header: "Bearer <token>"
    const authHeader = request.headers.get("authorization") || "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const authToken = tokenMatch?.[1] ?? new URL(request.url).searchParams.get("auth_token") ?? "";

    // Custom header for user id, fallback to query param
    const userId = request.headers.get("x-user-id") ?? new URL(request.url).searchParams.get("user_id") ?? "";

    if (!authToken || !userId) {
      throw new Error("Missing Authorization Bearer token or X-User-Id header");
    }

    // Set props for this session
    this.props = {
      accessToken: authToken,
      user: { id: userId },
    };

    return;
  }

  /** Called once per authenticated session. */
  async init() {
    // 1. Let Xano know we started a session (best-effort).
    try {
      await this.xano.registerSession(this.sessionId, this.props.user.id, {
        name: "remote-mcp-server",
        version: "1.0.0",
      });
    } catch (err) {
      console.warn("Unable to register session with Xano", err);
    }

    // 2. Fetch tool definitions for this user.
    let tools = [] as Awaited<ReturnType<typeof this.xano.getToolDefinitions>>;
    try {
      tools = await this.xano.getToolDefinitions(this.props.user.id, this.sessionId);
    } catch (err) {
      console.error("Failed to load tool definitions from Xano", err);
    }

    // 3. Register each tool with a permissive schema that accepts any JSON.
    tools.forEach((tool) => {
      const schema = z.object({}).catchall(z.any()) as any;
      this.server.tool(
        tool.name,
        tool.description ?? "",
        schema,
        async (args) => {
          const result = await this.xano.executeFunction(
            tool.name,
            args ?? {},
            this.sessionId,
            this.props.user.id,
          );
          return { content: [{ type: "json", json: result }] } as const;
        },
      );
    });

    // 4. Bonus sample "add" tool (always available).
    this.server.tool(
      "add",
      "Add two numbers on the edge",
      { a: z.number(), b: z.number() } as any,
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
    );
  }
}

// ---------------------------------------------------------------------------
// Main worker entry point - route requests appropriately
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Route MCP traffic (both POST & GET) to durable object
    if (url.pathname === "/mcp") {
      // Extract bearer (might be share token or raw xano token)
      const authHeader = request.headers.get("authorization") || "";
      const bearer = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1] || url.searchParams.get("auth_token") || "";

      // Check if bearer is a share token
      const share = await getShare(bearer, env);
      if (share) {
        // Rewrite headers so DO sees real Xano token & user id
        const newHeaders = new Headers(request.headers);
        newHeaders.set("authorization", `Bearer ${share.xanoToken}`);
        newHeaders.set("x-user-id", share.userId);
        const newReq = new Request(request as any, { headers: newHeaders } as RequestInit);
        const id = env.MCP_OBJECT.idFromName(`${share.xanoToken}:${share.userId}`);
        return env.MCP_OBJECT.get(id).fetch(newReq);
      }

      // Fallback: treat bearer as xano token directly (legacy)
      const userId = request.headers.get("x-user-id") || url.searchParams.get("user_id") || "";
      const id = env.MCP_OBJECT.idFromName(`${bearer}:${userId}`);
      return env.MCP_OBJECT.get(id).fetch(request);
    }

    // Everything else goes to the app (home page, health check)
    return app.fetch(request, env, ctx);
  },
};