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
          "Craft a sultry, photorealistic, first-person POV description, emphasizing intimacy and realism. Include scenarios like office environments, bosses, coworkers, work parties, retail settings, or after-hours situations. Describe clothing precisely (fabric, fit, style, and sensuality), clearly showcase anatomy and physical features, use dramatic poses or subtle gestures, and specify strong flash lighting or neon ambiance. The subject should convey a clear sultry, playful, or suggestive emotional expression. Framing should be close-up or full-body, reinforcing an intimate connection."
        ),

        model_name: z.enum([
          "Anveshi",
          "Adrianna",
          "Franceska",
          "Austin",
          "Rebecca",
          "Ashley",
          "Wendy",
          "Wettmelons",
          "Lily",
          "Casca"
        ]).describe(
          "Select a model based on previous successes, focusing on attributes that complement office or work-party scenarios, and a sultry or flirtatious appearance."
        ),

        modifier_name: z.enum([
          "Boreal",
          "Party Girls",
          "Average",
          "Facebook",
          "Rawfully",
          "Party 2"
        ]).default("Party 2").describe(
          "Optional stylistic enhancement to influence mood and sensual ambiance. 'Party 2' or 'Party Girls' modifiers intensify nightlife or party scenarios, 'Rawfully' introduces candid realism, while 'Boreal' or 'Facebook' offer more neutral, professional tones."
        ),

        modifier_scale: z.number().min(0).max(0.8).default(0.6).describe(
          "Intensity of the chosen modifier: 0 (no effect), 0.4-0.7 (balanced and realistic sensuality), and up to 0.8 (strong mood enhancement). Recommended around 0.6 for balanced sultriness."
        ),

        image_size: z.enum([
          "square_hd",
          "portrait_4_3",
          "portrait_16_9"
        ]).default("portrait_4_3").describe(
          "Aspect ratio suited for intimate portrait framing: 'portrait_4_3' for professional yet intimate framing, 'portrait_16_9' for cinematic selfies, and 'square_hd' for balanced framing."
        ),

        cfg: z.string().default("8").describe(
          "CFG scale determines strictness to prompt adherence. Recommended higher (7-9) to ensure precise capture of intimate, sultry details."
        ),

        num_images: z.string().default("1").describe(
          "Number of images generated per prompt. Default is 1 for clear, focused results; up to 3 for comparative analysis or exploring variations."
        ),
      },

      async ({
        prompt,
        model_name,
        modifier_name = "Party 2",
        modifier_scale = 0.6,
        image_size = "portrait_4_3",
        cfg = "8",
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
        // Follow up in character as if the subject of the generated image has personally shared it, maintaining a playful, flirtatious, or subtly suggestive tone.
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