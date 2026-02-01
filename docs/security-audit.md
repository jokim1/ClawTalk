# RemoteClaw Security Vulnerability Audit

**Date:** 2026-01-31
**Audited by:** Claude Opus 4.5
**Files audited:** All 17 source files in src/

---

## Vulnerability Summary

| ID | Severity | File | Line(s) | Category | Description | Status |
|---|---|---|---|---|---|---|
| VULN-01 | **HIGH** | `services/terminal.ts` | 62-70, 84-86 | Command Injection | Incomplete AppleScript escaping (missing newline escape) | FIXED |
| VULN-02 | **HIGH** | `services/terminal.ts` | 25-29, 73-74 | Command Injection | Unescaped `process.argv` in shell script generation | FIXED |
| VULN-03 | **MEDIUM** | `services/terminal.ts` | 36-38 | Credential Exposure | Token visible in process list and shell history | FIXED |
| VULN-04 | **MEDIUM** | `services/chat.ts`, `services/voice.ts` | multiple | SSRF | No URL validation on gateway URL | OPEN |
| VULN-05 | **MEDIUM** | `config.ts` | 57-68 | Credential Storage | Plaintext secrets with silently-failing chmod; directory permissions not set | FIXED |
| VULN-08 | **MEDIUM** | `services/chat.ts` | 153-168 | Input Validation | ANSI escape sequence injection from gateway responses | OPEN |
| VULN-11 | **HIGH** | `config.ts` | 37 | Network Security | No warning for HTTP on non-localhost URLs | OPEN |
| VULN-13 | **MEDIUM** | `services/chat.ts` | 49-76, 104-131 | DoS | No timeout on main chat request methods | FIXED |
| VULN-14 | **MEDIUM** | `tui/utils.ts` | 69-87 | Path Traversal | Session name used in export filename without sanitization | FIXED |
| VULN-18 | **MEDIUM** | `services/chat.ts` | 78-81 | Info Disclosure | Full gateway error bodies exposed to user | OPEN |
| VULN-20 | **MEDIUM** | `tui/app.tsx`, `services/sessions.ts` | 90, 53-59 | DoS | Unbounded message accumulation in memory and requests | OPEN |
| VULN-09 | **LOW** | `services/chat.ts` | 78-101 | DoS | No size limit on non-streaming responses | OPEN |
| VULN-10 | **LOW** | `services/sessions.ts` | 31 | Path Traversal | Directory names read from disk used as paths | FIXED |
| VULN-15 | **LOW** | `services/sessions.ts` | 151-153 | Path Traversal | Recursive delete with disk-sourced session IDs | FIXED |
| VULN-16 | **LOW** | `package.json` | 22 | Dependencies | Outdated React 17 | OPEN |
| VULN-21 | **LOW** | `services/chat.ts` | 142-170 | DoS | Unbounded streaming buffer | OPEN |
| VULN-22 | **LOW** | `services/voice.ts` | 54, 121, 248 | Resource Leak | Orphaned temp files on crash | OPEN |
| VULN-24 | **LOW** | `services/sessions.ts`, `services/chat.ts` | 78, 46 | Weak Crypto | `Math.random()` for session identifiers | FIXED |

---

## Detailed Findings

### VULN-01: Command Injection via AppleScript in terminal.ts (HIGH)

**File:** `src/services/terminal.ts`, lines 62-70, 84-86

The `escapeAppleScript` function only escapes backslashes and double quotes:
```typescript
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
```

This is embedded into an `osascript -e` command. A crafted `gatewayUrl` containing newlines or AppleScript metacharacters could break out of the string context.

**Fix:** Also escape newline, carriage return, and tab characters. Consider passing the command as a script file rather than inline.

### VULN-02: Shell Script Injection in terminal.ts Fallback Path (HIGH)

**File:** `src/services/terminal.ts`, lines 25-29, 73-74

The fallback terminal-spawn path writes a shell script using `process.argv` without escaping:
```typescript
executable = `${argv[0]} ${argv[1]}`;
```

If the Node.js executable path contains shell metacharacters, command injection is possible.

**Fix:** Apply `shellEscape()` to `argv[0]` and `argv[1]`.

