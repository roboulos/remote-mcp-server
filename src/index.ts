import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// This server implements MCP (Model Context Protocol) over SSE
// TypeScript types are commented out to avoid import errors
// Type definitions would be as follows:
// import type { RequestHandlerExtra, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types";

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
    protocolVersion: "2025-03-26" // Specify protocol version per MCP spec
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
   * @param request The incoming request
   * @param ctx ExecutionContext for managing long-running operations
   */
  async fetch(request: Request, ctx?: ExecutionContext): Promise<Response> {
    console.log('[MCP fetch] Request method:', request.method, 'URL:', request.url);
    console.log('[MCP fetch] Headers:', JSON.stringify(Object.fromEntries([...request.headers.entries()])));
    
    // For GET requests, set up SSE transport
    if (request.method === "GET") {
      console.log('[MCP fetch GET] Setting up SSE transport');
      // Create a TransformStream for the SSE response
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      
      console.log('[MCP fetch GET] Session ID for SSE connection:', this.sessionId);
      
      // If we have an execution context, use it to keep the connection alive
      if (ctx) {
        ctx.waitUntil(new Promise((resolve) => {
          // This promise will keep the request alive until the client disconnects
          console.log('[MCP fetch GET] Using execution context to keep connection alive');
        }));
      }
      
      // Create a proper SSE transport with all required methods according to MCP 2025-03-26 spec
      const transport = {
        type: "sse",
        start: async () => {
          console.log('[SSE transport.start] Starting SSE transport');
          try {
            const encoder = new TextEncoder();
            
            // 1. Send server_info event (required by MCP spec)
            console.log('[SSE transport.start] Sending server_info event');
            await writer.write(encoder.encode(`event: server_info
data: {"name":"Xano MCP Server","version":"1.0.0","protocolVersion":"2025-03-26"}

`));
            console.log('[SSE transport.start] server_info event sent successfully');
            
            // 2. Send tools_list event (required by MCP spec)
            console.log('[SSE transport.start] Sending tools_list event');
            const toolsList = {
              jsonrpc: "2.0",
              id: "tools-list",
              result: {
                tools: [{
                  name: "add",
                  description: "Add two numbers on the edge",
                  parameters: {
                    type: "object",
                    properties: {
                      a: { type: "number" },
                      b: { type: "number" }
                    },
                    required: ["a", "b"]
                  }
                }]
              }
            };
            await writer.write(encoder.encode(`event: tools_list
data: ${JSON.stringify(toolsList)}

`));
            console.log('[SSE transport.start] tools_list event sent successfully');
            
            // 3. Send ready event (required by MCP spec)
            console.log('[SSE transport.start] Sending ready event');
            await writer.write(encoder.encode(`event: ready
data: {}

`));
            console.log('[SSE transport.start] ready event sent successfully, client can now proceed');
          } catch (err) {
            console.error('[SSE transport.start] Error sending MCP events:', err);
            throw err;
          }
        },
        send: async (message: string) => {
          console.log('[SSE transport.send] Sending message:', message.substring(0, 100) + (message.length > 100 ? '...' : ''));
          try {
            await writer.write(new TextEncoder().encode(`data: ${message}

`));
            console.log('[SSE transport.send] Message sent successfully');
          } catch (err) {
            console.error('[SSE transport.send] Error sending message:', err);
            throw err;
          }
        },
        close: async () => {
          console.log('[SSE transport.close] Closing SSE connection');
          try {
            await writer.close();
            console.log('[SSE transport.close] Connection closed successfully');
          } catch (err) {
            console.error('[SSE transport.close] Error closing connection:', err);
            throw err;
          }
        }
      };
      
      try {
        // Connect the transport to the MCP server
        console.log('[MCP fetch GET] Connecting transport to MCP server');
        await this.server.connect(transport);
        console.log('[MCP fetch GET] Transport connected successfully');
      } catch (err) {
        console.error('[MCP fetch GET] Error connecting transport:', err);
        return new Response(JSON.stringify({ error: 'Failed to connect SSE transport', details: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Return an SSE response with explicit streaming flags for Cloudflare Workers
      console.log('[MCP fetch GET] Returning SSE response stream');
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no" // Prevent proxy buffering
        }
      });
    } 
    // For POST requests, handle JSON-RPC
    else if (request.method === "POST") {
      console.log('[MCP fetch POST] Handling JSON-RPC request');
      try {
        // Get the JSON-RPC request body
        console.log('[MCP fetch POST] Parsing request body');
        const body = await request.json() as any;
        console.log('[MCP fetch POST] Parsed body:', JSON.stringify(body).substring(0, 200));
        
        // Process the JSON-RPC message
        // Create a one-time transport for handling this request
        let responseData = null;
        console.log('[MCP fetch POST] Creating JSON-RPC transport');
        const transport = {
          type: "json-rpc",
          start: async () => {
            console.log('[JSON-RPC transport.start] Starting JSON-RPC transport');
          },
          send: async (message) => {
            console.log('[JSON-RPC transport.send] Received message to send:', JSON.stringify(message).substring(0, 200));
            // Store the response to return it when done
            responseData = message;
            console.log('[JSON-RPC transport.send] Stored response data');
          },
          close: async () => {
            console.log('[JSON-RPC transport.close] Closing JSON-RPC transport');
          }
        };
        
        // Connect and process the request
        console.log('[MCP fetch POST] Connecting transport to server');
        await this.server.connect(transport);
        console.log('[MCP fetch POST] Transport connected successfully');
        
        // Process the message on the transport
        if (typeof body === 'object') {
          console.log('[MCP fetch POST] Sending request to server for processing');
          // Send the request to the server for processing
          await transport.send(body);
          console.log('[MCP fetch POST] Request processed successfully');
        } else {
          console.warn('[MCP fetch POST] Request body is not an object:', typeof body);
        }
        
        console.log('[MCP fetch POST] Response data:', responseData ? JSON.stringify(responseData).substring(0, 200) : 'null');
        
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
    console.log('[MCP onConnect] Connection request received:', request.url);
    console.log('[MCP onConnect] Headers:', JSON.stringify(Object.fromEntries([...request.headers.entries()])));
    
    // Prefer Authorization header: "Bearer <token>"
    const authHeader = request.headers.get("authorization") || "";
    console.log('[MCP onConnect] Auth header:', authHeader ? 'Present' : 'Missing');
    
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const authToken = tokenMatch?.[1] ?? new URL(request.url).searchParams.get("auth_token") ?? "";
    console.log('[MCP onConnect] Auth token:', authToken ? 'Found' : 'Missing');

    // Custom header for user id, fallback to query param
    const userId = request.headers.get("x-user-id") ?? new URL(request.url).searchParams.get("user_id") ?? "";
    console.log('[MCP onConnect] User ID:', userId || 'Missing');

    if (!authToken || !userId) {
      console.error('[MCP onConnect] Missing auth token or user ID');
      throw new Error("Missing Authorization Bearer token or X-User-Id header");
    }

    // Set props for this session
    this.props = {
      accessToken: authToken,
      user: { id: userId },
    };
    console.log('[MCP onConnect] Session props set, user ID:', userId);

    // Set session ID for tracking
    this.sessionId = `${authToken.substring(0, 8)}-${userId}-${Date.now()}`;
    console.log('[MCP onConnect] Generated session ID:', this.sessionId);

    return;
  }

  /** Called once per authenticated session. */
  async init() {
    console.log('[MCP init] Initializing session:', this.sessionId);
    console.log('[MCP init] User ID:', this.props.user.id);
    
    // 1. Let Xano know we started a session (best-effort).
    try {
      console.log('[MCP init] Registering session with Xano');
      await this.xano.registerSession(this.sessionId, this.props.user.id, {
        name: "remote-mcp-server",
        version: "1.0.0",
      });
      console.log('[MCP init] Session registered successfully with Xano');
    } catch (err) {
      console.warn("[MCP init] Unable to register session with Xano", err);
    }

    // 2. Fetch tool definitions for this user.
    let tools = [] as Awaited<ReturnType<typeof this.xano.getToolDefinitions>>;
    try {
      console.log('[MCP init] Fetching tool definitions from Xano');
      tools = await this.xano.getToolDefinitions(this.props.user.id, this.sessionId);
      console.log(`[MCP init] Fetched ${tools.length} tool definitions:`, 
        tools.map(t => t.name).join(', '));
    } catch (err) {
      console.error("[MCP init] Failed to load tools from Xano", err);
    }

    // 3. Register all available tools for this user.
    console.log('[MCP init] Registering tools from Xano');
    const that = this; // Capture 'this' for use inside handlers

    tools.forEach((tool) => {
      console.log(`[MCP init] Registering tool: ${tool.name}`);
      // Handle tool parameters; the Xano tools might have a different schema structure than expected
      const parameters = (tool as any).parameters || {};
      const schema = z.object(parameters) as any;
      this.server.tool(
        tool.name,
        tool.description ?? "",
        schema,
        // Using a simplified tool handler signature to avoid TypeScript errors
        async function (args: any) {
          console.log(`[Tool ${tool.name}] Executing with args:`, JSON.stringify(args));
          try {
            // 'this' doesn't work in this context, so we use the captured reference to the class instance
            const result = await that.xano.executeFunction(
              tool.name,
              args ?? {},
              that.sessionId,
              that.props.user.id,
            );
            console.log(`[Tool ${tool.name}] Execution successful, result:`, 
              JSON.stringify(result).substring(0, 200) + (JSON.stringify(result).length > 200 ? '...' : ''));
            // Make sure the content property is mutable for MCP SDK
            return { content: [{ type: "json", json: result }] as any } as const;
          } catch (err) {
            console.error(`[Tool ${tool.name}] Execution failed:`, err);
            throw err;
          }
        },
      );
      console.log(`[MCP init] Tool registered: ${tool.name}`);
    });

    // 4. Bonus sample "add" tool (always available).
    console.log('[MCP init] Registering built-in add tool');
    this.server.tool(
      "add",
      "Add two numbers on the edge",
      { a: z.number(), b: z.number() } as any,
      // Using a simplified tool handler signature to avoid TypeScript errors
      async (args: { a: number, b: number }) => {
        const { a, b } = args;
        console.log(`[Tool add] Adding ${a} + ${b}`);
        const result = String(a + b);
        console.log(`[Tool add] Result: ${result}`);
        // Make sure the content property is mutable for MCP SDK
        return { content: [{ type: "text", text: result }] as any };
      },
    );
    console.log('[MCP init] Init complete');
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
      console.log('[Worker fetch] MCP request received:', request.method, url.href);
      console.log('[Worker fetch] Headers:', JSON.stringify(Object.fromEntries([...request.headers.entries()])));
      
      // Extract bearer (might be share token or raw xano token)
      const authHeader = request.headers.get("authorization") || "";
      const bearer = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1] || url.searchParams.get("auth_token") || "";
      console.log('[Worker fetch] Bearer token:', bearer ? 'Present' : 'Missing');

      // Check if bearer is a share token
      console.log('[Worker fetch] Checking if bearer is a share token');
      const share = await getShare(bearer, env);
      if (share) {
        console.log('[Worker fetch] Share token found, userId:', share.userId);
        // Rewrite headers so DO sees real Xano token & user id
        const newHeaders = new Headers(request.headers);
        newHeaders.set("authorization", `Bearer ${share.xanoToken}`);
        newHeaders.set("x-user-id", share.userId);
        const newReq = new Request(request as any, { headers: newHeaders } as RequestInit);
        
        console.log('[Worker fetch] Creating Durable Object ID for shared token user');
        const id = env.MCP_OBJECT.idFromName(`${share.xanoToken}:${share.userId}`);
        console.log('[Worker fetch] Forwarding to Durable Object with real credentials');
        return env.MCP_OBJECT.get(id).fetch(newReq);
      }

      // Fallback: treat bearer as xano token directly (legacy)
      const userId = request.headers.get("x-user-id") || url.searchParams.get("user_id") || "";
      console.log('[Worker fetch] Direct bearer token, userId:', userId || 'Missing');
      
      if (!bearer || !userId) {
        console.warn('[Worker fetch] Missing bearer token or userId');
        return new Response(JSON.stringify({
          error: 'Missing required authentication',
          details: !bearer ? 'No bearer token provided' : 'No user ID provided'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.log('[Worker fetch] Creating Durable Object ID');
      const id = env.MCP_OBJECT.idFromName(`${bearer}:${userId}`);
      console.log('[Worker fetch] Forwarding to Durable Object');
      return env.MCP_OBJECT.get(id).fetch(request);
    }

    // Everything else goes to the app (home page, health check)
    return app.fetch(request, env, ctx);
  },
};