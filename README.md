# llm-gate

A TypeScript MCP server that exposes the built-in Pi Coding Agent tools over Streamable HTTP. A built-in OAuth server grants access after confirmation in the local terminal. No external sign-in provider or user password is required.

## Getting started

Requires Node.js 22.19 or newer.

```sh
npm ci
npm run build
npm start
```

MCP endpoint: `http://127.0.0.1:3000/mcp`. It requires an OAuth Bearer token, including for the initialization request. Availability check without authorization: `GET http://127.0.0.1:3000/health`.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | HTTP port; `0` picks a free port |
| `MCP_CWD` | Current directory | Working directory for the tools |
| `MCP_PUBLIC_URL` | Local listener address | External HTTPS origin used for OAuth discovery, callback continuation, and token binding; a trailing `/mcp` is allowed |
| `MCP_STATE_DIR` | `%LOCALAPPDATA%\llm-gate` on Windows; `$XDG_STATE_HOME/llm-gate` or `~/.local/state/llm-gate` on Linux/macOS | OAuth storage; must be outside any shared directory |
| `MCP_ALLOWED_HOSTS` | SDK's localhost check | Comma-separated list of allowed Host names; for a reverse proxy or tunnel, add its domain |
| `MCP_ALLOWED_ORIGINS` | Same HTTP origin only | Comma-separated list of additional browser origins, for example `http://localhost:6274` for MCP Inspector |

PowerShell example:

```powershell
$env:MCP_CWD = 'C:\Projects\example'
$env:PORT = '3000'
npm start
```

## Connecting through ngrok

Start the tunnel first:

```sh
ngrok http 3000
```

Set the issued HTTPS URL and start the server in another PowerShell window:

```powershell
$env:MCP_PUBLIC_URL = 'https://YOUR-DOMAIN.ngrok-free.app'
npm run build
npm start
```

The `MCP_PUBLIC_URL` domain is automatically added to the allowed Hosts alongside localhost. If the server is already running, stop it with Ctrl+C and start it again in the same window where the variable is set. The public URL is read when the process starts. Changing the URL or `MCP_CWD` resets the saved OAuth connections and registrations: you will need to confirm them again. To keep connections, use a stable external URL.

In ChatGPT, enter `https://YOUR-DOMAIN.ngrok-free.app/mcp` and choose OAuth. If the client supports dynamic registration, the Client ID / Client Secret fields can be left empty. If the client requires static credentials, use the local `register` command described below. Public client registration does not by itself grant access.

A `403` response with the message `Invalid Host: ...` means the Host check failed, which a client may display as an authentication problem. If the response body contains `Origin is not allowed`, add the client's actual Origin to `MCP_ALLOWED_ORIGINS`. The `X-Forwarded-Host` and `X-Forwarded-Proto` headers do not, on their own, allow an external Host or Origin.

## OAuth and local confirmation

The client discovers the OAuth endpoints, registers, and starts the Authorization Code flow with PKCE S256. The browser opens a waiting page tied to an HttpOnly/SameSite cookie. The page has no button that grants access, and there is no public confirmation endpoint either.

The terminal of the running `llm-gate` shows the request ID, the name the client claims, the Client ID, the exact callback URL, and the requested permissions. Check the callback against the client's settings, and confirm only a connection that you started yourself: the client name is supplied by the client and does not prove its authenticity.

```text
pending
approve <request-id>
approve <request-id> files:read
deny <request-id>
connections
revoke <connection-id>
help
```

`approve` without a list of scopes grants all requested scopes. You can choose a subset, comma-separated, for example `files:read,files:write`. You cannot add a scope that was not requested. No token is issued without local confirmation; a request waits for at most 5 minutes. A closed stdin does not automatically confirm requests.

| Scope | Tools |
| --- | --- |
| `files:read` | `read`, `ls`, `find`, `grep` |
| `files:write` | `write`, `edit` |
| `commands:execute` | The shell of the current OS |

`tools/list` shows only the tools allowed by the token. Every MCP request checks the token and the required scopes; MCP sessions are bound to a specific confirmed connection.

After confirmation, the browser passes the client a one-time code that is valid for 60 seconds. The client exchanges it, with PKCE verification, for an access token valid for about 15 minutes and a refresh token. The grant is valid for 30 days from the moment of confirmation. The refresh token is rotated on every exchange; reusing an old refresh token revokes the entire connection. `revoke` immediately blocks new requests and closes the active MCP sessions of that connection. The standard `/revoke` endpoint is also supported.

For a client that requires a static Client ID / Client Secret, copy the exact redirect URI from its settings and enter the following in the local terminal:

```text
register https://client.example/callback My client
```

The secret is shown only once. Public clients with PKCE (`none`), `client_secret_post`, and `client_secret_basic` are supported. OAuth metadata is published at `/.well-known/oauth-authorization-server`, and protected resource metadata at `/.well-known/oauth-protected-resource/mcp` and the root alias. The service endpoints are rate-limited. The limits use the real socket address; behind ngrok they are shared across the tunnel, and a client-supplied `X-Forwarded-For` is not trusted.

`MCP_STATE_DIR` holds `oauth.json`: registrations, grants, expiry times, and hashes of client secrets and tokens. The original tokens are neither stored nor printed to the terminal. One-time codes and pending confirmations exist only in memory. The state is written atomically; a second process using the same directory does not start OAuth, and corrupted state is not accepted. Keep the directory to preserve connections across restarts; deleting it resets the connections. Access to the directory must remain with the application owner.

