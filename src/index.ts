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
  accessToken: string;
  user: { id: string };
  [key: string]: unknown;
}

/**
 * MCP agent implementation with simplified transport handling.
 * Focuses exclusively on SSE transport (most reliable) and implements
 * only the essential lifecycle methods needed by the MCP protocol.
 */
export class MyMCP extends McpAgent<Env, unknown, Props> {
  /** Core MCP server instance for tool handling. */
  server = new McpServer({
    name: "Xano MCP Server",
    version: "1.0.0",
    protocolVersion: "2025-03-26" // Required by MCP spec
  });
  
  /** ID for tracking SSE connections */
  sessionId!: string;

  /** Lazily initialized Xano client */
  private _xano?: XanoClient;
  private get xano() {
    if (!this._xano) {
      this._xano = new XanoClient((this.env as any).XANO_BASE_URL, this.props.accessToken);
    }
    return this._xano;
  }

  /**
   * Extract authentication data from request.
   * Supports both header-based and query param authentication.
   */
  async onConnect(request: Request) {
    const url = new URL(request.url);
    console.log('[MCP onConnect] New connection');
    
    // Extract auth token from multiple sources
    const authHeader = request.headers.get("authorization") || "";
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const bearerToken = bearerMatch ? bearerMatch[1] : "";
    const authToken = bearerToken || url.searchParams.get("auth_token") || "";
    
    // Extract user ID from header or query param
    const userId = request.headers.get("x-user-id") || url.searchParams.get("user_id") || "";
    
    // Store session ID for SSE connections
    this.sessionId = url.searchParams.get("sessionId") || "default-session";
    
    return { accessToken: authToken, user: { id: userId } };
  }

  /**
   * Initialize tool registrations.
   * Called once per authenticated session.
   */
  async init() {
    console.log('[MCP init] Registering tools');
    
    // Register Xano-powered tools
    this.server.tool(
      "mcp0_xano_list_instances",
      {},
      async () => {
        const result = await this.xano.listInstances();
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    );
    
    // Demo add tool that runs on the edge
    this.server.tool(
      "add",
      {
        a: z.number(),
        b: z.number(),
      },
      async ({ a, b }) => {
        console.log(`[Tool add] ${a} + ${b}`);
        const result = String(a + b);
        return { content: [{ type: "text", text: result }] };
      },
    );
    
    // More comprehensive calculator tool 
    this.server.tool(
      "calculate",
      {
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      },
      async ({ operation, a, b }) => {
        let result: number | string;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0) {
              return {
                content: [{ type: "text", text: "Error: Cannot divide by zero" }]
              };
            }
            result = a / b;
            break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      }
    );
  }
}

/**
 * Main worker entry point - handles routing for all requests
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Handle /sse and /sse/message for Workers AI Playground compatibility
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      const agentClass = MyMCP as any; // Cast to any to access static methods
      return agentClass.connect({
        env,
        dispatchFetch: (req) => agentClass.prototype.fetch.call({ env }, req, ctx)
      }).fetch(request);
    }

    // Standard MCP endpoint with support for share tokens
    if (url.pathname === "/mcp") {
      // Check for share token first
      const authHeader = request.headers.get("authorization") || "";
      const bearer = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1] || url.searchParams.get("auth_token") || "";
      
      const share = await getShare(bearer, env);
      if (share) {
        // Rewrite headers for shared token access
        const newHeaders = new Headers(request.headers);
        newHeaders.set("authorization", `Bearer ${share.xanoToken}`);
        newHeaders.set("x-user-id", share.userId);
        const newReq = new Request(request, { headers: newHeaders });
        
        // Use static connect method with the rewritten request
        const agentClass = MyMCP as any; // Cast to any to access static methods
        return agentClass.connect({
          env,
          dispatchFetch: (req) => agentClass.prototype.fetch.call({ env }, req, ctx)
        }).fetch(newReq);
      }
      
      // Regular MCP request using static connect method
      const agentClass = MyMCP as any; // Cast to any to access static methods
      return agentClass.connect({
        env,
        dispatchFetch: (req) => agentClass.prototype.fetch.call({ env }, req, ctx)
      }).fetch(request);
    }

    // All other requests go to the app handler
    return app.fetch(request, env, ctx);
  },
};