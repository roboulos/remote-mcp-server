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
import { XanoClient } from "./xano-client";

export type Bindings = Env & {
	OAUTH_PROVIDER: OAuthHelpers;
	XANO_BASE_URL: string;
	XANO_API_KEY: string;
};

const app = new Hono<{
	Bindings: Bindings;
}>();

// Create a function to get the Xano client with environment variables
const getXanoClient = (c: any) => {
	const xanoBaseUrl = c.env.XANO_BASE_URL || "https://x8ki-letl-twmt.n7.xano.io/api:snappy";
	const xanoApiKey = c.env.XANO_API_KEY || "";
	return new XanoClient(xanoBaseUrl, xanoApiKey);
};

// Render a basic homepage placeholder to make sure the app is up
app.get("/", async (c) => {
	const content = await homeContent(c.req.raw);
	return c.html(layout(content, "Snappy MCP - Home"));
});

// Render an authorization page
// If the user is logged in, we'll show a form to approve the appropriate scopes
// If the user is not logged in, we'll show a form to both login and approve the scopes
app.get("/authorize", async (c) => {
	// Check for user in cookie or session
	const sessionCookie = c.req.header("Cookie")?.split(";").find(c => c.trim().startsWith("session="));
	const userId = sessionCookie ? parseInt(sessionCookie.split("=")[1], 10) : 0;
	
	const isLoggedIn = userId > 0;
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

	// Store the OAuth state in Xano
	if (oauthReqInfo.state) {
		try {
			const xanoClient = getXanoClient(c);
			await xanoClient.storeOAuthState(
				oauthReqInfo.state,
				userId,
				"mcp",
				oauthReqInfo.redirectUri || "",
				oauthReqInfo.scope || "",
				Date.now() + 3600000 // 1 hour expiry
			);
		} catch (error) {
			console.error("Failed to store OAuth state in Xano:", error);
		}
	}

	const oauthScopes = [
		{
			name: "read_profile",
			description: "Read your basic profile information",
		},
		{ name: "read_data", description: "Access your stored data" },
		{ name: "write_data", description: "Create and modify your data" },
	];

	if (isLoggedIn) {
		const content = await renderLoggedInAuthorizeScreen(oauthScopes, oauthReqInfo);
		return c.html(layout(content, "Snappy MCP - Authorization"));
	}

	const content = await renderLoggedOutAuthorizeScreen(oauthScopes, oauthReqInfo);
	return c.html(layout(content, "Snappy MCP - Authorization"));
});

// The /authorize page has a form that will POST to /approve
// This endpoint is responsible for validating any login information and
// then completing the authorization request with the OAUTH_PROVIDER
app.post("/approve", async (c) => {
	const { action, oauthReqInfo, email, password } = await parseApproveFormBody(
		await c.req.parseBody(),
	);

	if (!oauthReqInfo) {
		return c.html("INVALID LOGIN", 401);
	}

	// If the user needs to both login and approve, we should validate the login first
	if (action === "login_approve") {
		try {
			// You would typically validate against your Xano user database here
			// For this demo, we'll continue to allow any login
			// const xanoClient = getXanoClient(c);
			// const user = await xanoClient.validateUserCredentials(email, password);
			// if (!user) {
			// 	return c.html(
			// 		layout(
			// 			await renderAuthorizationRejectedContent("/"),
			// 			"Snappy MCP - Authorization Status",
			// 		),
			// 	);
			// }
		} catch (error) {
			console.error("Error validating user credentials:", error);
			return c.html(
				layout(
					await renderAuthorizationRejectedContent("/"),
					"Snappy MCP - Authorization Status",
				),
			);
		}
	}

	// The user must be successfully logged in and have approved the scopes, so we
	// can complete the authorization request
	const { redirectTo, token } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: email,
		metadata: {
			label: "Snappy User",
		},
		scope: oauthReqInfo.scope,
		props: {
			userEmail: email,
		},
	});

	// Store token in Xano
	try {
		// To get user ID, you would typically look up the user by email in your database
		// For this demo, we'll use a hardcoded user ID
		const userId = 1;
		
		const xanoClient = getXanoClient(c);
		await xanoClient.storeOAuthToken(userId, "mcp", {
			accessToken: token.accessToken,
			refreshToken: token.refreshToken || "",
			expiresAt: Date.now() + (token.expiresIn || 3600) * 1000,
			scope: oauthReqInfo.scope || "",
			providerUserId: email,
			metadata: {
				clientId: oauthReqInfo.clientId,
				redirectUri: oauthReqInfo.redirectUri,
			},
		});
	} catch (error) {
		console.error("Failed to store OAuth token in Xano:", error);
	}

	// Set a cookie with the user information
	c.header("Set-Cookie", `session=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);

	return c.html(
		layout(
			await renderAuthorizationApprovedContent(redirectTo),
			"Snappy MCP - Authorization Status",
		),
	);
});

export default app;