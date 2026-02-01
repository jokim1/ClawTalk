/**
 * Terminal window spawning utility
 *
 * Spawns a new terminal window running a fresh RemoteClaw instance,
 * inheriting gateway config but starting with a fresh session context.
 */

import { spawn } from 'child_process';
import { writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RemoteClawOptions } from '../types.js';

/**
 * Build the CLI command string to launch a new RemoteClaw instance.
 * Inherits gateway config and model but omits --session (fresh context).
 * Token is passed via env var (REMOTECLAW_GATEWAY_TOKEN) to avoid leaking
 * it in process lists and shell history.
 */
function buildCommand(options: RemoteClawOptions): { command: string; env: Record<string, string> } {
  const argv = process.argv;
  let executable: string;

  if (argv[0] && argv[1] && (argv[1].endsWith('.js') || argv[1].endsWith('.ts'))) {
    executable = `${shellEscape(argv[0])} ${shellEscape(argv[1])}`;
  } else {
    executable = shellEscape(argv[1] ?? argv[0]);
  }

  const args: string[] = [];
  const env: Record<string, string> = {};

  if (options.gatewayUrl) {
    args.push(`-g ${shellEscape(options.gatewayUrl)}`);
  }
  if (options.gatewayToken) {
    env.REMOTECLAW_GATEWAY_TOKEN = options.gatewayToken;
  }
  if (options.model) {
    args.push(`-m ${shellEscape(options.model)}`);
  }

  const command = args.length > 0 ? `${executable} ${args.join(' ')}` : executable;
  return { command, env };
}

/** Escape a string for safe use in a shell command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build an env export prefix for shell scripts (e.g. "export KEY='value' && ").
 * Returns empty string if no env vars to set.
 */
function buildEnvPrefix(env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
    .join(' && ');
  return exports ? `${exports} && ` : '';
}

/**
 * Spawn a new terminal window running a fresh RemoteClaw instance.
 *
 * Detects the current terminal emulator and uses the appropriate method
 * to open a new window.
 */
export function spawnNewTerminalWindow(options: RemoteClawOptions): void {
  const { command, env } = buildCommand(options);
  const fullCommand = `${buildEnvPrefix(env)}${command}`;
  const termProgram = process.env.TERM_PROGRAM ?? '';

  if (termProgram === 'Apple_Terminal') {
    spawn('osascript', [
      '-e',
      `tell application "Terminal" to do script "${escapeAppleScript(fullCommand)}"`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') {
    spawn('osascript', [
      '-e',
      `tell application "iTerm2" to create window with default profile command "${escapeAppleScript(fullCommand)}"`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const scriptPath = join(tmpdir(), `remoteclaw-launch-${Date.now()}.sh`);
    writeFileSync(scriptPath, `#!/bin/bash\n${fullCommand}\nrm -f ${shellEscape(scriptPath)}\n`);
    chmodSync(scriptPath, 0o755);
    spawn('open', ['-a', 'Terminal.app', scriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

/** Escape a string for embedding inside AppleScript double quotes. */
function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
