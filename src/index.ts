import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { XanoClient } from "./xano-client";

// Configuration for the Xano API comes from environment variables
// This will be set in wrangler.jsonc and accessed through env

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Snappy MCP",
    version: "1.0.0",
  });

  private xanoClient: XanoClient | undefined;
  private registeredTools = new Set<string>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  initXanoClient(env: any) {
    if (!this.xanoClient) {
      const xanoBaseUrl = env.XANO_BASE_URL || "https://x8ki-letl-twmt.n7.xano.io/api:snappy";
      const xanoApiKey = env.XANO_API_KEY || "";
      this.xanoClient = new XanoClient(xanoBaseUrl, xanoApiKey);
    }
    return this.xanoClient!;
  }

  async init() {
    // Register a basic add tool directly (as a fallback)
    this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));
  }

  // Add a method to load and register all tools from Xano
  async loadXanoTools(env: any, sessionId: string) {
    try {
      const xanoClient = this.initXanoClient(env);
      const tools = await xanoClient.getTools(sessionId);
      for (const tool of tools) {
        if (tool.active && !this.registeredTools.has(tool.name)) {
          const paramSchema = this.convertJsonSchemaToZod(tool.input_schema);
          // Register the tool with a handler that delegates to Xano
          this.server.tool(tool.name, paramSchema, async (params, env) => {
            try {
              const result = await xanoClient.executeTool(tool.name, params, sessionId);
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (error) {
              return {
                content: [{ type: "text", text: `Error executing tool: ${error instanceof Error ? error.message : String(error)}` }],
              };
            }
          });
          this.registeredTools.add(tool.name);
        }
      }
    } catch (error) {
      console.error("Failed to load tools from Xano:", error instanceof Error ? error : String(error));
    }
  }

  // Helper method to convert JSON schema to Zod schema
  // This is a simplified version and might need to be expanded based on your schemas
  private convertJsonSchemaToZod(jsonSchema: any) {
    const schema: Record<string, any> = {};
    if (jsonSchema && jsonSchema.properties) {
      Object.entries(jsonSchema.properties).forEach(([key, value]: [string, any]) => {
        switch (value.type) {
          case "string":
            schema[key] = z.string();
            break;
          case "number":
            schema[key] = z.number();
            break;
          case "boolean":
            schema[key] = z.boolean();
            break;
          case "object":
            schema[key] = z.object(this.convertJsonSchemaToZod(value));
            break;
          case "array":
            if (value.items && value.items.type === "string") {
              schema[key] = z.array(z.string());
            } else if (value.items && value.items.type === "number") {
              schema[key] = z.array(z.number());
            } else {
              schema[key] = z.array(z.any());
            }
            break;
          default:
            schema[key] = z.any();
        }
        if (jsonSchema.required && !jsonSchema.required.includes(key)) {
          schema[key] = schema[key].optional();
        }
      });
    }
    return schema;
  }

  // Override the onRequest method to add session tracking and logging
  async onRequest(request: Request, env: any, ctx: any): Promise<Response> {
    const sessionId = request.headers.get("X-Session-ID") || crypto.randomUUID();
    const userId = parseInt(request.headers.get("X-User-ID") || "0", 10);
    const startTime = Date.now();
    const xanoClient = this.initXanoClient(env);
    try {
      await xanoClient.createSession(sessionId, userId, {
        userAgent: request.headers.get("User-Agent"),
        ip: request.headers.get("CF-Connecting-IP"),
      });
      await this.loadXanoTools(env, sessionId);
      const response = await (this.server as any).handleRequest(request, env, ctx);
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
}

// Export the OAuth handler as the default
// Export the OAuth handler as the default for the Worker
const oauthProvider = new OAuthProvider({
  apiRoute: "/sse",
  apiHandler: MyMCP.mount("/sse"),
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register"
});

// Zero-error, fully type-safe Cloudflare Worker export
import type { ExportedHandler, ExecutionContext } from '@cloudflare/workers-types';

const handler: ExportedHandler = {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    // Adapt the arguments as needed for OAuthProvider
    // All types are now explicit and compatible
    return await oauthProvider.fetch(
      request,
      env,
      ctx
    );
  }
};

export default handler;