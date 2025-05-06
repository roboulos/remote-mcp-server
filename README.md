# Snappy MCP Server with Xano Integration

A remote MCP server built on Cloudflare Workers with Xano database integration for tool management, session tracking, and OAuth. Now with full support for the latest Streamable HTTP transport protocol (2024-11-05).

## Develop locally

```bash
# clone the repository
git clone https://github.com/roboulos/remote-mcp-server.git

# install dependencies
cd remote-mcp-server
npm install

# Configure Xano API Key
# Add your Xano API key to wrangler.jsonc in the XANO_API_KEY variable

# run locally
npm run dev
```

You should be able to open [`http://localhost:8787/`](http://localhost:8787/) in your browser

## Connect to your MCP server

### Using the MCP Inspector (legacy)

To explore your new MCP API with the older SSE transport, you can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).

- Start it with `npx @modelcontextprotocol/inspector`
- [Within the inspector](http://localhost:5173), switch the Transport Type to `SSE` and enter `http://localhost:8787/sse` as the URL of the MCP server to connect to, and click "Connect"
- You will navigate to a (mock) user/password login screen. Input any email and pass to login.
- You should be redirected back to the MCP Inspector and you can now list and call any defined tools!

### Using Workers AI Playground (Streamable HTTP)

To test with the latest Streamable HTTP transport protocol:

1. Visit the [Workers AI Playground](https://workers.cloudflare.com/ai/playground)
2. When prompted to connect to an MCP server, enter your endpoint URL:
   ```
   https://remote-mcp-server.robertjboulos.workers.dev/mcp
   ```
   or for local testing:
   ```
   http://localhost:8787/mcp
   ```
3. Provide authentication credentials when prompted:
   - **auth_token**: Your Xano authentication token
   - **user_id**: Your Xano user ID
4. The Playground will handle session management automatically using the new protocol

### Share-Link Flow (desktop IDE & CLI)

For external tools that can’t easily manage Xano bearer tokens you can generate a short-lived **MCP token** (stored in a Durable Object) and share it instead.

```bash
# generate a share-link (24h TTL)
curl -X POST http://localhost:8787/api/create-share \
     -d '{"xanoToken":"<YOUR_XANO_TOKEN>","userId":"<USER_ID>"}'
# → { "mcpUrl": "http://localhost:8787/mcp", "mcpToken": "123e…" }

# connect from any MCP client
npx mcp-remote http://localhost:8787/mcp \
    --header "Authorization=Bearer 123e…"

# revoke the link early
curl -X POST http://localhost:8787/api/revoke-share -d '{"mcpToken":"123e…"}'
```

The worker stores the mapping `{mcpToken → xanoToken,userId,expiresAt}` in a Durable Object called `SHARE_DO`.  When you deploy to Cloudflare this ensures the token works across all PoPs.

### Streamable HTTP Transport (Recommended)

To use the newer, more efficient Streamable HTTP transport with Claude Desktop, update your configuration to use the `/mcp` endpoint instead:

```json
{
  "mcpServers": {
    "xano": {
      "remoteUrl": "http://localhost:8787/mcp",
      "auth": {
        "type": "bearer",
        "token": "YOUR_XANO_AUTH_TOKEN"
      },
      "headers": {
        "x-user-id": "YOUR_USER_ID"
      }
    }
  }
}
```

Replace `YOUR_XANO_AUTH_TOKEN` and `YOUR_USER_ID` with your actual credentials.

When you open Claude a browser window should open and allow you to login. You should see the tools available in the bottom right. Given the right prompt Claude should ask to call the tool.

<div align="center">
  <img src="img/available-tools.png" alt="Clicking on the hammer icon shows a list of available tools" width="600"/>
</div>

<div align="center">
  <img src="img/claude-does-math-the-fancy-way.png" alt="Claude answers the prompt 'I seem to have lost my calculator and have run out of fingers. Could you use the math tool to add 23 and 19?' by invoking the MCP add tool" width="600"/>
</div>

## Xano Integration

This MCP server uses Xano as its backend for:

1. **Tool Management**: Define tools in Xano's `____mcp_tools` table and they will be automatically registered in the MCP server
2. **Session Tracking**: All MCP sessions are tracked in the `___mcp_sessions` table with unique session IDs
3. **OAuth Authentication**: OAuth tokens and states are stored in Xano's `___oauth_tokens` and `___oauth_states` tables
4. **Logging**: All MCP requests are logged in the `___mcp_logs` table

## Streamable HTTP Implementation

This server implements the latest Model Context Protocol Streamable HTTP transport (2024-11-05) with the following features:

### Authentication Methods

The server supports multiple authentication mechanisms for maximum compatibility:

1. **URL Parameters**: `?auth_token=xxx&user_id=yyy` (legacy method)
2. **Authorization Header**: `Authorization: Bearer xxx` with `x-user-id` header (modern method)
3. **Request Body**: Auth parameters can be included in the initialization payload

### Session Management

The server handles session IDs according to the latest spec:

1. **Session Creation**: The server generates a unique session ID for new connections
2. **Session Tracking**: Clients store this ID and include it in future requests as `?sessionId=xxx`
3. **State Persistence**: Each session maintains its own state in Xano, which persists across requests

### Protocol Compliance

The implementation includes proper support for:

1. **Unified Message Endpoint**: Support for the `/mcp/message` endpoint pattern
2. **Protocol Headers**: All responses include proper headers like `MCP-Available-Transports`
3. **SSE Streaming**: Enhanced SSE support for streaming responses
4. **Response Format**: Standard JSON-RPC 2.0 format with protocol-specific extensions

### Setting up Xano

1. Create a Xano project with the required tables (see database schema)
2. Create API endpoints for:
   - `/api/tools` - GET - List all tools
   - `/api/tools/execute/{tool_name}` - POST - Execute a specific tool
   - `/api/sessions` - POST - Create a new session
   - `/api/sessions/update-activity` - PUT - Update session activity
   - `/api/oauth/tokens` - POST - Store OAuth tokens
   - `/api/oauth/tokens/{user_id}/{provider}` - GET - Get OAuth tokens
   - `/api/oauth/states` - POST - Store OAuth states
   - `/api/oauth/states/{state}` - GET - Validate OAuth states
   - `/api/logs` - POST - Log MCP requests

## Deploy to Cloudflare

1. Create the Durable Object binding:
   ```bash
   # Only once per account
   npx wrangler d1 create SHARE_DO
   ```
2. Create `wrangler.toml` (see below) with the binding + vars:
   ```toml
   name = "remote-mcp-server"
   main = "./dist/index.js"

   [[durable_objects]]
   name = "SHARE_DO"
   class_name = "ShareDo"

   [vars]
   XANO_BASE_URL = "https://x8kd-12345.xano.dev/api" # update
   
   [dev]
   port = 8787
   ```
3. Deploy:
   ```bash
   npm run deploy  # wrangler deploy
   ```
4. Push to GitHub:
   ```bash
   git add .
   git commit -m "feat: share-link flow + durable object"
   git push origin main
   ```

## Connect Claude Desktop to your remote MCP server

Update the Claude configuration file to point to your `workers.dev` URL (ex: `worker-name.account-name.workers.dev/sse`) and restart Claude 

```json
{
  "mcpServers": {
    "math": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://worker-name.account-name.workers.dev/sse"
      ]
    }
  }
}
```

## Debugging

Should anything go wrong it can be helpful to restart Claude, or to try connecting directly to your
MCP server on the command line with the following command.

```bash
npx mcp-remote http://localhost:8787/sse
```

In some rare cases it may help to clear the files added to `~/.mcp-auth`

```bash
rm -rf ~/.mcp-auth
