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
          "Describe the image precisely in first-person POV style: highly photorealistic, HDR quality, anatomically correct, intimate framing close to subject (upper body to full body). Emphasize detailed clothing descriptions (fabric, fit, styling), physical context (location, background ambiance), specific lighting conditions (strong flash, neon, sunlight), clear emotional or facial expressions (surprise, playful, sultry), and body language (dramatic poses, subtle gestures). Clearly specify the angle and framing to reinforce intimacy and realism."
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
          "Casca"
        ]).describe(
          "Select a model based on the desired physical characteristics and facial structure matching previous successful generations. Each model has unique attributes; choose accordingly to match your prompt's description."
        ),

        modifier_name: z.enum([
          "Boreal",
          "Party Girls",
          "Average",
          "Facebook",
          "Rawfully",
          "Party 2"
        ]).default("Boreal").describe(
          "Optional stylistic enhancement to influence lighting, color tones, or thematic feel. 'Party' modifiers intensify vibrant nightlife or social ambiance, 'Boreal' provides cooler tones, and 'Rawfully' introduces realistic imperfections or candid effects. Select according to mood desired."
        ),

        modifier_scale: z.number().min(0).max(0.8).default(0.5).describe(
          "Adjust intensity of chosen modifier: 0 for no effect, 0.5 for balanced effect, and up to 0.8 for maximum impact. Recommended range for balanced effect is typically between 0.4-0.7."
        ),

        image_size: z.enum([
          "square_hd",
          "portrait_4_3",
          "portrait_16_9"
        ]).default("square_hd").describe(
          "Aspect ratio and resolution of the generated image: 'square_hd' for balanced composition, 'portrait_4_3' for portrait photography framing, 'portrait_16_9' for selfie portrait shots."
        ),

        cfg: z.string().default("7").describe(
          "Classifier-free guidance scale (CFG) affects adherence to prompt details: lower (3-5) allows creative variation, medium (7, default) balances creativity with accuracy, higher (8-12) more strictly follows prompt details."
        ),

        num_images: z.string().default("1").describe(
          "Specify the number of images generated per prompt. Default of 1 is recommended for focused review; up to 4 for comparative analysis."
        ),
      },

      async ({
        prompt,
        model_name,
        modifier_name = "Boreal",
        modifier_scale = 0.5,
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
        // Adapt this to return image URLs or base64 as needed
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