# ☁️ CloudHands

### Your favorite web chat. Your local workspace. Connected.

CloudHands is a **self-hosted, open-source bridge between LLM web chats and your computer**. The idea is simple: use the free web chats offered by model providers, and give the LLM tools to work with your local files and terminal through MCP.

Run CloudHands on your machine, connect a web chat that supports external MCP servers, and approve access in your terminal. The chat becomes a practical helper for reading code, editing files, searching projects, and running commands.

**Your machine hosts the tools. You approve connections. You choose permissions.**

[Quick start](#quick-start) · [Tools](#available-tools) · [Remote access](#connect-a-web-chat-remotely) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

## Why CloudHands?

- **Bring the web chat you already use.** Connect a compatible provider-hosted chat to your local workspace, without a separate model API key in CloudHands.
- **Self-host the bridge.** Run the server yourself and keep its configuration and access controls on your machine.
- **Approve connections locally.** Built-in OAuth asks for confirmation in your terminal, without an external identity provider or application password.
- **Choose the permissions.** Allow file reading, file writing, shell execution, or a subset of the permissions requested by the client.
- **Work across platforms.** Use PowerShell on Windows and Bash on Linux or macOS.

CloudHands provides tools, not model inference. The LLM still runs with your chat provider, and tool results are sent to the connected client. A provider's free chat must support external MCP connections for this to work; availability depends on the client and account.

## How it works

```text
Web chat / MCP client
        │
        │ Streamable HTTP + OAuth
        ▼
CloudHands on your computer  ◄── You approve access in the terminal
        │
        ├── Read, search, and edit files
        └── Run PowerShell or Bash commands
```

For a remotely hosted web chat, expose CloudHands through a reachable HTTPS endpoint, such as a tunnel. Local MCP clients can connect directly to localhost.

## Quick start

You need **Node.js 22.19+**, npm, and a client that supports **Streamable HTTP and OAuth**.

### 1. Install and build

From the project directory:

```sh
npm ci
npm run build
```

### 2. Choose a workspace and start

**Windows / PowerShell:**

```powershell
$env:MCP_CWD = 'C:\Projects\my-app'
npm start
```

**Linux / macOS:**

```sh
MCP_CWD="$HOME/projects/my-app" npm start
```

Or run `npm start` without `MCP_CWD` to use the current directory. Keep this terminal open: it is where you approve connections.

### 3. Connect your client

| Setting | Value |
| --- | --- |
| Name | `CloudHands` |
| Transport | Streamable HTTP |
| Local endpoint | `http://127.0.0.1:3000/mcp` |
| Authentication | OAuth |

For a web chat hosted by a provider, follow [Connect a web chat remotely](#connect-a-web-chat-remotely) and use the public HTTPS endpoint instead of localhost.

Start the client's OAuth flow. Clients with dynamic registration do not need a preconfigured Client ID or Client Secret.

### 4. Approve and try it

CloudHands prints the request ID, client details, callback URL, and requested permissions. Check them, then enter this in the **running CloudHands terminal**:

```text
approve <request-id>
```

Replace `<request-id>` with the displayed ID. To grant only file reading when requested, enter `approve <request-id> files:read`. The browser continues automatically after approval.

Try asking your connected chat:

> List the files in my workspace, read the README, and explain how the project is organized.

**Health check:** `http://127.0.0.1:3000/health` returns `{"status":"ok"}` when available. Opening `/mcp` without an OAuth token returns `401`, including during initialization.

## Available tools

Built on the Pi Coding Agent tools, CloudHands exposes six file tools and one platform-specific shell:

| Tool | What it does | Permission |
| --- | --- | --- |
| `read` | Read files, including images | `files:read` |
| `ls` | List directory contents | `files:read` |
| `find` | Find files by glob | `files:read` |
| `grep` | Search file contents | `files:read` |
| `write` | Write files and create parent directories | `files:write` |
| `edit` | Make targeted text replacements | `files:write` |
| `powershell` / `bash` | Run commands in the platform's shell | `commands:execute` |

Clients only see the tools allowed by their token.

`find` uses `fd`, and `grep` uses `rg`. Pi looks for them in PATH and its own binaries directory, and may download them if missing. For offline use, install both in advance and set `PI_OFFLINE=1` to disable automatic downloads. Windows needs PowerShell; Linux and macOS need Bash.

> **Know what you grant:** Tools run with the server process's privileges. `MCP_CWD` selects a working directory; it does not sandbox the filesystem. Shell access can read or change anything the process can access, regardless of file scopes. Grant it only to clients you trust.

## Connect a web chat remotely

With ngrok installed, start a tunnel:

```sh
ngrok http 3000
```

Then set the issued HTTPS origin and start CloudHands in another terminal.

**Windows / PowerShell:**

```powershell
$env:MCP_PUBLIC_URL = 'https://YOUR-DOMAIN.ngrok-free.app'
$env:MCP_CWD = 'C:\Projects\my-app'
npm start
```

**Linux / macOS:**

```sh
MCP_PUBLIC_URL='https://YOUR-DOMAIN.ngrok-free.app' MCP_CWD="$HOME/projects/my-app" npm start
```

In the chat's external MCP server settings, enter `https://YOUR-DOMAIN.ngrok-free.app/mcp` and select OAuth. Approve the request in your CloudHands terminal. The public URL's hostname is automatically allowed alongside localhost.

If CloudHands is already running, stop it with **Ctrl+C** and restart it with the new environment variables. Changing the public origin or working directory resets saved OAuth registrations and connections, so clients must reconnect and be approved again. Use a stable public URL to preserve connections across restarts.

### Client configuration example

For clients that accept an `mcpServers` configuration, this illustrates the settings:

```json
{
  "mcpServers": {
    "cloudhands": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Field names vary by client. Use its Streamable HTTP transport and OAuth flow. CloudHands has no unauthenticated MCP mode or separate legacy SSE endpoint.

If a client requires a static Client ID and Client Secret, copy its exact redirect URI and enter this in the running CloudHands terminal:

```text
register https://client.example/callback My client
```

Save the returned secret; it is shown only once. Registration alone does not grant access: you still approve the connection locally.

## Manage access

Enter these commands in the terminal running CloudHands:

| Command | Action |
| --- | --- |
| `pending` | List requests awaiting approval |
| `approve <request-id>` | Grant all requested permissions |
| `approve <request-id> files:read,files:write` | Grant a subset of requested permissions |
| `deny <request-id>` | Reject a request |
| `connections` | List connections and their status |
| `revoke <connection-id>` | Revoke access and close its active MCP sessions |
| `register <redirect-uri> [name]` | Create credentials for a client requiring a static secret |
| `help` | Show available commands |

Only approve connections you initiated. The client name is self-reported; verify the callback URL against your client's settings. Requests expire after five minutes. Approval cannot add permissions that the client did not request.

<details>
<summary><strong>OAuth and saved connections</strong></summary>

- Authorization Code flow uses PKCE S256. The waiting page is bound to an HttpOnly/SameSite cookie and cannot grant access. There is no public approval endpoint; closed stdin never approves requests automatically.
- One-time codes expire after 60 seconds. Access tokens last about 15 minutes; grants last 30 days from approval.
- Refresh tokens rotate on every exchange. Reusing an old refresh token revokes the entire connection.
- Every MCP request checks its token and required scopes. Sessions belong to a specific approved connection. The standard `/revoke` endpoint is supported.
- Public PKCE clients (`none`), `client_secret_post`, and `client_secret_basic` are supported.
- OAuth discovery is at `/.well-known/oauth-authorization-server`; resource metadata is at `/.well-known/oauth-protected-resource/mcp` and its root alias.
- OAuth endpoints are rate-limited using the real socket address. Behind a tunnel, clients share those limits; client-supplied `X-Forwarded-For` is not trusted.
- `MCP_STATE_DIR/oauth.json` stores registrations, grants, expiry times, and hashes of secrets and tokens. Original tokens are neither stored nor printed. Pending requests and one-time codes stay in memory.
- State is written atomically. A second process cannot use the same state directory, and corrupted state is rejected. Keep the directory private and outside the shared workspace; deleting it resets connections.

</details>

## Configuration

Set environment variables before starting CloudHands.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | HTTP port; `0` chooses a free port |
| `MCP_CWD` | Current directory | Working directory for tools |
| `MCP_PUBLIC_URL` | Local listener origin | External HTTPS origin for OAuth discovery and token binding; a trailing `/mcp` is accepted |
| `MCP_STATE_DIR` | Platform state directory below | Private OAuth storage; must be outside `MCP_CWD` |
| `MCP_ALLOWED_HOSTS` | SDK localhost check | Comma-separated allowed hostnames; the public URL hostname is added automatically when configured |
| `MCP_ALLOWED_ORIGINS` | Same HTTP origin and configured public origin | Comma-separated additional browser origins, such as `http://localhost:6274` |

Default state directories:

- **Windows:** `%LOCALAPPDATA%\cloudhands` (falls back to `~/AppData/Local/cloudhands`).
- **Linux / macOS:** `$XDG_STATE_HOME/cloudhands`, or `~/.local/state/cloudhands` when unset.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The web chat has no external MCP option | Use a client or account that supports external MCP servers, Streamable HTTP, and OAuth. |
| `401` from `/mcp` | Complete OAuth and approve locally. MCP requests require a Bearer token; use `/health` for an unauthenticated availability check. |
| `403` with `Invalid Host: ...` | Set `MCP_PUBLIC_URL` to your tunnel's HTTPS origin, or add the hostname to `MCP_ALLOWED_HOSTS`, then restart. |
| `403` with `Origin is not allowed` | Add the client's actual browser origin to `MCP_ALLOWED_ORIGINS` and restart. |
| Browser is waiting for approval | Enter `pending` in the server terminal and approve the matching request. Restart sign-in if it expired. |
| A tool is missing | Check the connection's scopes. Only one shell is exposed for your platform. |
| `MCP_STATE_DIR must be outside MCP_CWD` | Choose a private state directory outside the workspace shared with tools. |
| Another process is using `MCP_STATE_DIR` | Stop the other CloudHands instance or choose a different private state directory. |
| Connections reset after restarting | Keep the same state directory, public origin, and working directory. |
| `find` or `grep` fails offline | Install `fd` and `rg` in advance and ensure they are available to Pi. |

Forwarded headers such as `X-Forwarded-Host` and `X-Forwarded-Proto` do not automatically authorize a Host or Origin.

## Development

```sh
npm run build          # Compile TypeScript into dist/
npm test               # Build and run Jest
npm run test:coverage  # Run tests with coverage
```

Tests exercise real HTTP servers, MCP SDK clients, OAuth flows, temporary workspaces, and Pi tool operations. Shell selection is checked for Windows, Linux, and macOS. Protocol negotiation is covered for `2025-03-26`, `2025-06-18`, and `2025-11-25`.

Client compatibility depends on its transport, OAuth support, and configuration. Automated SDK tests do not establish that an interactive sign-in works in every client interface.

<details>
<summary><strong>Project structure and protocol details</strong></summary>

```text
src/
  index.ts          # Startup and shutdown
  config.ts         # Environment configuration
  auth/             # OAuth, state storage, scopes, terminal approval
  http/server.ts    # HTTP routing, sessions, host and origin checks
  mcp/server.ts     # MCP requests and permission filtering
  tools/            # Pi tool catalog and MCP adapter
tests/
  auth/             # OAuth flows, storage, terminal commands
  http/             # HTTP sessions and host validation
  tools/            # Tool schemas, adapter, platform selection
  config.test.js    # Configuration validation
  helpers/          # Shared OAuth test helpers
```

The server supports independent MCP sessions and termination through `DELETE /mcp`. Subsequent requests use `Mcp-Session-Id`; SDK clients handle this automatically. Cancellation reaches tools through an `AbortSignal`; shutdown closes sessions and cancels active operations.

Pi's TypeBox schemas pass through as JSON Schema and are validated before execution. Argument errors become protocol errors; execution failures return `isError: true`. Text and images remain in `content`, machine-readable results in `structuredContent`, and extra Pi data in `structuredContent.details`. Tools include MCP annotations for read and modify operations.

Separate `search` / `fetch` tools are not implemented. CloudHands exposes ordinary MCP tool calls.

</details>
