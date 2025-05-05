import type { DurableObjectState, DurableObjectNamespace } from '@cloudflare/workers-types';

// Define the environment interface
export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  XANO_BASE_URL: string;
}

declare module '@modelcontextprotocol/sdk' {
  export class McpAgent<TEnv = any, TState = any, TProps = any> {
    state: TState;
    props?: TProps;
    env: TEnv;
    sessionId: string;
    
    constructor(ctx: DurableObjectState, env: TEnv);
    setState(state: Partial<TState>): void;
    connect(request: Request): Promise<Response>;
    
    // Add static fetch method for Durable Object handling
    static fetch(request: Request, env?: any, ctx?: any): Promise<Response>;
  }

  export class McpServer {
    constructor(options: { name: string; version: string });
    on(event: string, callback: (error: any) => void): void;
    setToolHandler(callback: (name: string, args: any, context: any) => any): void;
    resource(name: string, uri: string, callback: (uri: { href: string }) => any): void;
    tool(name: string, schema: any, callback: (args?: any) => any): any;
    fetch(request: Request): Promise<Response>;
  }
}
