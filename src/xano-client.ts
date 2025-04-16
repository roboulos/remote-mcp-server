import axios from 'axios';

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

  // Tool-related methods
  async getTools(): Promise<XanoTool[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tools`, {
        headers: {
          'X-API-Key': this.apiKey,
        },
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching tools from Xano:', error);
      return [];
    }
  }

  // Session management
  async createSession(sessionId: string, userId: number, clientInfo: any): Promise<XanoSession | null> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/sessions`,
        {
          session_id: sessionId,
          user_id: userId,
          client_info: clientInfo,
          last_active: Date.now(),
          status: 'active',
        },
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error('Error creating session in Xano:', error);
      return null;
    }
  }

  async updateSessionActivity(sessionId: string): Promise<boolean> {
    try {
      await axios.put(
        `${this.baseUrl}/api/sessions/update-activity`,
        {
          session_id: sessionId,
          last_active: Date.now(),
        },
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return true;
    } catch (error) {
      console.error('Error updating session activity in Xano:', error);
      return false;
    }
  }

  // Logging
  async logMcpRequest(
    sessionId: string,
    userId: number,
    method: string,
    request: any,
    response: any = null,
    errorMessage: string = '',
    processingTime: number = 0,
    ipAddress: string = ''
  ): Promise<boolean> {
    try {
      await axios.post(
        `${this.baseUrl}/api/logs`,
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
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return true;
    } catch (error) {
      console.error('Error logging to Xano:', error);
      return false;
    }
  }

  // OAuth token management
  async storeOAuthToken(userId: number, provider: string, tokenData: any): Promise<boolean> {
    try {
      await axios.post(
        `${this.baseUrl}/api/oauth/tokens`,
        {
          user_id: userId,
          provider,
          access_token: tokenData.accessToken,
          refresh_token: tokenData.refreshToken || '',
          expires_at: tokenData.expiresAt || 0,
          scope: tokenData.scope || '',
          provider_user_id: tokenData.providerUserId || '',
          metadata: tokenData.metadata || {},
        },
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return true;
    } catch (error) {
      console.error('Error storing OAuth token in Xano:', error);
      return false;
    }
  }
  
  async storeOAuthState(
    state: string,
    userId: number,
    provider: string,
    redirectUri: string,
    scope: string,
    expiresAt: number
  ): Promise<boolean> {
    try {
      await axios.post(
        `${this.baseUrl}/api/oauth/states`,
        {
          state,
          user_id: userId,
          provider,
          redirect_uri: redirectUri,
          scope,
          expires_at: expiresAt,
        },
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return true;
    } catch (error) {
      console.error('Error storing OAuth state in Xano:', error);
      return false;
    }
  }
  
  async validateOAuthState(state: string): Promise<XanoOAuthState | null> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/api/oauth/states/${state}`,
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error('Error validating OAuth state from Xano:', error);
      return null;
    }
  }

  async getOAuthToken(userId: number, provider: string): Promise<any | null> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/api/oauth/tokens/${userId}/${provider}`,
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error('Error fetching OAuth token from Xano:', error);
      return null;
    }
  }

  // Tool execution (if you want to delegate actual tool execution to Xano)
  async executeTool(toolName: string, params: any): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/tools/execute/${toolName}`,
        params,
        {
          headers: {
            'X-API-Key': this.apiKey,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Error executing tool ${toolName} in Xano:`, error);
      throw error;
    }
  }
}