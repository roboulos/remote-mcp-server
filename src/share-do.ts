import type { DurableObjectState } from "@cloudflare/workers-types";

interface StoredData {
  xanoToken: string;
  userId: string;
  expiresAt: number;
}

export class ShareDo {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/save":
        if (request.method !== "PUT") return this.methodNotAllowed();
        const { xanoToken, userId } = (await request.json()) as {
          xanoToken: string;
          userId: string;
        };
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await this.state.storage.put<StoredData>("data", {
          xanoToken,
          userId,
          expiresAt,
        });
        return new Response("saved", { status: 200 });
      case "/get":
        {
          const rec = (await this.state.storage.get<StoredData>("data")) || null;
          if (!rec || rec.expiresAt < Date.now()) {
            return new Response("not found", { status: 404 });
          }
          return new Response(JSON.stringify(rec), { headers: { "content-type": "application/json" } });
        }
      case "/revoke":
        if (request.method !== "DELETE") return this.methodNotAllowed();
        await this.state.storage.delete("data");
        return new Response("revoked");
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private methodNotAllowed() {
    return new Response("method not allowed", { status: 405 });
  }
}
