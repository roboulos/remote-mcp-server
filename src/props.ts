// src/props.ts
export interface XanoUser {
    id: string;
    email?: string;
    name?: string;
    [key: string]: any;
  }
  
  export interface XanoProps {
    user?: XanoUser;
    accessToken?: string;
    permissions?: string[];
    
    // Props must have an index signature to satisfy the `McpAgent`
    // generic `Props` which extends `Record<string, unknown>`.
    [key: string]: unknown;
  }