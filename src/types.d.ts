import type { DurableObjectState } from '@cloudflare/workers-types';

// Define a flexible DurableObjectNamespace that works with multiple versions of Cloudflare Worker types
export interface FlexibleDurableObjectNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
  };
}

// Define the environment interface
export interface Env {
  MCP_OBJECT: FlexibleDurableObjectNamespace;
  SHARE_DO?: FlexibleDurableObjectNamespace;
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
