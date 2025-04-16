import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { XanoClient } from "./xano-client";

// Configuration for the Xano API comes from environment variables
// This will be set in wrangler.jsonc and accessed through env

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Snappy MCP",
		version: "1.0.0",
	});

	private xanoClient: XanoClient;

	constructor() {
		super();
		// Will initialize the client with environment variables later in the request lifecycle
		this.xanoClient = null;
	}
	
	private initXanoClient(env: any) {
		if (!this.xanoClient) {
			const xanoBaseUrl = env.XANO_BASE_URL || "https://x8ki-letl-twmt.n7.xano.io/api:snappy";
			const xanoApiKey = env.XANO_API_KEY || "";
			this.xanoClient = new XanoClient(xanoBaseUrl, xanoApiKey);
		}
		return this.xanoClient;
	}

	async init() {
		// Register a basic add tool directly (as a fallback)
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));

		// Register dynamic tool loader that will proxy to Xano
		this.server.tool("dynamic", { tool: z.string(), params: z.record(z.any()) }, async ({ tool, params }, env) => {
			try {
				// Initialize Xano client with environment variables if needed
				const xanoClient = this.initXanoClient(env);
				
				// Execute the tool via Xano
				const result = await xanoClient.executeTool(tool, params);
				
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (error) {
				console.error(`Error executing dynamic tool ${tool}:`, error);
				return {
					content: [{ type: "text", text: `Error executing tool: ${error.message || "Unknown error"}` }],
				};
			}
		});
	}
	
	// Add a method to load and register all tools from Xano
	async loadXanoTools(env: any) {
		try {
			const xanoClient = this.initXanoClient(env);
			const tools = await xanoClient.getTools();
			
			for (const tool of tools) {
				// Check if tool is already registered
				const isToolRegistered = this.server.getMethods().find(m => m === tool.name) !== undefined;
				if (tool.active && !isToolRegistered) {
					// Convert Xano's JSON schema to Zod schema
					const paramSchema = this.convertJsonSchemaToZod(tool.input_schema);
					
					// Register the tool with a handler that delegates to Xano
					this.server.tool(tool.name, paramSchema, async (params) => {
						try {
							const result = await xanoClient.executeTool(tool.name, params);
							return {
								content: [{ type: "text", text: JSON.stringify(result) }],
							};
						} catch (error) {
							console.error(`Error executing tool ${tool.name}:`, error);
							return {
								content: [{ type: "text", text: `Error executing tool: ${error.message || "Unknown error"}` }],
							};
						}
					});
				}
			}
		} catch (error) {
			console.error("Failed to load tools from Xano:", error);
		}
	}

	// Helper method to convert JSON schema to Zod schema
	// This is a simplified version and might need to be expanded based on your schemas
	private convertJsonSchemaToZod(jsonSchema: any) {
		const schema: Record<string, any> = {};
		
		// Handle simple property types
		if (jsonSchema && jsonSchema.properties) {
			Object.entries(jsonSchema.properties).forEach(([key, value]: [string, any]) => {
				switch (value.type) {
					case "string":
						schema[key] = z.string();
						break;
					case "number":
						schema[key] = z.number();
						break;
					case "boolean":
						schema[key] = z.boolean();
						break;
					case "object":
						schema[key] = z.object(this.convertJsonSchemaToZod(value));
						break;
					case "array":
						if (value.items && value.items.type === "string") {
							schema[key] = z.array(z.string());
						} else if (value.items && value.items.type === "number") {
							schema[key] = z.array(z.number());
						} else {
							schema[key] = z.array(z.any());
						}
						break;
					default:
						schema[key] = z.any();
				}
				
				// Handle required properties
				if (jsonSchema.required && !jsonSchema.required.includes(key)) {
					schema[key] = schema[key].optional();
				}
			});
		}
		
		return schema;
	}

	// Override the onRequest method to add session tracking and logging
	async onRequest(request: Request, env: any, ctx: any): Promise<Response> {
		const sessionId = request.headers.get("X-Session-ID") || crypto.randomUUID();
		const userId = parseInt(request.headers.get("X-User-ID") || "0", 10);
		const startTime = Date.now();
		
		// Initialize the Xano client with environment variables
		const xanoClient = this.initXanoClient(env);
		
		try {
			// Track session
			await xanoClient.createSession(sessionId, userId, {
				userAgent: request.headers.get("User-Agent"),
				ip: request.headers.get("CF-Connecting-IP"),
			});
			
			// Load Xano tools if this is the first request
			await this.loadXanoTools(env);
			
			// Process the request
			const response = await super.onRequest(request, env, ctx);
			
			// Log the request
			const processingTime = Date.now() - startTime;
			await xanoClient.logMcpRequest(
				sessionId,
				userId,
				request.method,
				{ url: request.url, headers: Object.fromEntries(request.headers.entries()) },
				{ status: response.status },
				"",
				processingTime,
				request.headers.get("CF-Connecting-IP") || ""
			);
			
			return response;
		} catch (error) {
			// Log error
			const processingTime = Date.now() - startTime;
			await xanoClient.logMcpRequest(
				sessionId,
				userId,
				request.method,
				{ url: request.url, headers: Object.fromEntries(request.headers.entries()) },
				null,
				error.message || "Unknown error",
				processingTime,
				request.headers.get("CF-Connecting-IP") || ""
			);
			
			throw error;
		}
	}
}

// Export the OAuth handler as the default
export default new OAuthProvider({
	apiRoute: "/sse",
	// TODO: fix these types
	// @ts-ignore
	apiHandler: MyMCP.mount("/sse"),
	// @ts-ignore
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});