## Built-in tools

| Tool | Purpose | Platforms |
| --- | --- | --- |
| `read` | Read files, including images | All |
| `write` | Write files and create parent directories | All |
| `edit` | Targeted text replacements | All |
| `ls` | Directory contents | All |
| `find` | Find files by glob | All |
| `grep` | Search file contents | All |
| `powershell` | Run PowerShell commands | Windows |
| `bash` | Run Bash commands | Linux/macOS |

The platform is determined via `process.platform` when the tool catalog is created. The server publishes seven tools; the shell that does not fit the platform is absent from both `tools/list` and the call registry.

`find` uses `fd` and `grep` uses `rg`. Pi looks for them in PATH and in its own binaries directory; if they are missing, it may download them automatically. To work offline, install these utilities in advance; `PI_OFFLINE=1` disables Pi's automatic download. On Windows the installed PowerShell is used; on Linux/macOS, Bash is required.

The tools run with the privileges of the server process. `MCP_CWD` sets the working directory but does not restrict access to the file system. OAuth controls the connection and the set of tools; it does not replace an OS sandbox. In particular, `commands:execute` lets the shell read and modify anything the process can access, regardless of the file scopes. An OS sandbox is not implemented in this version.

## Connecting an MCP client

```json
{
  "mcpServers": {
    "llm-gate": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

The names of the configuration fields depend on the client. Streamable HTTP is used, not the deprecated standalone SSE endpoint.

The server supports MCP initialization, independent HTTP sessions, and session termination via `DELETE /mcp`. Subsequent requests pass the received `Mcp-Session-Id`; an SDK client does this automatically. Cancellation of an MCP request is passed to the tool through an `AbortSignal`; stopping the server closes the sessions and cancels active operations.

Pi schemas are passed through as JSON Schema without manual rewriting and are validated before execution. The low-level MCP SDK `Server` is used so that the TypeBox schemas are preserved directly. Argument errors are returned as protocol errors; execution errors are returned as a result with `isError: true`, including Pi errors returned without an exception. Text and images are kept in `content`, Pi's machine-readable result in `structuredContent`, and additional Pi data in `structuredContent.details`. The catalog carries MCP annotations for read and modify operations.

## Client compatibility

Verified on October 26, 2026.

| Client | Verification result |
| --- | --- |
| Claude Code 2.1.272 | Real connection to the HTTP server with a Bearer token issued after OAuth confirmation: `claude mcp get` returned `Connected`; the temporary configuration was removed |
| MCP TypeScript SDK 1.32.2 | Full OAuth flow: discovery, dynamic registration, PKCE, local confirmation, token exchange, and HTTP calls in Jest |
| ChatGPT desktop / Codex host | According to the official documentation, they support direct Streamable HTTP connections; a connection from the ChatGPT interface was not performed |
| ChatGPT web | Supports Streamable HTTP through a custom MCP server/plugin; requires a reachable HTTPS endpoint or Secure MCP Tunnel, an account, and the relevant permissions; a cloud connection was not performed |

The Claude Code check confirms that an MCP connection is established. Tool calls and the full OAuth flow were verified separately through the MCP SDK; no request was sent to a Claude model. Interactive OAuth sign-in from ChatGPT/Claude was not tested in an account. Compatibility with these interfaces is inferred from their documented transport and OAuth support.

Connecting Claude Code:

```sh
claude mcp add --transport http llm-gate http://127.0.0.1:3000/mcp
claude mcp login llm-gate
claude mcp get llm-gate
```

Codex host configuration:

```toml
[mcp_servers.llm_gate]
url = "http://127.0.0.1:3000/mcp"
```

For ChatGPT web, add a custom MCP server with the HTTPS URL `/mcp` and choose OAuth. Set `MCP_PUBLIC_URL` to the external HTTPS origin. For a browser client, add its origin to `MCP_ALLOWED_ORIGINS` if necessary. CORS preflight, OAuth discovery, and session header passing are supported. There is no mode for accessing MCP without authentication.

Jest verifies negotiation of the protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25`. Separate `search`/`fetch` tools are not implemented: the server is intended for ordinary tool calls, not for the company knowledge mode.

Official sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [ChatGPT custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server), [ChatGPT: endpoint requirements](https://developers.openai.com/plugins/deploy/connect-chatgpt), [ChatGPT desktop / Codex MCP](https://learn.chatgpt.com/docs/extend/mcp).

## Structure

```text
src/
  config.ts
  index.ts
  auth/
    clients.ts
    provider.ts
    router.ts
    scopes.ts
    secrets.ts
    store.ts
    terminal.ts
  http/server.ts
  mcp/server.ts
  tools/adapter.ts
  tools/catalog.ts
tests/
  config.test.js
  auth/oauth.test.js
  auth/store.test.js
  auth/terminal.test.js
  http/server.test.js
  tools/adapter.test.js
  tools/catalog.test.js
```

## Testing

```sh
npm test
npm run test:coverage
```

Jest first builds the TypeScript, then runs tests against the built ESM modules. The integration tests use a real HTTP server, an MCP SDK client, a temporary directory, and the built-in Pi operations. Shell selection for Windows, Linux, and macOS is verified separately.