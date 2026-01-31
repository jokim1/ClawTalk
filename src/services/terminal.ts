/**
 * Terminal window spawning utility
 *
 * Spawns a new terminal window running a fresh RemoteClaw instance,
 * inheriting gateway config but starting with a fresh session context.
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RemoteClawOptions } from '../types.js';

/**
 * Build the CLI command string to launch a new RemoteClaw instance.
 * Inherits gateway config and model but omits --session (fresh context).
 */
function buildCommand(options: RemoteClawOptions): string {
  // Resolve executable: handles both compiled binary and dev mode (node dist/cli.js)
  const argv = process.argv;
  let executable: string;

  if (argv[0] && argv[1] && (argv[1].endsWith('.js') || argv[1].endsWith('.ts'))) {
    // Dev mode: node dist/cli.js or tsx src/cli.ts
    executable = `${argv[0]} ${argv[1]}`;
  } else {
    // Binary mode: remoteclaw (argv[0] is the binary itself, or argv[1] is the command)
    executable = argv[1] ?? argv[0];
  }

  const args: string[] = [];

  if (options.gatewayUrl) {
    args.push(`-g ${shellEscape(options.gatewayUrl)}`);
  }
  if (options.gatewayToken) {
    args.push(`-t ${shellEscape(options.gatewayToken)}`);
  }
  if (options.model) {
    args.push(`-m ${shellEscape(options.model)}`);
  }

  return args.length > 0 ? `${executable} ${args.join(' ')}` : executable;
}

/** Escape a string for safe use in a shell command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Spawn a new terminal window running a fresh RemoteClaw instance.
 *
 * Detects the current terminal emulator and uses the appropriate method
 * to open a new window.
 */
export function spawnNewTerminalWindow(options: RemoteClawOptions): void {
  const command = buildCommand(options);
  const termProgram = process.env.TERM_PROGRAM ?? '';

  if (termProgram === 'Apple_Terminal') {
    spawn('osascript', [
      '-e',
      `tell application "Terminal" to do script "${escapeAppleScript(command)}"`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') {
    spawn('osascript', [
      '-e',
      `tell application "iTerm2" to create window with default profile command "${escapeAppleScript(command)}"`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Fallback: write a temp script and open it with Terminal.app
    const scriptPath = join(tmpdir(), `remoteclaw-launch-${Date.now()}.sh`);
    writeFileSync(scriptPath, `#!/bin/bash\n${command}\nrm -f "${scriptPath}"\n`);
    chmodSync(scriptPath, 0o755);
    spawn('open', ['-a', 'Terminal.app', scriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

/** Escape a string for embedding inside AppleScript double quotes. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
