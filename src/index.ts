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

  /**
   * Extract token and user ID from the first request
   */
  async onConnect(request: Request) {
    const url = new URL(request.url);
    const authToken = url.searchParams.get("auth_token");
    const userId = url.searchParams.get("user_id");

    if (!authToken || !userId) {
      throw new Error("Missing required auth_token and user_id parameters");
    }

    // Set props for this session
    this.props = {
      accessToken: authToken,
      user: { id: userId }
    };

    return super.onConnect(request);
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
      return env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId()).fetch(request);
    }
    
    // Everything else goes to the app (home page, health check)
    return app.fetch(request, env, ctx);
  },
};