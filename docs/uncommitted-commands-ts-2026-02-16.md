# Uncommitted Changes: `src/tui/commands.ts`

**Date:** 2026-02-16

## Summary

Adds Slack scope validation and normalization to the `/platform` slash command. Previously, any freeform text was accepted as a scope for all platforms. Now, when the platform is `slack`, the scope is validated against known formats and normalized to a canonical form before being stored.

---

## New: `normalizeSlackScope()` (lines 60–79)

A helper function that validates and normalizes Slack scope strings. Returns the canonical form or `null` if invalid.

### Accepted Formats

| Input | Normalized Output |
|-------|-------------------|
| `*`, `all`, `slack:*` | `slack:*` |
| `channel:c12345678` | `channel:C12345678` |
| `slack:channel:c12345678` | `channel:C12345678` |
| `user:u12345678` | `user:U12345678` |
| `slack:user:u12345678` | `user:U12345678` |
| *(anything else)* | `null` (invalid) |

- All matching is case-insensitive
- Channel/user IDs are uppercased in the output
- The `slack:` prefix is optional and stripped from channel/user scopes

---

## Modified: `handlePlatformCommand()` (lines 404–443)

### Before

```typescript
const platform = parts[0];
const scope = parts.slice(1, -1).join(' ');
ctx.addPlatformBinding(platform, scope, permission);
```

All platforms accepted any scope string verbatim.

### After

```typescript
const platform = parts[0].trim().toLowerCase();
const rawScope = parts.slice(1, -1).join(' ');
if (platform === 'slack') {
  const normalizedScope = normalizeSlackScope(rawScope);
  if (!normalizedScope) {
    ctx.addSystemMessage(
      'Invalid Slack scope. Use channel:<ID>, user:<ID>, or slack:* ...',
    );
    return { handled: true };
  }
  ctx.addPlatformBinding(platform, normalizedScope, permission);
  return { handled: true };
}
ctx.addPlatformBinding(platform, rawScope, permission);
```

- Platform name is now trimmed and lowercased
- Slack scopes are validated — invalid scopes show an error message instead of being silently accepted
- Non-Slack platforms continue to accept freeform scopes

---

## Modified: `getCommandCompletions()` (line 566)

Updated the `/platform` completion hint description:

| Before | After |
|--------|-------|
| `Add binding (read, write, read+write)` | `Add binding (Slack: channel:<id>, user:<id>, or slack:*)` |

---

## Motivation

Without validation, users could enter malformed Slack scopes (e.g. `#general`, `team-product`) that wouldn't match anything on the gateway side. This change catches errors at input time and normalizes IDs to uppercase for consistent matching.
