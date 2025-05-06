import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import app from "./app";
import { XanoClient } from "./xano-client";
import { getShare } from "./share-store";

// Dummy Durable Object class to satisfy wrangler config
export class MyMCP {
  private state: DurableObjectState;
  private env: Env;
  
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // This is a placeholder, the real functionality is in the main worker
  }

  async fetch(request: Request): Promise<Response> {
    // We're not actually using this, all functionality is in the main worker now
    return new Response("Durable object not used - direct worker implementation is active", { status: 501 });
  }
}

// Define our tool specs for consistent use
const TOOL_SPECS = [
  {
    name: "add",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" }
      },
      required: ["a", "b"]
    }
  },
  {
    name: "calculate",
    description: "Calculate using various operations",
    parameters: {
      type: "object",
      properties: {
        operation: { 
          type: "string", 
          enum: ["add", "subtract", "multiply", "divide"] 
        },
        a: { type: "number" },
        b: { type: "number" }
      },
      required: ["operation", "a", "b"]
    }
  }
];

// Create a shared MCP server instance
const server = new McpServer({
  name: "Xano MCP Server",
  version: "1.0.0",
  protocolVersion: "2025-03-26"
});

// Register tools with the server
server.tool(
  "add",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => {
    console.log(`[Tool add] Adding ${a} + ${b}`);
    const result = String(a + b);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
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

/**
 * Creates a Xano client instance based on the auth token
 */
function getXanoClient(env: Env, authToken: string) {
  return new XanoClient(env.XANO_BASE_URL, authToken);
}

/**
 * Helper to create an SSE stream with proper MCP protocol events
 */
function createSseResponse(ctx: ExecutionContext) {
  // Create the transform stream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // Set up the events in a waitUntil context
  if (ctx) {
    ctx.waitUntil((async () => {
      try {
        // 1. Send server_info event
        await writer.write(encoder.encode(`event: server_info
data: {"name":"Xano MCP Server","version":"1.0.0","protocolVersion":"2025-03-26"}

`));
        
        // 2. Send tools_list event
        const toolsList = {
          jsonrpc: "2.0",
          id: "tools-list",
          result: { tools: TOOL_SPECS }
        };
        await writer.write(encoder.encode(`event: tools_list
data: ${JSON.stringify(toolsList)}

`));
        
        // 3. Send ready event
        await writer.write(encoder.encode(`event: ready
data: {}

`));
        
        // Keep connection alive with heartbeats
        const heartbeatInterval = setInterval(async () => {
          try {
            await writer.write(encoder.encode(`: heartbeat

`));
          } catch (error) {
            clearInterval(heartbeatInterval);
          }
        }, 15000);
        
        // Clean up after 30 minutes
        setTimeout(() => {
          clearInterval(heartbeatInterval);
          writer.close().catch(console.error);
        }, 30 * 60 * 1000);
        
      } catch (error) {
        console.error("SSE stream error:", error);
        try {
          await writer.close();
        } catch (closeError) {
          console.error("Error closing writer:", closeError);
        }
      }
    })());
  }
  
  // Return the Response with the readable stream
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

/**
 * Main worker entry point
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // SSE and message endpoints for Workers AI Playground compatibility
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // Extract auth info from the request
      const authToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || 
                       url.searchParams.get("auth_token") || "";
      const userId = request.headers.get("x-user-id") || url.searchParams.get("user_id") || "";
      console.log(`[/sse] Connection from user: ${userId || 'anonymous'}`);
      
      // Handle message endpoint
      if (url.pathname === "/sse/message") {
        return new Response(JSON.stringify({ ok: true }));
      } else {
        // Return SSE stream for /sse endpoint
        return createSseResponse(ctx);
      }
    }

    // Standard MCP endpoint
    if (url.pathname === "/mcp") {
      // Check for auth token
      const authHeader = request.headers.get("authorization") || "";
      const bearer = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1] || url.searchParams.get("auth_token") || "";
      
      if (!bearer) {
        return new Response(JSON.stringify({ error: "Missing authentication token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Check if this is a share token
      const share = await getShare(bearer, env);
      if (share) {
        console.log("[/mcp] Using share token for", share.userId);
        // Clone request with the real token
        const newHeaders = new Headers(request.headers);
        newHeaders.set("authorization", `Bearer ${share.xanoToken}`);
        newHeaders.set("x-user-id", share.userId);
        request = new Request(request.url, {
          method: request.method,
          headers: newHeaders,
          body: request.body  
        });
      }
      
      // Handle MCP protocol based on request method
      if (request.method === "GET") {
        return createSseResponse(ctx);
      } else {
        // Handle JSON-RPC calls for POST requests
        try {
          const body = await request.json() as any;
          const method = body.method;
          const params = body.params || {};
          const id = body.id;
          
          // Execute the appropriate tool based on method name
          let result;
          if (method === "add") {
            const { a, b } = params;
            const value = String(a + b);
            result = { content: [{ type: "text", text: value }] };
          } else if (method === "calculate") {
            const { operation, a, b } = params;
            let value;
            switch (operation) {
              case "add":
                value = a + b;
                break;
              case "subtract":
                value = a - b;
                break;
              case "multiply":
                value = a * b;
                break;
              case "divide":
                if (b === 0) {
                  return new Response(JSON.stringify({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { content: [{ type: "text", text: "Error: Cannot divide by zero" }] }
                  }), {
                    headers: { "Content-Type": "application/json" }
                  });
                }
                value = a / b;
                break;
              default:
                throw new Error(`Unknown operation: ${operation}`);
            }
            result = { content: [{ type: "text", text: String(value) }] };
          } else {
            throw new Error(`Unknown method: ${method}`);
          }
          
          // Return JSON-RPC response
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result
          }), {
            headers: {
              "Content-Type": "application/json"
            }
          });
        } catch (error) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: "Internal error",
              data: error.message
            }
          }), {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          });
        }
      }
    }
    
    // Default to app router
    return app.fetch(request, env, ctx);
  }
};
