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

    // Set props for this session
    this.props = {
      accessToken: authToken,
      user: { id: userId }
    };

    try {
      // Initialize on first request
      if (!this._initialized) {
        await this.init();
        this._initialized = true;
      }
      return await this.server.fetch(request);
    } catch (error) {
      console.error("Error in MyMCP fetch:", error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
  }

  /** Initialize MCP server with tools */
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
      const schema = z.record(z.any());
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
      { a: z.number(), b: z.number() },
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
    
    // Handle SSE requests for MCP
    if (url.pathname === "/sse") {
      // Create a new unique ID for this DO instance
      const id = env.MCP_OBJECT.newUniqueId();
      // Get a stub for the DO with this ID
      const stub = env.MCP_OBJECT.get(id);
      // Forward the request to the DO
      return stub.fetch(request);
    }
    
    // Everything else goes to the app (home page, health check)
    return app.fetch(request, env, ctx);
  },
};