import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "@modelcontextprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import app from "./app";
import { XanoClient } from "./xano-client";

/**
 * Shape of the props object attached to each authenticated session by the
 * OAuth provider. These values come from the `/callback` handler in
 * `app.ts`, which stores them via `completeAuthorization`.
 */
export interface Props {
  user: { id: string };
  accessToken: string;
  /** Additional metadata or permissions the user may have */
  permissions?: string[];
  [key: string]: unknown;
}

/**
 * A **minimal** McpAgent implementation that delegates all real work to Xano:
 *   • Authentication: handled by the OAuth provider (token + user id)
 *   • Tool definitions: fetched from Xano via `list_functions`
 *   • Tool execution: proxied to Xano via `mcp_execute`
 */
class MyMCP extends McpAgent<Env, unknown, Props> {
  /** SDK-level MCP server instance exposed over `/sse` */
  public readonly server = new McpServer({
    name: "Xano MCP Server",
    version: "1.0.0",
  });

  /** Lazily initialised Xano client (per session) */
  private get xano(): XanoClient {
    if (!this._xano) {
      this._xano = new XanoClient(this.env.XANO_BASE_URL, this.props.accessToken);
    }
    return this._xano;
  }
  private _xano?: XanoClient;

  /** Called automatically by `McpAgent` exactly once per session */
  async init() {
    // Ensure the session is registered on Xano so it can track tool usage.
    try {
      await this.xano.registerSession(this.sessionId, this.props.user.id, {
        name: "remote-mcp-server",
        version: "1.0.0",
      });
    } catch (err) {
      console.error("Failed to register session with Xano", err);
    }

    // Retrieve all available tool definitions for this user.
    let tools;
    try {
      tools = await this.xano.getToolDefinitions(this.props.user.id, this.sessionId);
    } catch (err) {
      console.error("Failed to fetch tool definitions from Xano", err);
      tools = [];
    }

    // Register each tool with the MCP server. We use a very permissive Zod
    // schema so we don’t need to perfectly mirror Xano’s parameter schema.
    tools.forEach((tool) => {
      const schema = z.record(z.any());
      this.server.tool(
        tool.name,
        tool.description || "",
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
  }
}

// ---------------------------------------------------------------------------
// Worker entry: combine OAuthProvider for login + MCP API for /sse
// ---------------------------------------------------------------------------

export default new OAuthProvider({
  apiRoute: "/sse",
  apiHandler: MyMCP.mount("/sse") as any,
  defaultHandler: app as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});