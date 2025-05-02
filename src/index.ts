import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XanoClient } from "./xano-client";
import type { Env } from "./types";
import { z } from "zod";

// Base URL for Xano API
const XANO_BASE_URL = "https://xnwv-v1z6-dvnr.n7c.xano.io";

// Define the state type for our MCP server
type MyMcpState = {
  tools: any[];
  sessionInfo: Record<string, any>;
  authenticated: boolean;
  lastActivityTime: number;
};

// Utility to safely format Xano tools to MCP format
function formatXanoToolsForMCP(xanoTools: any[]): any[] {
  try {
    console.log('Raw tools data from Xano:', JSON.stringify(xanoTools, null, 2));
    
    return (xanoTools || []).map(tool => {
      // Defensive programming - check if each field exists
      if (!tool || !tool.name) {
        console.warn("Tool missing name property:", JSON.stringify(tool));
        return null; // Skip invalid tools
      }
      
      console.log(`Processing tool: ${tool.name}`);
      
      // Create a properly formatted MCP tool with schema
      const mcp_tool = {
        name: tool.name,
        description: tool.description || '',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      };
      
      // CASE 1: Use parameter_schema directly if it exists and is properly formatted
      if (tool.parameter_schema && typeof tool.parameter_schema === 'object') {
        console.log(`Tool ${tool.name} has parameter_schema object`);
        mcp_tool.parameters.properties = tool.parameter_schema.properties || {};
        mcp_tool.parameters.required = tool.parameter_schema.required || [];
        return mcp_tool;
      }
      
      // CASE 2: Parse parameter_schema if it's a string
      try {
        if (tool.parameter_schema && typeof tool.parameter_schema === 'string') {
          console.log(`Tool ${tool.name} has parameter_schema string`);
          const parsed = JSON.parse(tool.parameter_schema);
          mcp_tool.parameters.properties = parsed.properties || {};
          mcp_tool.parameters.required = parsed.required || [];
          return mcp_tool;
        }
      } catch (parseError) {
        console.warn(`Error parsing parameter_schema for ${tool.name}:`, parseError);
      }
      
      // CASE 3: Fall back to parameters array if parameter_schema is not available
      if (Array.isArray(tool.parameters)) {
        console.log(`Tool ${tool.name} using parameters array`);
        mcp_tool.parameters.properties = tool.parameters.reduce((acc: any, param: any) => {
          if (param && param.name) {
            acc[param.name] = {
              type: param.type || 'string',
              description: param.description || ''
            };
            
            // Add additional schema properties if they exist
            if (param.enum) acc[param.name].enum = param.enum;
            if (param.minimum !== undefined) acc[param.name].minimum = param.minimum;
            if (param.maximum !== undefined) acc[param.name].maximum = param.maximum;
            if (param.default !== undefined) acc[param.name].default = param.default;
          }
          return acc;
        }, {});
        
        // Extract required fields
        mcp_tool.parameters.required = tool.parameters
          .filter((param: any) => param && param.required)
          .map((param: any) => param.name);
      }
      
      return mcp_tool;
    }).filter(Boolean); // Remove any null entries from invalid tools
  } catch (error) {
    console.error("Error formatting tools for MCP:", error);
    // Fallback to a simpler format with better error handling
    return (xanoTools || []).map(tool => {
      if (!tool) return null;
      return {
        name: tool.name || "unknown",
        description: tool.description || "",
        parameters: { type: "object", properties: {}, required: [] }
      };
    }).filter(Boolean);
  }
}

// Simple MCP implementation focused on Streamable HTTP transport
export class MyMCP extends McpAgent<MyMcpState> {
  server: McpServer;
  xanoClient: XanoClient;
  sessionId: string = 'default';
  toolsRegistered: boolean = false;

