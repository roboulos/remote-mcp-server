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

  private async jsonRpcRequest<T = any>(method: string, params: any = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}/jsonrpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
    });
    if (!res.ok) throw new Error(`Xano HTTP error: ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: any };
    if (json.error) throw new Error(`Xano JSON-RPC error: ${JSON.stringify(json.error)}`);
    if (!('result' in json)) throw new Error("Xano JSON-RPC response missing result");
    return json.result as T;
  }

  async getTools(): Promise<XanoTool[]> {
    return this.jsonRpcRequest<XanoTool[]>("tools/list");
  }

  async createSession(sessionId: string, userId: number, clientInfo: any): Promise<XanoSession | null> {
    return this.jsonRpcRequest<XanoSession>("session/create", {
      session_id: sessionId,
      user_id: userId,
      client_info: clientInfo,
      last_active: Date.now(),
      status: "active",
    });
  }

  async updateSessionActivity(sessionId: string): Promise<boolean> {
    return this.jsonRpcRequest<boolean>("session/update-activity", {
      session_id: sessionId,
      last_active: Date.now(),
    });
  }

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
    return this.jsonRpcRequest<boolean>("logs/create", {
      session_id: sessionId,
      user_id: userId,
      method,
      request,
      response,
      error_message: errorMessage,
      processing_time: processingTime,
      ip_address: ipAddress,
    });
  }

  async storeOAuthToken(userId: number, provider: string, tokenData: any): Promise<boolean> {
    return this.jsonRpcRequest<boolean>("oauth/token/store", {
      user_id: userId,
      provider,
      access_token: tokenData.accessToken,
      refresh_token: tokenData.refreshToken || "",
      expires_at: tokenData.expiresAt || 0,
      scope: tokenData.scope || "",
      provider_user_id: tokenData.providerUserId || "",
      metadata: tokenData.metadata || {},
    });
  }

  async storeOAuthState(
    state: string,
    userId: number,
    provider: string,
    redirectUri: string,
    scope: string,
    expiresAt: number
  ): Promise<boolean> {
    return this.jsonRpcRequest<boolean>("oauth/state/store", {
      state,
      user_id: userId,
      provider,
      redirect_uri: redirectUri,
      scope,
      expires_at: expiresAt,
    });
  }

  async validateOAuthState(state: string): Promise<XanoOAuthState | null> {
    return this.jsonRpcRequest<XanoOAuthState>("oauth/state/validate", { state });
  }

  async getOAuthToken(userId: number, provider: string): Promise<any | null> {
    return this.jsonRpcRequest<any>("oauth/token/get", { user_id: userId, provider });
  }

  async executeTool(toolName: string, params: any): Promise<any> {
    return this.jsonRpcRequest<any>("tools/execute", { tool: toolName, params });
  }
}
