import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { XanoClient } from "./xano-client";
import type { DurableObjectState, ExecutionContext } from '@cloudflare/workers-types';

// Define the MCP state interface
interface MyMCPState {
  counter?: number;
  userToken?: string;
  userId?: string;
  toolDefinitions?: any[];
}

export class MyMCP extends McpAgent<unknown, MyMCPState> {
  server = new McpServer({
    name: "Snappy MCP",
    version: "1.0.0",
  });

  xanoClient: XanoClient;

  // Add env property to the class to fix TypeScript errors
  env: any;
  sessionId: string = crypto.randomUUID();
  
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.env = env;
    this.xanoClient = new XanoClient(env.XANO_BASE_URL);
    
    // Initialize state if not already set
    if (!this.getState()) {
      this.setState({
        counter: 0,
        userToken: undefined,
        userId: undefined,
        toolDefinitions: []
      });
    }
    
    // Set up debugging for easier troubleshooting
    if (typeof this.server.on === 'function') {
      this.server.on("error", (error: Error) => {
        console.error("MCP Server Error:", error);
      });
    } else {
      console.warn("Warning: server.on method not available");
    }
  }
  
  // Helper methods to manage state properly
  private getState(): MyMCPState {
    return super.state as MyMCPState;
  }
  
  private setState(newState: MyMCPState): void {
    super.state = newState;
  }

  async init() {
    console.log("Initializing MCP Server...");
    
    // Register counter resource for backward compatibility
    this.server.resource(
      "counter",
      "mcp://resource/counter",
      (uri) => ({
        contents: [{ uri: uri.href, text: String(this.getState().counter ?? 0) }],
      })
    );

    // If we have a user token, fetch tool definitions from Xano
    if (this.getState().userToken) {
      await this.fetchToolDefinitions();
    }
    
    // Register tools for each known tool definition
    const state = this.getState();
    if (state.toolDefinitions && state.toolDefinitions.length > 0) {
      state.toolDefinitions.forEach(tool => {
        try {
          this.server.tool(
            tool.name,
            tool.parameter_schema || {},
            async (args: any) => {
              try {
                const result = await this.dynamicExecuteTool(tool, args);
                return result;
              } catch (error) {
                console.error(`Error executing tool ${tool.name}:`, error);
                throw error;
              }
            }
          );
          console.log(`Registered tool: ${tool.name}`);
        } catch (error) {
          console.error(`Error registering tool ${tool.name}:`, error);
        }
      });
    }
    
    // Set up a handler for dynamic tool execution
    this.server.onToolCall(async (name: string, args: any) => {
      console.log(`Tool execution request: ${name}`, JSON.stringify(args));
      
      // If we don't have tool definitions yet but have a token, try to fetch
      const state = this.getState();
      if ((!state.toolDefinitions || state.toolDefinitions.length === 0) && state.userToken) {
        await this.fetchToolDefinitions();
      }
      
      // Find the tool definition
      const toolDef = this.getState().toolDefinitions?.find((t: any) => t.name === name);
      if (!toolDef) {
        console.error(`Tool not found: ${name}`);
        throw new Error(`Tool not found: ${name}`);
      }
      
      try {
        // Execute the tool based on its definition
        const result = await this.dynamicExecuteTool(toolDef, args);
        console.log(`Tool execution result for ${name}:`, JSON.stringify(result).substring(0, 200) + "...");
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    });
  }
  
  // Override the connect method to handle auth tokens
  async connect(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authToken = url.searchParams.get('auth_token');
    const userId = url.searchParams.get('user_id');
    
    console.log("New connection with auth:", authToken ? "Token provided" : "No token", "User ID:", userId || "None");
    
    if (authToken && userId) {
      const currentState = this.getState();
      this.setState({ 
        ...currentState, 
        userToken: authToken,
        userId: userId
      });
      
      // Update the Xano client with the user token
      this.xanoClient.setUserToken(authToken);
      
      // Register the session with Xano
      try {
        await this.xanoClient.registerSession(
          this.sessionId, 
          userId, 
          { name: "mcp-client", version: "1.0.0" }
        );
        console.log("Successfully registered session with Xano");
        
        // Since we now have a token, fetch tool definitions
        await this.fetchToolDefinitions();
      } catch (error) {
        console.error("Failed to register session with Xano:", error);
        // Continue anyway as this is non-critical
      }
    }
    
    // Continue with normal connection flow
    return super.connect(request);
  }
  
  // Fetch tool definitions from Xano
  async fetchToolDefinitions() {
    console.log("Fetching tool definitions from Xano...");
    const state = this.getState();
    if (!state.userToken) {
      console.log("No user token available, cannot fetch tool definitions");
      return [];
    }
    
    try {
      // Update client with latest token
      this.xanoClient.setUserToken(state.userToken);
      
      // Fetch tools
      const tools = await this.xanoClient.getTools();
      
      console.log(`Fetched ${tools.length} tool definitions from Xano`);
      
      this.setState({ ...this.getState(), toolDefinitions: tools });
      
      // Register each tool with the server (for schema purposes only)
      tools.forEach(tool => {
        try {
          // Create a zod schema from the JSON schema if possible
          this.server.tool(
            tool.name,
            tool.parameter_schema || {},
            async () => ({ content: [{ type: "text", text: "Placeholder" }] }) // Dummy implementation with proper return type
          );
          console.log(`Registered tool schema: ${tool.name}`);
        } catch (error) {
          console.error(`Error registering tool schema for ${tool.name}:`, error);
        }
      });
      
      return tools;
    } catch (error) {
      console.error('Error fetching tool definitions:', error);
      // Return an empty array as fallback
      return [];
    }
  }
  
  // Dynamic tool execution
  async dynamicExecuteTool(toolDef: any, args: any) {
    console.log(`Dynamic executing tool: ${toolDef.name}`);
    
    try {
      const execution = toolDef.execution;
      
      if (!execution || !execution.type) {
        throw new Error(`Invalid execution config for tool: ${toolDef.name}`);
      }
      
      let result;
      const startTime = Date.now();
      
      // Handle different types of executions
      if (execution.type === 'http') {
        console.log(`Executing HTTP tool: ${toolDef.name}`);
        result = await this.executeHttpTool(execution, args);
      } else if (execution.type === 'xano_endpoint') {
        console.log(`Executing Xano endpoint tool: ${toolDef.name}`);
        result = await this.executeXanoTool(execution, args);
      } else if (execution.type === 'javascript') {
        console.log(`Executing JavaScript tool: ${toolDef.name}`);
        result = await this.executeJavaScriptTool(execution, args);
      } else {
        throw new Error(`Unsupported execution type: ${execution.type}`);
      }
      
      const endTime = Date.now();
      console.log(`Tool ${toolDef.name} executed in ${endTime - startTime}ms`);
      
      // Transform the response if needed
      let transformedResult = result;
      if (toolDef.response_transformation) {
        transformedResult = this.transformResponse(result, toolDef.response_transformation, args);
      }
      
      // Log usage to Xano
      await this.logToolUsage(toolDef.name, args, transformedResult, endTime - startTime);
      
      // Return in MCP format
      return {
        content: [{ 
          type: "text", 
          text: typeof transformedResult === 'string' ? 
            transformedResult : JSON.stringify(transformedResult) 
        }]
      };
    } catch (error) {
      console.error(`Error executing tool ${toolDef.name}:`, error);
      
      // Log the error
      await this.logToolUsage(
        toolDef.name, 
        args, 
        null, 
        0, 
        error instanceof Error ? error.message : String(error)
      );
      
      throw error;
    }
  }
  
  // Fetch external API credentials from Xano
  async getExternalApiCredentials(serviceName: string): Promise<string | null> {
    try {
      // The user must be authenticated to get API credentials
      const state = this.getState();
      if (!state.userToken) {
        console.error("Cannot get API credentials without user token");
        return null;
      }
      
      // Request the credentials from Xano
      const response = await this.xanoClient.request<{api_key: string}>(
        `/api:KOMHCtw6/get_service_credentials`,
        'POST',
        { service_name: serviceName }
      );
      
      return response.api_key;
    } catch (error) {
      console.error(`Failed to get credentials for ${serviceName}:`, error);
      return null;
    }
  }
  
  // Execute HTTP-based tools
  async executeHttpTool(execution: any, args: any) {
    // Build URL
    let url = execution.url;
    
    // Process query parameters if any
    const queryParams = this.mapParameters(execution.parameter_mapping?.query || {}, args);
    if (Object.keys(queryParams).length > 0) {
      const urlObj = new URL(url);
      for (const [key, value] of Object.entries(queryParams)) {
        urlObj.searchParams.append(key, String(value));
      }
      url = urlObj.toString();
    }
    
    // Process headers
    const headers: Record<string, string> = {...(execution.headers || {})}; 
    
    // Add auth if required
    const state = this.getState();
    if (execution.auth_required && state.userToken) {
      headers['Authorization'] = `Bearer ${state.userToken}`;
    }
    
    // Handle service-specific authentication if specified
    if (execution.auth_service) {
      const apiKey = await this.getExternalApiCredentials(execution.auth_service);
      if (apiKey) {
        if (execution.auth_header) {
          // Add as a header if specified (e.g., "Authorization: Bearer {key}")
          headers[execution.auth_header] = execution.auth_header_format
            ? execution.auth_header_format.replace('{key}', apiKey)
            : apiKey;
        } else if (execution.auth_query_param) {
          // Add as a query parameter if specified
          const urlObj = new URL(url);
          urlObj.searchParams.append(execution.auth_query_param, apiKey);
          url = urlObj.toString();
        }
      }
    }
    
    // Process body parameters if any
    const body = execution.method !== 'GET' && execution.parameter_mapping?.body ? 
      JSON.stringify(this.mapParameters(execution.parameter_mapping.body, args)) : 
      undefined;
    
    console.log(`HTTP Request: ${execution.method || 'GET'} ${url}`);
    
    // Make the request
    const response = await fetch(url, {
      method: execution.method || 'GET',
      headers,
      body
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }
    
    return await response.json();
  }
  
  // Execute Xano endpoint tools
  async executeXanoTool(execution: any, args: any) {
    const endpoint = execution.endpoint;
    
    const mappedParams = this.mapParameters(execution.parameter_mapping || {}, args);
    
    console.log(`Xano Request: POST ${this.env.XANO_BASE_URL}${endpoint}`);
    console.log(`Params: ${JSON.stringify(mappedParams)}`);
    
    // Make sure the client has the latest token
    const state = this.getState();
    this.xanoClient.setUserToken(state.userToken || "");
    
    // Use the client to make the request
    return await this.xanoClient.request(
      endpoint,
      execution.method || 'POST',
      mappedParams
    );
  }
  
  // Execute JavaScript-based tools (simplified version)
  async executeJavaScriptTool(execution: any, args: any) {
    if (!execution.code) {
      throw new Error("JavaScript execution requires code property");
    }
    
    // Very basic JavaScript execution - for more complex needs, consider a safer approach
    try {
      // Create a function from the code
      // eslint-disable-next-line no-new-func
      const execFunc = new Function('args', 'env', execution.code);
      
      // Execute with args and limited env access
      const safeEnv = {
        XANO_BASE_URL: this.env.XANO_BASE_URL
      };
      
      return execFunc(args, safeEnv);
    } catch (error) {
      console.error("JavaScript execution error:", error);
      throw new Error(`JavaScript execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Map parameters based on the provided mapping
  mapParameters(mapping: any, args: any) {
    const result: Record<string, any> = {};
    
    for (const [key, template] of Object.entries(mapping)) {
      if (typeof template === 'string') {
        result[key] = this.resolveTemplate(template, args);
      } else if (typeof template === 'object' && template !== null) {
        result[key] = this.mapParameters(template, args);
      } else {
        result[key] = template;
      }
    }
    
    return result;
  }
  
  // Resolve a template string like "{args.city}" with actual values
  resolveTemplate(template: string, args: any) {
    if (typeof template !== 'string') {
      return template;
    }
    
    return template.replace(/\{([^}]+)\}/g, (match, path) => {
      const parts = path.split('.');
      
      if (parts[0] === 'args') {
        let value = args;
        for (let i = 1; i < parts.length; i++) {
          if (value === undefined || value === null) return '';
          value = value[parts[i]];
        }
        return value !== undefined && value !== null ? value : '';
      }
      
      if (parts[0] === 'env') {
        return this.env[parts[1]] || '';
      }
      
      return match; // Keep original if not resolved
    });
  }
  
  // Transform the API response
  transformResponse(response: any, transformation: any, args: any) {
    if (transformation.type === 'template') {
      return this.resolveTemplate(transformation.template, { 
        args, 
        response 
      });
    }
    
    if (transformation.type === 'javascript' && transformation.code) {
      try {
        // eslint-disable-next-line no-new-func
        const transformFunc = new Function('response', 'args', transformation.code);
        return transformFunc(response, args);
      } catch (error) {
        console.error("Transform execution error:", error);
        // Fall back to returning the original response
        return response;
      }
    }
    
    // For now, just pass through the response if no transformation
    return response;
  }
  
  // Log tool usage to Xano
  async logToolUsage(
    toolName: string, 
    inputs: any, 
    outputs: any, 
    processingTime = 0, 
    errorMessage = ""
  ) {
    try {
      // Make sure client has the latest token
      const state = this.getState();
      this.xanoClient.setUserToken(state.userToken || "");
      
      // Log the usage
      await this.xanoClient.logUsage({
        session_id: this.sessionId,
        user_id: state.userId || "anonymous",
        function_name: toolName,
        input_params: inputs,
        output_result: outputs,
        processing_time: processingTime,
        error_message: errorMessage,
        timestamp: new Date().toISOString()
      });
      
      console.log(`Logged usage for tool: ${toolName}`);
    } catch (error) {
      console.error('Error logging usage:', error);
      // Non-critical error, so we don't throw
    }
  }
}

// Export a standard Cloudflare Worker handler
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // Handle SSE endpoint directly without OAuth flow
    if (url.pathname === '/sse') {
      // Check if MCP binding is available
      if (env.MCP_OBJECT) {
        try {
          // Get the Durable Object ID for this request
          const id = env.MCP_OBJECT.idFromName('default');
          const mcpObject = env.MCP_OBJECT.get(id);
          
          // Forward the request to the Durable Object
          return mcpObject.fetch(request);
        } catch (error) {
          console.error('Error accessing MCP Durable Object:', error);
          return new Response(JSON.stringify({
            error: 'MCP service unavailable',
            details: error.message
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } else {
        // Fallback for when MCP binding is not available
        console.log('MCP binding not available, using direct handler');
        
        // Create a simple SSE response with authentication check
        const authToken = url.searchParams.get('auth_token');
        const userId = url.searchParams.get('user_id');
        
        if (!authToken || !userId) {
          return new Response(JSON.stringify({
            error: 'Authentication required',
            message: 'Both auth_token and user_id are required'
          }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        // Create a simple SSE stream
        const stream = new ReadableStream({
          start(controller) {
            // Send initial connection message
            const encoder = new TextEncoder();
            
            // Send the endpoint event
            const baseUrl = new URL(request.url);
            baseUrl.pathname = '/api';
            baseUrl.search = '';
            
            controller.enqueue(encoder.encode(`event: endpoint\ndata: "${baseUrl.toString()}"\n\n`));
            
            // Send a welcome message
            controller.enqueue(encoder.encode(`event: message\ndata: {"type":"welcome","message":"Connected to MCP server"}\n\n`));
          }
        });
        
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          }
        });
      }
    } else if (url.pathname === '/api') {
      // Simple API endpoint for JSON-RPC requests when MCP is not available
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          
          // Handle initialize method
          if (body.method === 'initialize') {
            return new Response(JSON.stringify({
              id: body.id,
              jsonrpc: '2.0',
              result: {
                capabilities: {},
                serverInfo: {
                  name: 'Fallback MCP Server',
                  version: '1.0.0'
                }
              }
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          // Handle tools/list method
          if (body.method === 'tools/list') {
            return new Response(JSON.stringify({
              id: body.id,
              jsonrpc: '2.0',
              result: {
                tools: []  // Empty list in fallback mode
              }
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          // Default response for unhandled methods
          return new Response(JSON.stringify({
            id: body.id,
            jsonrpc: '2.0',
            error: {
              code: -32601,
              message: 'Method not available in fallback mode'
            }
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Invalid request',
            message: error.message
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }
    
    // Handle all other routes with the app
    return app.fetch(request, env, ctx);
  }
};