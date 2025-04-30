import app from "./app";
// Use relative paths for the MCP SDK to avoid module resolution issues
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Readable } from "stream";
import { XanoClient } from "./xano-client";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { XanoProps } from "./props";
import type { Env } from "./types";

// State interface (persisted in Durable Object)
interface MyMCPState {
  counter?: number;
  toolDefinitions?: any[];
}

export class MyMCP extends McpAgent<Env, MyMCPState, XanoProps> {
  server = new McpServer({
    name: "Xano MCP",
    version: "1.0.0",
  });
  
  xanoClient: XanoClient;
  sessionId: string = 'default';

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.xanoClient = new XanoClient(env.XANO_BASE_URL);
    
    // Initialize state if not already set
    if (!this.state) {
      this.setState({
        counter: 0,
        toolDefinitions: []
      });
    }
    
    // Set up debugging if the underlying MCP server supports an `on` method
    const srv: any = this.server as any;
    if (typeof srv.on === "function") {
      srv.on("error", (error: any) => {
        console.error("MCP Server Error:", error);
      });
    }
  }

  async init() {
    console.log("Initializing MCP Server...");
    
    // If token was provided in props or query params, fetch tools
    if (this.props?.accessToken) {
      console.log("User authenticated via token");
      this.xanoClient.setUserToken(this.props.accessToken);
      await this.fetchToolDefinitions();
    }
    
    // Register the dynamic tool handler
    // Use type assertion to bypass TypeScript error
    (this.server as any).setToolHandler(async (name, args, context) => {
      console.log(`Tool execution request: ${name}`, JSON.stringify(args));
      
      // Check authentication
      if (!this.props?.accessToken) {
        console.error("Authentication required");
        throw new Error("Authentication required to execute tools");
      }
      
      // If we don't have tool definitions yet, fetch them
      if ((!this.state.toolDefinitions || this.state.toolDefinitions.length === 0)) {
        await this.fetchToolDefinitions();
      }
      
      // Find the tool definition
      const toolDef = this.state.toolDefinitions?.find(t => t.name === name);
      if (!toolDef) {
        console.error(`Tool not found: ${name}`);
        throw new Error(`Tool not found: ${name}`);
      }
      
      try {
        // Execute the tool based on its definition
        const result = await this.dynamicExecuteTool(toolDef, args);
        console.log(`Tool execution result for ${name}:`, JSON.stringify(result).substring(0, 200) + "...");
        return result;
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    });
  }
  
  // Handle incoming connections
  async connect(request: Request): Promise<Response> {
    console.log("Connecting to MCP Server...");
    
    // Check for direct token authentication
    const url = new URL(request.url);
    const authToken = url.searchParams.get('auth_token');
    const userId = url.searchParams.get('user_id');
    
    if (authToken && userId) {
      console.log("Direct token auth detected");
      
      // Save authentication info to props
      this.props = {
        ...this.props,
        accessToken: authToken,
        user: { id: userId }
      };
      
      // Update Xano client
      this.xanoClient.setUserToken(authToken);
      
      try {
        await this.xanoClient.registerSession(
          this.sessionId, 
          userId, 
          { name: "mcp-client", version: "1.0.0" }
        );
        console.log("Successfully registered session with Xano");
      } catch (error) {
        console.error("Failed to register session with Xano:", error);
      }
    }
    
    try {
      // Handle OPTIONS requests for CORS
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      
      // Create a Promise to capture the response data
      let responseResolve: (value: Response) => void;
      let responseReject: (reason?: any) => void;
      const responsePromise = new Promise<Response>((resolve, reject) => {
        responseResolve = resolve;
        responseReject = reject;
      });
      
      // Parse request body
      const body = request.method === 'POST' ? await request.clone().json().catch(() => null) : null;
      
      // Create Express-like request object that the transport expects
      const expressReq = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: body
      };
      
      // Create Express-like response object
      const expressRes = {
        // Response state
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: '',
        headersSent: false,
        finished: false,
        
        // Methods expected by the MCP transport
        writeHead: (status: number, headers?: Record<string, string>) => {
          expressRes.statusCode = status;
          if (headers) {
            expressRes.headers = { ...expressRes.headers, ...headers };
          }
          expressRes.headersSent = true;
          return expressRes;
        },
        
        setHeader: (name: string, value: string) => {
          expressRes.headers[name] = value;
          return expressRes;
        },
        
        getHeader: (name: string) => {
          return expressRes.headers[name];
        },
        
        removeHeader: (name: string) => {
          delete expressRes.headers[name];
          return expressRes;
        },
        
        set: (field: string | Record<string, string>, value?: string) => {
          if (typeof field === 'string' && value !== undefined) {
            expressRes.headers[field] = value;
          } else if (typeof field === 'object') {
            expressRes.headers = { ...expressRes.headers, ...field };
          }
          return expressRes;
        },
        
        status: (code: number) => {
          expressRes.statusCode = code;
          return {
            send: (body: any) => {
              expressRes.body = typeof body === 'string' ? body : JSON.stringify(body);
              expressRes.finished = true;
              
              // Resolve the response promise
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(expressRes.headers)) {
                responseHeaders.set(key, value);
              }
              responseResolve(new Response(expressRes.body, {
                status: expressRes.statusCode,
                headers: responseHeaders
              }));
              
              return expressRes;
            },
            json: (body: any) => {
              expressRes.headers['Content-Type'] = 'application/json';
              expressRes.body = JSON.stringify(body);
              expressRes.finished = true;
              
              // Resolve the response promise
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(expressRes.headers)) {
                responseHeaders.set(key, value);
              }
              responseResolve(new Response(expressRes.body, {
                status: expressRes.statusCode,
                headers: responseHeaders
              }));
              
              return expressRes;
            }
          };
        },
        
        json: (body: any) => {
          expressRes.headers['Content-Type'] = 'application/json';
          expressRes.body = JSON.stringify(body);
          expressRes.finished = true;
          
          // Resolve the response promise
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(expressRes.headers)) {
            responseHeaders.set(key, value);
          }
          responseResolve(new Response(expressRes.body, {
            status: expressRes.statusCode,
            headers: responseHeaders
          }));
          
          return expressRes;
        },
        
        send: (body: any) => {
          expressRes.body = typeof body === 'string' ? body : JSON.stringify(body);
          expressRes.finished = true;
          
          // Resolve the response promise
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(expressRes.headers)) {
            responseHeaders.set(key, value);
          }
          responseResolve(new Response(expressRes.body, {
            status: expressRes.statusCode,
            headers: responseHeaders
          }));
          
          return expressRes;
        },
        
        end: (chunk?: any) => {
          if (chunk) {
            expressRes.body = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
          }
          expressRes.finished = true;
          
          // Resolve the response promise
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(expressRes.headers)) {
            responseHeaders.set(key, value);
          }
          responseResolve(new Response(expressRes.body, {
            status: expressRes.statusCode,
            headers: responseHeaders
          }));
          
          return expressRes;
        },
        
        // Event handling for compatibility with SSE
        on: (event: string, handler: (...args: any[]) => void) => {
          // We'll add minimal event handling for close events
          if (event === 'close') {
            // Nothing to do in this adapter
          }
          return expressRes;
        },
        
        // Add methods for SSE
        flushHeaders: () => {
          expressRes.headersSent = true;
          return expressRes;
        },
        
        write: (chunk: string) => {
          expressRes.body += chunk;
          return true;
        }
      };
      
      // Create a transport for this request
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => this.sessionId,
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized: ${sessionId}`);
        }
      });
      
      // Connect our MCP server to this transport
      await this.server.connect(transport);
      
      // Process the request through the transport
      // This will call the appropriate handlers based on the request
      // Use type assertions to bypass type checking since we're providing a compatible interface
      await (transport as any).handleRequest(expressReq as any, expressRes as any, body);
      
      // Return the response captured by our promise
      return responsePromise;
    } catch (error) {
      console.error('Error processing MCP request:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Cloudflare Durable Object entrypoint
  // Explicitly expose fetch so that the runtime finds it. We forward to our
  // existing `connect()` method, which handles the logic.
  // This prevents the runtime error: "Handler does not export a fetch() function."
  fetch(request: Request) {
    return this.connect(request);
  }

  // Fetch tool definitions from Xano
  async fetchToolDefinitions() {
    try {
      console.log("Fetching tool definitions from Xano...");
      const tools = await this.xanoClient.getToolDefinitions();
      
      if (Array.isArray(tools)) {
        this.setState({
          ...this.state,
          toolDefinitions: tools
        });
        console.log(`Loaded ${tools.length} tool definitions`);
      } else {
        console.error("Invalid tool definitions format", tools);
      }
    } catch (error) {
      console.error("Error fetching tool definitions:", error);
    }
  }
  
  // Execute a tool dynamically based on its definition
  async dynamicExecuteTool(toolDef: any, args: any) {
    try {
      console.log(`Executing tool ${toolDef.name} with args:`, args);
      
      // Map parameters according to the tool definition
      const mappedParams: Record<string, any> = {};
      if (toolDef.parameters && args) {
        Object.keys(args).forEach(key => {
          const param = toolDef.parameters[key];
          if (param) {
            mappedParams[param] = args[key];
          } else {
            mappedParams[key] = args[key];
          }
        });
      }
      
      // Execute the function via Xano client
      return await this.xanoClient.executeFunction(toolDef.endpoint, mappedParams);
    } catch (error) {
      console.error(`Error executing tool ${toolDef.name}:`, error);
      throw error;
    }
  }

  // Static mount method for use with OAuthProvider
  static mount(path: string) {
    return {
      async fetch(request: Request, env: Env, ctx: any) {
        console.log("Mount method handling request:", request.url);
        
        // Check for direct token authentication
        const url = new URL(request.url);
        const authToken = url.searchParams.get('auth_token');
        const userId = url.searchParams.get('user_id');
        
        if (authToken && userId) {
          console.log("Mount method detected direct token auth, bypassing OAuth flow");
          // Direct token auth - bypass OAuth flow
          const id = env.MCP_OBJECT.idFromName("main");
          const mcpObject = env.MCP_OBJECT.get(id);
          return mcpObject.fetch(request);
        } else {
          console.log("No direct token auth, proceeding with normal flow");
          // No direct token auth - proceed with normal flow
          const id = env.MCP_OBJECT.idFromName("main");
          const mcpObject = env.MCP_OBJECT.get(id);
          return mcpObject.fetch(request);
        }
      }
    };
  }
}

// Create a default handler that routes /sse to the Durable Object and anything
// else to the existing `app` handler (if present)
const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: any) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/sse")) {
      // Forward to the Durable Object (bypasses OAuth checks)
      return MyMCP.mount("/sse").fetch(request, env, ctx);
    }
    // Fallback to whatever the original app handler does
    return (app as any).fetch(request, env, ctx);
  }
};

// Dummy API handler – never used because `apiRoute` is empty. We need this
// solely to satisfy the type requirements of `OAuthProviderOptions`.
const dummyApiHandler = {
  fetch(_request: Request) {
    return new Response("No API routes configured", { status: 501 });
  }
};

// Export the OAuth provider. We do NOT configure `apiRoute` so the provider
// will *not* attempt to treat /sse as a protected API route. Instead, every
// request except the provider's own OAuth endpoints (/authorize, /token, /register)
// will be passed straight through to our `defaultHandler`.
export default new OAuthProvider({
  apiRoute: [], // empty – we don't want the provider to intercept any API paths
  apiHandler: dummyApiHandler as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});