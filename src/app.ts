import { Hono } from "hono";
import {
  layout,
  homeContent,
  parseApproveFormBody,
  renderAuthorizationRejectedContent,
  renderAuthorizationApprovedContent,
  renderLoggedInAuthorizeScreen,
  renderLoggedOutAuthorizeScreen,
} from "./utils";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const app = new Hono<{ Bindings: Env }>();

// Homepage
app.get("/", async (c) => {
  const content = await homeContent(c.req.raw);
  return c.html(layout(content, "MCP Remote Auth Demo - Home"));
});

// Authorization page
app.get("/authorize", async (c) => {
  const isLoggedIn = true;
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const oauthScopes = [
    { name: "read_profile", description: "Read your basic profile information" },
    { name: "read_data", description: "Access your stored data" },
    { name: "write_data", description: "Create and modify your data" },
  ];

  if (isLoggedIn) {
    const content = await renderLoggedInAuthorizeScreen(oauthScopes, oauthReqInfo);
    return c.html(layout(content, "MCP Remote Auth Demo - Authorization"));
  }
  const content = await renderLoggedOutAuthorizeScreen(oauthScopes, oauthReqInfo);
  return c.html(layout(content, "MCP Remote Auth Demo - Authorization"));
});

// Approve handler
app.post("/approve", async (c) => {
  const { action, oauthReqInfo, email, password } = await parseApproveFormBody(
    await c.req.parseBody(),
  );

  if (!oauthReqInfo) {
    return c.html("INVALID LOGIN", 401);
  }

  // Demo: allow any login
  if (action === "login_approve") {
    // You could add real validation here
  }

  // Complete the authorization
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: email || "demo-user@example.com",
    metadata: { label: "Test User" },
    scope: oauthReqInfo.scope,
    props: { userEmail: email || "demo-user@example.com" },
  });

  return c.html(
    layout(
      await renderAuthorizationApprovedContent(redirectTo),
      "MCP Remote Auth Demo - Authorization Status",
    ),
  );
});

export default app;