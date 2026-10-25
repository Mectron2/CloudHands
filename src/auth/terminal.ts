import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { LocalOAuthProvider, type PendingApproval } from './provider.js';
import { secret } from './secrets.js';

const help = 'Commands: pending | approve <id> [scope1,scope2] | deny <id> | connections | revoke <id> | register <redirect-uri> [name] | help\n';

export function attachTerminal(provider: LocalOAuthProvider, input: Readable = process.stdin, output: Writable = process.stdout) {
  const terminal = createInterface({ input, output, terminal: false });
  const showPending = (request: PendingApproval) => {
    output.write(`\nOAuth approval ${request.id}\nClient name (self-reported): ${JSON.stringify(request.clientName)}\nClient ID: ${JSON.stringify(request.clientId)}\nCallback: ${JSON.stringify(request.redirectUri)}\nScopes: ${request.scopes.join(', ')}\nApprove only the connection you initiated: approve ${request.id}\nReject: deny ${request.id}\n`);
  };
  const unsubscribe = provider.onPending(showPending);
  output.write(help);

  terminal.on('line', (line) => {
    const [command, id, ...args] = line.trim().split(/\s+/);
    try {
      switch (command) {
        case '': break;
        case 'help': output.write(help); break;
        case 'pending': {
          const pending = provider.listPending();
          pending.forEach(showPending);
          if (!pending.length) {
            output.write('No pending requests\n');
          }
          break;
        }
        case 'approve': {
          if (!id) { throw new Error('Usage: approve <id> [scope1,scope2]'); }
          const grantId = provider.approve(id, args.length ? args.join(' ').split(',').map((scope) => scope.trim()) : undefined);
          output.write(`Approved. Connection: ${grantId}\n`);
          break;
        }
        case 'deny': {
          if (!id) { throw new Error('Usage: deny <id>'); }
          provider.deny(id);
          output.write('Denied\n');
          break;
        }
        case 'connections': {
          for (const connection of provider.listConnections()) {
            output.write(`${connection.id} ${JSON.stringify(connection.clientName)} ${connection.revoked ? 'revoked' : connection.expiresAt <= Date.now() / 1000 ? 'expired' : 'active'} ${connection.scopes.join(', ')}\n`);
          }
          break;
        }
        case 'revoke': {
          if (!id) { throw new Error('Usage: revoke <connection-id>'); }
          provider.revokeConnection(id);
          output.write('Revoked\n');
          break;
        }
        case 'register': {
          if (!id) { throw new Error('Usage: register <redirect-uri> [name]'); }
          const client = provider.clientsStore.registerClient({
            redirect_uris: [id], client_name: args.join(' ') || 'Manual client',
            token_endpoint_auth_method: 'client_secret_post', client_secret: secret(),
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          });
          output.write(`Client ID: ${client.client_id}\nClient Secret (shown once): ${client.client_secret}\n`);
          break;
        }
        default: output.write(help);
      }
    } catch (error) {
      output.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  return () => {
    unsubscribe();
    terminal.close();
  };
}
