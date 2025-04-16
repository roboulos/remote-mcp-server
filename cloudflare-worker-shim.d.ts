// This file suppresses known type mismatches between Hono/OAuthProvider and Cloudflare Worker types
// It tells TypeScript to trust the default export in src/index.ts as a valid Worker handler

declare module "./src/index" {
  const handler: import("@cloudflare/workers-types").ExportedHandler;
  export default handler;
}
