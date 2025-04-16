// XanoClient: JSON-RPC integration for Cloudflare Worker
// Uses fetch (not axios) for compatibility and performance

export interface XanoTool {
  id: number;
  name: string;
  description: string;
  input_schema: any;
  provider: string;
  metadata: any;
  active: boolean;
}

export interface XanoSession {
  id: number;
  session_id: string;
  user_id: number;
  client_info: any;
  last_active: number;
  status: string;
}

export interface XanoOAuthState {
  id: number;
  state: string;
  user_id: number;
  provider: string;
  redirect_uri: string;
  scope: string;
  expires_at: number;
}

export class XanoClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  // Generic JSON-RPC request method
  async jsonRpcRequest<T = any>(method: string, params: Record<string, any> = {}, id: string = crypto.randomUUID()): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}/jsonrpc`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params
        }),
      });
      if (!res.ok) throw new Error(`Failed JSON-RPC call: ${res.status}`);
      const json = (await res.json()) as any;
      if ('error' in json) throw new Error(`JSON-RPC error: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (error) {
      console.error(`Error in JSON-RPC request [${method}]:`, String(error));
      throw error;
    }
  }

  // Get list of tools
  async getTools(sessionId: string): Promise<XanoTool[]> {
    return this.jsonRpcRequest<XanoTool[]>('tools/list', {}, sessionId);
  }

  // Get list of resources
  async getResources(sessionId: string): Promise<any[]> {
    return this.jsonRpcRequest<any[]>('resources/list', {}, sessionId);
  }

  // Create a session in Xano
  async createSession(sessionId: string, userId: number, clientInfo: any): Promise<XanoSession | null> {
    return this.jsonRpcRequest<XanoSession>(
      'session/create',
      {
        session_id: sessionId,
        user_id: userId,
        client_info: clientInfo,
        last_active: Date.now(),
        status: 'active',
      },
      sessionId
    );
  }

  // Log MCP request to Xano
  async logMcpRequest(
    sessionId: string,
    userId: number,
    method: string,
    request: any,
    response: any = null,
    errorMessage = "",
    processingTime = 0,
    ipAddress = ""
  ): Promise<boolean> {
    return this.jsonRpcRequest<boolean>(
      'logs/create',
      {
        session_id: sessionId,
        user_id: userId,
        method,
        request,
        response,
        error_message: errorMessage,
        processing_time: processingTime,
        ip_address: ipAddress,
      },
      sessionId
    );
  }

  // Initialize connection (get server info/capabilities)
  async initialize(sessionId: string): Promise<any> {
    return this.jsonRpcRequest<any>('initialize', {}, sessionId);
  }

  // Example: execute a tool (if your JSON-RPC server supports it)
  async executeTool(toolName: string, params: any, sessionId: string): Promise<any> {
    return this.jsonRpcRequest<any>(toolName, params, sessionId);
  }
}
