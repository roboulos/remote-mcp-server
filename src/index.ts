import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import app from "./app";
import { XanoClient } from "./xano-client";

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
  /** Core MCP server instance exposed on `/sse`. */
  public readonly server = new McpServer({
    name: "Xano MCP Server",
    version: "1.0.0",
  });

  private _xano?: XanoClient;
  private get xano() {
    if (!this._xano) {
      this._xano = new XanoClient(this.env.XANO_BASE_URL, this.props.accessToken);
    }
    return this._xano;
  }

  private _initialized = false;
  private _registeredTools = new Set<string>();

  /**
   * Handle fetch requests to the Durable Object
   */
  async fetch(request: Request) {
    const url = new URL(request.url);
    const authToken = url.searchParams.get("auth_token");
    const userId = url.searchParams.get("user_id");

    if (!authToken || !userId) {
      return new Response("Missing required auth_token and user_id parameters", { status: 400 });
    }

    try {
      // Set props for this session
      this.props = {
        accessToken: authToken,
        user: { id: userId }
      };
      
      // Set the sessionId explicitly - needed for Xano calls
      this.sessionId = url.searchParams.get("session_id") || crypto.randomUUID();

      // Initialize on first request
      if (!this._initialized) {
        await this.init();
        this._initialized = true;
      }
      
      // Use connect method from the parent McpAgent class
      return await this.connect(request);
    } catch (error) {
      console.error("Error in MyMCP fetch:", error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
  }

  /** Initialize MCP server with tools */
  async init() {
    console.log("Initializing MCP server for session:", this.sessionId);
    
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
      if (this._registeredTools.has(tool.name)) {
        console.log(`Tool ${tool.name} already registered, skipping`);
        return;
      }
      
      const schema = z.record(z.any());
      try {
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
        this._registeredTools.add(tool.name);
      } catch (err) {
        console.error(`Error registering tool ${tool.name}:`, err);
      }
    });

    // 4. Bonus sample "add" tool (always available).
    if (!this._registeredTools.has("add")) {
      try {
        this.server.tool(
          "add",
          "Add two numbers on the edge",
          { a: z.number(), b: z.number() },
          async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
        );
        this._registeredTools.add("add");
      } catch (err) {
        console.error("Error registering add tool:", err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main worker entry point - route requests appropriately
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // Handle SSE requests for MCP
    if (url.pathname === "/sse") {
      // Always use the same DO ID for the same auth token/user ID combo
      // This ensures we don't create a new DO for reconnections
      const authToken = url.searchParams.get("auth_token") || "";
      const userId = url.searchParams.get("user_id") || "";
      
      // Create a stable ID based on the auth token and user ID
      const sessionIdBasis = `${authToken}:${userId}`;
      // Use a hash of the credentials as the stable DO ID
      const id = env.MCP_OBJECT.idFromName(sessionIdBasis);
      
      // Get a stub for the DO with this ID
      const stub = env.MCP_OBJECT.get(id);
      
      // Generate session ID if not provided
      if (!url.searchParams.get("session_id")) {
        url.searchParams.set("session_id", crypto.randomUUID());
        // Reconstruct the request with the session ID
        const newRequest = new Request(url, request);
        // Forward the enhanced request to the DO
        return stub.fetch(newRequest);
      }
      
      // Forward the request to the DO
      return stub.fetch(request);
    }
    
    // Everything else goes to the app (home page, health check)
    return app.fetch(request, env, ctx);
  },
};