  // Initialize state
  initialState: MyMcpState = {
    tools: [],
    sessionInfo: {},
    authenticated: false,
    lastActivityTime: Date.now()
  };

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.xanoClient = new XanoClient(env.XANO_BASE_URL || XANO_BASE_URL);
    this.server = new McpServer({
      name: "Xano MCP",
      version: "1.0.0"
    }, {
      capabilities: {
        toolExecution: true
      }
    });
  }
  
  // Called when state is updated
  onStateUpdate(state: MyMcpState) {
    console.log(`State updated: authenticated=${state.authenticated}, tool count=${state.tools.length}`);
    
    // You can perform side effects when state changes
    if (state.lastActivityTime + 30 * 60 * 1000 < Date.now()) {
      console.log('Session inactive for 30 minutes, will be reset on next activity');
    }
  }

  async init() {
    console.log("Initializing MyMCP server with Streamable HTTP transport...");
    try {
      await this.registerTools();
    } catch (error) {
      console.error("Failed to initialize MCP server:", error);
    }
  }
  
  // Register tools from Xano with the MCP server
  async registerTools() {
    try {
      // Get user context from props if available
      const userId = this.props?.user ? (this.props.user as {id?: string}).id : undefined;
      const sessionId = this.sessionId;
      
      const toolDefinitions = await this.xanoClient.getTools(userId, sessionId);
      console.log(`Loaded ${toolDefinitions.length} tools from Xano`);
      
      // Register each tool with the McpServer
      for (const tool of toolDefinitions) {
        // Convert tool parameters to Zod schema
        const paramSchemas: Record<string, any> = {};
        
        if (tool.parameters) {
          for (const param of tool.parameters) {
            // Map Xano parameter types to Zod schema types
            switch(param.type) {
              case 'string':
                paramSchemas[param.name] = param.required ? z.string() : z.string().optional();
                break;
              case 'number':
              case 'integer':
                paramSchemas[param.name] = param.required ? z.number() : z.number().optional();
                break;
              case 'boolean':
                paramSchemas[param.name] = param.required ? z.boolean() : z.boolean().optional();
                break;
              case 'object':
                paramSchemas[param.name] = param.required ? z.record(z.any()) : z.record(z.any()).optional();
                break;
              case 'array':
                paramSchemas[param.name] = param.required ? z.array(z.any()) : z.array(z.any()).optional();
                break;
              default:
                paramSchemas[param.name] = param.required ? z.any() : z.any().optional();
            }
          }
        }
        
        // Register the tool using the SDK's tool method
        console.log(`Registering tool: ${tool.name}`);
        this.server.tool(
          tool.name,
          tool.description || '',
          paramSchemas,
          async (args) => {
            return await this.executeTool(tool.name, args);
          }
        );
      }
      
      this.toolsRegistered = true;
      console.log(`Successfully registered ${toolDefinitions.length} tools with MCP server`);
      return toolDefinitions.length;
    } catch (error) {
      console.error("Failed to register tools:", error);
      throw error;
    }
  }
  
  async executeTool(toolName: string, args: any): Promise<any> {
    console.log(`Executing tool ${toolName} with args:`, args);
    
    try {
      // Authenticate if needed
      if (this.props?.accessToken) {
        this.xanoClient.setUserToken(this.props.accessToken);
      }
      
      // Get user context from props if available
      const userId = this.props?.user ? (this.props.user as {id?: string}).id : undefined;
      const sessionId = this.sessionId;
      
      // Find the tool and execute it
      const tools = await this.xanoClient.getTools(userId, sessionId);
      const tool = tools.find(t => t.name === toolName);
      
      if (!tool) {
        throw new Error(`Tool not found: ${toolName}`);
      }
      
      if (tool.execution?.endpoint) {
        return await this.xanoClient.executeFunction(tool.execution.endpoint, args, sessionId, userId);
      } else {
        throw new Error(`Tool has no endpoint defined: ${toolName}`);
      }
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      throw error;
    }
  }
  
    // Handler for SSE connections
  async onSSE(path: string): Promise<Response> {
    console.log(`Setting up SSE connection on path: ${path}`);
    
    // Create a text encoder to convert strings to binary data
    const encoder = new TextEncoder();
    
    // Fetch tools from Xano before creating the stream
    const userId = this.props?.user ? (this.props.user as {id?: string}).id : undefined;
    let tools = [];
    try {
      tools = await this.xanoClient.getTools(userId, this.sessionId);
      console.log(`Fetched ${tools.length} tools from Xano for SSE response`);
    } catch (error) {
      console.error("Failed to get tools for SSE response:", error);
    }
    
    // Create a new ReadableStream for our SSE response
    const stream = new ReadableStream({
      start(controller) {
        // Send initial events that the Workers AI Playground expects
        // Send server info
        controller.enqueue(encoder.encode('event: server_info\ndata: {"name":"Xano MCP","version":"1.0.0"}\n\n'));
        
        // Format tools to match MCP specification with resilience to API changes
        const formattedTools = formatXanoToolsForMCP(tools);
        
        // Send the tools list with properly formatted tools
        const toolsListJson = JSON.stringify({
          jsonrpc: "2.0",
          result: {
            tools: formattedTools
          },
          id: 1
        });
        console.log(`Sending ${formattedTools.length} formatted tools to client`);
        controller.enqueue(encoder.encode(`event: tools_list\ndata: ${toolsListJson}\n\n`));
        
        // Send a ready event
        controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));
        
        // Keep the connection open
        const interval = setInterval(() => {
          // Send ping to keep connection alive
          controller.enqueue(encoder.encode('event: ping\ndata: {}\n\n'));
        }, 30000);
        
        // Clean up on close
        const cleanup = () => {
          clearInterval(interval);
        };
        return cleanup;
      }
    });
    
    // Return the SSE response with proper headers
    return new Response(stream, {
      status: 200, 
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'MCP-Available-Transports': 'streamable-http',
        'MCP-Transport': 'streamable-http'
      }
    });
  }
  
  // Handle auth and route the request to the appropriate transport
  async processRequest(request: Request): Promise<Response> {
    try {
      // Extract auth params and session ID if present
      const url = new URL(request.url);
      const authToken = url.searchParams.get('auth_token');
      const userId = url.searchParams.get('user_id');
      
      // Extract sessionId from URL parameters (new Streamable HTTP format)
      // or generate a new one if not provided
      const urlSessionId = url.searchParams.get('sessionId');
      if (urlSessionId) {
        console.log(`Using provided session ID from URL: ${urlSessionId}`);
        this.sessionId = urlSessionId;
      } else if (!this.sessionId) {
        // Generate a new session ID if we don't have one yet
        this.sessionId = crypto.randomUUID();
        console.log(`Generated new session ID: ${this.sessionId}`);
      }
      
      // Check for authentication in multiple places:
      // 1. URL parameters (backward compatibility)
      // 2. Authorization header (Bearer token)
      // 3. Request payload (from initialize request)
      
      // First check URL parameters (already extracted above)
      let finalAuthToken = authToken;
      let finalUserId = userId;
      
      // Next check Authorization header
      if (!finalAuthToken) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
          finalAuthToken = authHeader.substring(7);
          console.log("Bearer token auth detected from header");
          
          // With Bearer auth, we may need to extract/fetch the user ID
          // For simplicity, we'll use the token itself as the user ID if not otherwise provided
          finalUserId = finalUserId || 'bearer-user';
        }
      }
      
      // Setup authentication if provided through any mechanism
      if (finalAuthToken && finalUserId) {
        console.log(`Authentication detected for user: ${finalUserId}`);
        
        // Update authentication state
        this.setState({
          tools: this.state?.tools || [],
          sessionInfo: {
            userId: finalUserId,
            lastAuthenticated: Date.now()
          },
          authenticated: true,
          lastActivityTime: Date.now()
        });
        
        // Set up auth props for backward compatibility
        this.props = {
          accessToken: finalAuthToken,
          user: { id: finalUserId }
        };
        this.xanoClient.setUserToken(finalAuthToken);

        try {
          console.log(`Making POST request to ${XANO_BASE_URL}/api:KOMHCtw6/mcp_connect`);
          await this.xanoClient.registerSession(
            this.sessionId, 
            userId, 
            { name: "mcp-client", version: "1.0.0" }
          );
          console.log("Successfully registered session with Xano");
          
          // Try to register tools after successful auth and session registration
          // But don't fail the request if tool registration fails
          try {
            if (!this.toolsRegistered) {
              await this.registerTools();
            }
          } catch (toolError) {
            console.warn("Tool registration failed, but continuing with request processing:", toolError);
            // Don't throw - continue processing the request even if tools can't be loaded
          }
        } catch (error) {
          console.error("Failed to register session with Xano:", error);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Authentication error: ${error.message}`
            },
            id: null
          }), { 
            status: 401, 
            headers: { 
              'Content-Type': 'application/json', 
              'MCP-Available-Transports': 'streamable-http'
            }
          });
        }
      } else {
        console.log("No authentication token provided");
      }
      
      // Check if the client is requesting SSE transport
      const acceptHeader = request.headers.get('accept') || '';
      const isSSE = acceptHeader.includes('text/event-stream');
      console.log(`Client requested ${isSSE ? 'SSE' : 'Streamable HTTP'} transport based on Accept header`);
      
      if (isSSE) {
        // For SSE connections, call the parent class's onSSE method
        const path = url.pathname;
        console.log(`Handling SSE connection on path: ${path}`);
        try {
          return await this.onSSE(path);
        } catch (error) {
          console.error(`Error in onSSE: ${error.message}`);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32003,
              message: `SSE Error: ${error.message}`
            },
            id: null
          }), { 
            status: 500, 
            headers: { 
              'Content-Type': 'application/json',
              'MCP-Available-Transports': 'streamable-http'
            }
          });
        }
      } else {
        // For standard HTTP requests, use proper JSON-RPC processing
        console.log("Processing standard HTTP request");
        
        try {
          // Parse the JSON-RPC request
          let jsonRpcRequest;
          try {
            const bodyText = await request.text();
            jsonRpcRequest = bodyText ? JSON.parse(bodyText) : { jsonrpc: "2.0", method: "getTools", id: 1 };
            console.log("Received JSON-RPC request:", JSON.stringify(jsonRpcRequest));
          } catch (parseError) {
            console.log("Request body is empty or invalid JSON, using default request");
            jsonRpcRequest = { jsonrpc: "2.0", method: "getTools", id: 1 };
          }
          
          // Process different methods
          if (jsonRpcRequest.method === "initialize") {
            // Extract client info from request if available
            const clientInfo = jsonRpcRequest.params?.clientInfo || { name: "unknown", version: "0.0.0" };
            const protocolVersion = jsonRpcRequest.params?.protocolVersion || "2023-03-01";
            
            console.log(`Client initialize request: ${clientInfo.name} v${clientInfo.version}, protocol ${protocolVersion}`);
            
            // Prepare initialization response with session ID and protocol version
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              result: {
                server: {
                  name: "Xano MCP",
                  version: "1.0.0",
                  protocolVersion: "2024-11-05"
                },
                capabilities: {
                  toolExecution: true,
                  sampling: {}
                },
                session: {
                  id: this.sessionId,
                  authenticated: !!this.props?.accessToken
                }
              },
              id: jsonRpcRequest.id || 1
            }), { 
              status: 200, 
              headers: { 
                'Content-Type': 'application/json',
                'MCP-Available-Transports': 'streamable-http'
              }
            });
          } 
          else if (jsonRpcRequest.method === "getTools") {
            // Get tools and return them
            try {
              // Try to make sure tools are registered, but don't fail if we can't
              if (!this.toolsRegistered) {
                await this.registerTools();
              }
            } catch (toolError) {
              console.warn("Failed to load tools from Xano, using empty tools list", toolError);
              // Continue with empty tools list if we can't load from Xano
            }
            
            // Use MCPServer's built-in handler to get the tools, or empty array if none registered
            // Get tools from the server and format them according to MCP spec
            let toolsList = [];
            try {
              // Use registered tools from the MCP server
              const serverTools = Object.values(this.server._registeredTools || {})
                .filter(tool => tool.enabled)
                .map(tool => ({
                  name: tool.name || "",
                  description: tool.description || "",
                  parameters: tool._inputSchema || {}
                }));
                
              // Format tools using our unified formatter
              toolsList = formatXanoToolsForMCP(serverTools);
              console.log(`Sending ${toolsList.length} formatted tools in JSON-RPC response`);
            } catch (error) {
              console.warn("Error accessing or formatting registered tools, using empty list", error);
            }
            
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              result: { tools: toolsList },
              id: jsonRpcRequest.id || 1
            }), { 
              status: 200, 
              headers: { 'Content-Type': 'application/json' }
            });
          } 
          else if (jsonRpcRequest.method === "executeTool") {
            const toolName = jsonRpcRequest.params?.name;
            const args = jsonRpcRequest.params?.arguments || {};
            
            if (!toolName) {
              return new Response(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32602,
                  message: "Missing tool name"
                },
                id: jsonRpcRequest.id || 1
              }), { 
                status: 400, 
                headers: { 'Content-Type': 'application/json' }
              });
            }
            
            try {
              // Execute the tool
              const result = await this.executeTool(toolName, args);
              
              return new Response(JSON.stringify({
                jsonrpc: "2.0",
                result,
                id: jsonRpcRequest.id || 1
              }), { 
                status: 200, 
                headers: { 'Content-Type': 'application/json' }
              });
            } catch (toolError) {
              return new Response(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message: `Tool execution failed: ${toolError.message}`
                },
                id: jsonRpcRequest.id || 1
              }), { 
                status: 500, 
                headers: { 'Content-Type': 'application/json' }
              });
            }
          } else {
            // Unknown method
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32601,
                message: `Method not found: ${jsonRpcRequest.method}`
              },
              id: jsonRpcRequest.id || 1
            }), { 
              status: 400, 
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } catch (error) {
          console.error(`Error handling HTTP request: ${error.message}`);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: `Internal server error: ${error.message}`
            },
            id: null
          }), { 
            status: 500, 
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    } catch (error) {
      console.error("Error processing request:", error);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `Server error: ${error.message}`
        },
        id: null
      }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Main entry point for all requests
  async fetch(request: Request): Promise<Response> {
    // Enhanced CORS handling
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With",
      "Access-Control-Max-Age": "86400",
    };
    
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }
    
    try {
      // Process the request with authentication handling first
      const response = await this.processRequest(request.clone());
      
      // Add CORS headers to the response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });
      
      // Return response with CORS headers
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `Server error: ${error.message}`
        },
        id: null
      }), { 
        status: 500, 
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
}

// Simple request forwarder
function createHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: any) {
      // Forward to the Durable Object
      const id = env.MCP_OBJECT.idFromName("main");
      const mcpObject = env.MCP_OBJECT.get(id);
      
      try {
        return await mcpObject.fetch(request.clone());
      } catch (error) {
        console.error(`Error in MCP handler:`, error);
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }
  };
}

// Main worker handler
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle Streamable HTTP transport via /mcp endpoints
    if (url.pathname.startsWith("/mcp")) {
      console.log(`Main handler: forwarding to MCP endpoint: ${url.pathname}`);
      return createHandler().fetch(request, env, ctx);
    }
    
    // Support legacy /sse endpoint for older clients
    if (url.pathname === "/sse") {
      console.log(`Main handler: forwarding to SSE endpoint`);
      return createHandler().fetch(request, env, ctx);
    }
    
    // Fallback to app handler
    return (app as any).fetch(request, env, ctx);
  }
};

export default mcpHandler;