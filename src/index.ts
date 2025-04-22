import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";


// Configuration for the Xano API comes from environment variables
// This will be set in wrangler.jsonc and accessed through env

interface MyMCPState {
  counter?: number;
}

export class MyMCP extends McpAgent<unknown, MyMCPState> {
  server = new McpServer({
    name: "Snappy MCP",
    version: "1.0.0",
  });



  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }



  async init() {
    // Register a basic add tool directly (as a fallback)
    this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));

    // Register a greet tool (local, Cloudflare-style)
    this.server.tool("greet", { name: z.string() }, async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }],
    }));

    // Register a persistent counter resource
    this.server.resource(
      "counter",
      "mcp://resource/counter",
      (uri) => ({
        contents: [{ uri: uri.href, text: String(this.state.counter ?? 0) }],
      })
    );

    // Register a tool to increment the counter
    this.server.tool(
      "incrementCounter",
      { amount: z.number().default(1) },
      async ({ amount }) => {
        const newValue = (this.state.counter ?? 0) + amount;
        this.setState({ ...this.state, counter: newValue });
        return {
          content: [{ type: "text", text: `Counter incremented by ${amount}. New value: ${newValue}` }],
        };
      }
    );

    // Register a tool to generate an image via Xano API
    this.server.tool(
      "generateImage",
      {
        prompt: z.string().describe(
          "The image description in first-person POV style: photorealistic HDR, anatomically correct, full-body framing, detailing clothing, context, lighting, framing, and subject expression."
        ),
        model_name: z.enum([
          "Anveshi",
          "Adrianna",
          "Franceska",
          "Austin",
          "Sarai",
          "Amber",
          "Wendy",
          "Jane",
          "Casca"
        ]).describe("The model to use for image generation."),
        modifier_name: z.enum([
          "None",
          "Anime",
          "Cartoon",
          "Noir",
          "Cyberpunk",
          "Fantasy"
        ]).default("None").describe("The modifier to apply (optional)."),
        modifier_scale: z.number().min(0).max(10).default(5).describe("Modifier scale (0-10, default 5)."),
        image_size: z.enum([
          "square_hd",
          "portrait_hd",
          "landscape_hd"
        ]).default("square_hd").describe("Image size (default: square_hd)."),
        cfg: z.string().default("7").describe("CFG value (default 7)."),
        num_images: z.string().default("1").describe("Number of images to generate (default 1)."),
      },
      async ({
        prompt,
        model_name,
        modifier_name = "None",
        modifier_scale = 5,
        image_size = "square_hd",
        cfg = "7",
        num_images = "1",
      }) => {
        const response = await fetch("https://xnwv-v1z6-dvnr.n7c.xano.io/api:_WUcacrv/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            model_name,
            modifier_name,
            modifier_scale,
            image_size,
            cfg,
            num_images,
          }),
        });
        if (!response.ok) {
          return { content: [{ type: "text", text: `Error: ${response.statusText}` }] };
        }
        const data = await response.json();
        // You can adapt this to return image URLs or base64 as needed
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );
  }

}

import OAuthProvider from "@cloudflare/workers-oauth-provider";

// Export the OAuth handler as the default (Cloudflare best practice)
export default new OAuthProvider({
  apiRoute: "/sse",
  // @ts-ignore
  apiHandler: MyMCP.mount("/sse"),
  // @ts-ignore
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});