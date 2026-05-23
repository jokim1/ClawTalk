const GOOGLE_SCOPE_URL_BY_ALIAS: Record<string, string> = {
  'drive.readonly': 'https://www.googleapis.com/auth/drive.readonly',
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  documents: 'https://www.googleapis.com/auth/documents',
  'documents.readonly': 'https://www.googleapis.com/auth/documents.readonly',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  'spreadsheets.readonly':
    'https://www.googleapis.com/auth/spreadsheets.readonly',
};

const GOOGLE_SCOPE_ALIAS_BY_URL = Object.fromEntries(
  Object.entries(GOOGLE_SCOPE_URL_BY_ALIAS).map(([alias, url]) => [url, alias]),
);

export function expandGoogleScopeAliases(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .map((scope) => GOOGLE_SCOPE_URL_BY_ALIAS[scope] || scope)
        .filter(Boolean),
    ),
  );
}

export function normalizeGoogleScopeAliases(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .map((scope) => GOOGLE_SCOPE_ALIAS_BY_URL[scope] || scope)
        .filter(Boolean),
    ),
  ).sort();
}

// Google scope hierarchy: granting a parent scope at consent implicitly
// grants its readonly child. The OAuth response only echoes back the parent
// alias, not the child — so a user who consented to `spreadsheets` for
// writes would otherwise fail a scope check that requires
// `spreadsheets.readonly` for a read tool. `expandImpliedScopes` widens a
// set of granted aliases to include the implied children so the scope
// assertion in google-tools-service.ts can compare apples to apples.
//
// Only the documents + spreadsheets hierarchies are listed because those
// are the only parent+child alias pairs we expose. `drive.readonly` has no
// `drive` parent in our alias map; `gmail.send` and `gmail.readonly` are
// siblings, not parent/child.
const GOOGLE_SCOPE_IMPLIES: Record<string, ReadonlyArray<string>> = {
  documents: ['documents.readonly'],
  spreadsheets: ['spreadsheets.readonly'],
};

export function expandImpliedScopes(aliases: string[]): string[] {
  const expanded = new Set<string>(aliases);
  for (const alias of aliases) {
    const implied = GOOGLE_SCOPE_IMPLIES[alias];
    if (implied) {
      for (const child of implied) expanded.add(child);
    }
  }
  return Array.from(expanded).sort();
}
