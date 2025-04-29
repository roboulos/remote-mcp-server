declare module '@modelcontextprotocol/sdk' {
  export class McpAgent<T = any, S = any> {
    state: S;
    constructor(ctx: any, env: any);
    connect(request: Request): Promise<Response>;
  }

  export class McpServer {
    constructor(options: { name: string; version: string });
    on(event: string, callback: (error: any) => void): void;
    onToolCall(callback: (name: string, args: any) => any): void;
    resource(name: string, uri: string, callback: (uri: { href: string }) => any): void;
    tool(name: string, schema: any, callback: (args?: any) => any): any;
  }
}
