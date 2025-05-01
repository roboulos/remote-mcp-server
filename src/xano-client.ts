// XanoClient: User-authenticated client for Xano MCP integration

export interface XanoTool {
  id: number;
  name: string;
  description: string;
  parameter_schema: any;
  execution: {
    type: string;
    url?: string;
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    auth_required?: boolean;
    auth_service?: string;
    auth_header?: string;
    auth_header_format?: string;
    auth_query_param?: string;
    parameter_mapping?: any;
    code?: string;
  };
  response_transformation?: {
    type: string;
    template?: string;
    code?: string;
  };
  provider: string;
  metadata: any;
  active: boolean;
}

export interface XanoSession {
  id: number;
  session_id: string;
  user_id: string;
  client_info: any;
  last_active: number;
  status: string;
}

export interface XanoLogEntry {
  session_id: string;
  user_id: string;
  function_name: string;
  input_params: any;
  output_result: any;
  processing_time: number;
  error_message: string;
  timestamp: string;
}

export class XanoClient {
  private baseUrl: string;
  private userToken?: string;

  constructor(baseUrl: string, userToken?: string) {
    this.baseUrl = baseUrl;
    this.userToken = userToken;
  }

  // Set user token
  setUserToken(token: string) {
    this.userToken = token;
  }

  // Get auth headers
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (this.userToken) {
      headers['Authorization'] = `Bearer ${this.userToken}`;
    }
    
    return headers;
  }

  // Generic API request
  async request<T = any>(
    endpoint: string, 
    method: string = 'GET', 
    body?: any
  ): Promise<T> {
    try {
      // Check if we have a token for auth-required operations
      if (!this.userToken) {
        console.warn(`Warning: Making request to ${endpoint} without user token`);
      }
      
      const url = `${this.baseUrl}${endpoint}`;
      
      const requestOptions: RequestInit = {
        method,
        headers: this.getAuthHeaders()
      };
      
      if (body && method !== 'GET') {
        requestOptions.body = JSON.stringify(body);
      }
      
      console.log(`Making ${method} request to ${url}`);
      const response = await fetch(url, requestOptions);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Xano API Error (${response.status}): ${errorText}`);
      }
      
      return await response.json() as T;
    } catch (error) {
      console.error(`Error in Xano API request to ${endpoint}:`, error);
      throw error;
    }
  }

  // Get list of tools
  async getTools(userId?: string, sessionId?: string): Promise<XanoTool[]> {
    return this.request<XanoTool[]>(
      '/api:KOMHCtw6/list_functions',
      'POST',
      {
        user_id: userId,
        session_id: sessionId || 'default'
      }
    );
  }
  
  // Get tool definitions for MCP
  async getToolDefinitions(userId?: string, sessionId?: string): Promise<XanoTool[]> {
    // This is an alias for getTools that matches the method name used in the MCP implementation
    return this.getTools(userId, sessionId);
  }

  // Get tool details
  async getToolDetails(toolId: number, userId?: string, sessionId?: string): Promise<XanoTool> {
    return this.request<XanoTool>(
      `/api:KOMHCtw6/get_function/${toolId}`,
      'POST',
      {
        user_id: userId,
        session_id: sessionId || 'default'
      }
    );
  }

  // Register a session
  async registerSession(sessionId: string, userId: string, clientInfo: any): Promise<XanoSession> {
    return this.request<XanoSession>(
      '/api:KOMHCtw6/mcp_connect',
      'POST',
      {
        session_id: sessionId,
        user_id: userId,
        client_info: clientInfo,
        status: 'active'
      }
    );
  }

  // Update session activity
  async updateSessionActivity(sessionId: string): Promise<XanoSession> {
    return this.request<XanoSession>(
      '/api:KOMHCtw6/update_session',
      'PUT',
      {
        session_id: sessionId,
        last_active: Date.now()
      }
    );
  }

  // Execute a function
  async executeFunction(
    functionName: string, 
    parameters: any, 
    sessionId?: string,
    userId?: string
  ): Promise<any> {
    return this.request<any>(
      '/api:KOMHCtw6/mcp_execute',
      'POST',
      {
        function_name: functionName,
        parameters,
        session_id: sessionId || 'default',
        user_id: userId
      }
    );
  }

  // Log usage
  async logUsage(logEntry: XanoLogEntry): Promise<any> {
    return this.request<any>(
      '/api:wejyQeTL/log_usage',
      'POST',
      logEntry
    );
  }
}