export const SCOPES = ['files:read', 'files:write', 'commands:execute'] as const;
export type Scope = typeof SCOPES[number];

export function toolScope(name: string): Scope {
  if (['read', 'ls', 'find', 'grep'].includes(name)) {
    return 'files:read';
  }
  return ['write', 'edit'].includes(name) ? 'files:write' : 'commands:execute';
}
