import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import app from "./app";
import { XanoClient } from "./xano-client";
import { getShare } from "./share-store";

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
 * Main worker entry point
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // SSE and message endpoints for Workers AI Playground compatibility
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // Extract auth for SSE connections
      const authToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || 
                       url.searchParams.get("auth_token") || "";
      const userId = request.headers.get("x-user-id") || url.searchParams.get("user_id") || "";

      // Use server methods with stream transport
      if (request.url.includes("/sse/message")) {
        return new Response(JSON.stringify({ ok: true }));
      } else {
        // Create SSE stream response
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        
        // Send server info
        writer.write(encoder.encode(`event: server_info\ndata: {"name":"Xano MCP Server","version":"1.0.0","protocolVersion":"2025-03-26"}\n\n`));
        
        // Send tools list - manually define tools similar to how we registered them
        const toolsList = { 
          jsonrpc: "2.0", 
          id: "tools-list", 
          result: { 
            tools: [
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
            ] 
          }
        };
        writer.write(encoder.encode(`event: tools_list\ndata: ${JSON.stringify(toolsList)}\n\n`));
        
        // Signal ready
        writer.write(encoder.encode(`event: ready\ndata: {}\n\n`));
        
        // Return SSE response
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          }
        });
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
        // SSE stream response for GET requests
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        
        // Send server info
        writer.write(encoder.encode(`event: server_info\ndata: {"name":"Xano MCP Server","version":"1.0.0","protocolVersion":"2025-03-26"}\n\n`));
        
        // Send tools list - manually define tools similar to how we registered them
        const toolsList = { 
          jsonrpc: "2.0", 
          id: "tools-list", 
          result: { 
            tools: [
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
            ] 
          }
        };
        writer.write(encoder.encode(`event: tools_list\ndata: ${JSON.stringify(toolsList)}\n\n`));
        
        // Signal ready
        writer.write(encoder.encode(`event: ready\ndata: {}\n\n`));
        
        // Return SSE response
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          }
        });
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