### VULN-03: Token Exposure via process.argv (MEDIUM)

**File:** `src/services/terminal.ts`, lines 36-38

When spawning a new terminal, the gateway token is passed as a CLI argument, visible in `ps aux`, shell history, and temp script files.

**Fix:** Propagate the token via environment variable instead.

### VULN-04: Unsanitized Gateway URL (MEDIUM)

**File:** `src/services/chat.ts`, `src/services/voice.ts` — multiple locations

The `gatewayUrl` from config is used directly in `fetch()` calls with no URL validation. A malicious config could redirect traffic including auth tokens.

**Fix:** Validate that `gatewayUrl` is an HTTP(S) URL.

### VULN-05: Plaintext Credentials with Incomplete Permissions (MEDIUM)

**File:** `src/config.ts`, lines 57-68

Credentials are stored in plaintext JSON. The `chmod 600` is good but:
- Failure is silently ignored
- The config directory isn't explicitly set to `700`

**Fix:** Also chmod the directory. Log a warning on chmod failure.

### VULN-08: ANSI Escape Sequence Injection (MEDIUM)

**File:** `src/services/chat.ts`, lines 153-168

A malicious gateway could inject terminal escape sequences into response content, potentially manipulating the terminal display.

**Fix:** Strip ANSI escape sequences from gateway responses before display and storage.

### VULN-11: Default Gateway URL Uses HTTP (HIGH)

**File:** `src/config.ts`, line 37

No warning when a non-localhost gateway URL uses HTTP. Traffic including auth tokens would be sent in plaintext.

**Fix:** Warn when a non-localhost HTTP URL is configured.

### VULN-13: No Timeout on Main Chat Requests (MEDIUM)

**File:** `src/services/chat.ts`, lines 49-76, 104-131

Neither `sendMessage` nor `streamMessage` apply `AbortSignal.timeout()`. A hanging gateway will freeze the UI indefinitely.

**Fix:** Apply a generous timeout (120-300s) to chat requests.

### VULN-14: Path Traversal in Transcript Export (MEDIUM)

**File:** `src/tui/utils.ts`, lines 69-87

Session name used in export filename with only whitespace sanitization. A name containing `../` could write files outside the home directory.

**Fix:** Strip path separators from the session name, or use `path.basename()`.

### VULN-18: Gateway Error Bodies Leaked to User (MEDIUM)

**File:** `src/services/chat.ts`, lines 78-81

Full error response bodies from the gateway are included in error messages displayed to the user.

**Fix:** Sanitize or limit gateway error detail shown to the user.

### VULN-20: Unbounded Message Accumulation (MEDIUM)

**File:** `src/tui/app.tsx`, `src/services/sessions.ts`

Messages grow without bound in memory and the full history is sent as context with each request.

**Fix:** Implement a maximum context window that truncates older messages.

### VULN-09: No Size Limit on Non-Streaming Responses (LOW)

**Fix:** Read response body with a size limit.

### VULN-10: Directory Names Read from Disk Used as Paths (LOW)

**Fix:** Validate directory names don't contain path separators.

### VULN-15: Recursive Delete with Disk-Sourced Session IDs (LOW)

**Fix:** Validate resolved path starts with `SESSIONS_DIR` before `rmSync`.

### VULN-16: React 17 is Outdated (LOW)

Constrained by `ink@3.x`. Consider upgrading when possible.

### VULN-21: Unbounded Streaming Buffer (LOW)

**Fix:** Add maximum buffer size check.

### VULN-22: Orphaned Temp Files on Crash (LOW)

**Fix:** Clean up stale temp files on startup.

### VULN-24: Weak Session ID Entropy (LOW)

**Fix:** Use `crypto.randomUUID()` for session keys sent to the gateway.

---

## Positive Security Findings

1. Config file permissions set to `chmod 600`
2. Tokens and API keys masked in CLI display
3. No `eval()` or dynamic code execution
4. Consistent timeout usage on most network calls
5. Minimal dependency footprint (4 production deps)
6. No HTML rendering (eliminates XSS)
7. TypeScript strict mode enabled
8. TLS certificate validation maintained by default
9. Bearer token auth used correctly with conditional inclusion
10. Anthropic API communication over HTTPS only
