/**
 * Slash command registry
 *
 * Extensible command pattern: add new slash commands by adding
 * entries to the COMMANDS map without modifying the submit handler.
 */

import { ALIAS_TO_MODEL_ID } from '../models.js';

export interface CommandContext {
  switchModel: (modelId: string) => void;
  openModelPicker: () => void;
  clearSession: () => void;
  setError: (error: string | null) => void;
  addSystemMessage: (text: string) => void;
  saveTalk: (title?: string) => void;
  setTopicTitle: (title: string) => void;
  pinMessage: (fromBottom?: number) => void;
  unpinMessage: (fromBottom?: number) => void;
  listPins: () => void;
  addJob: (schedule: string, prompt: string) => void;
  listJobs: () => void;
  pauseJob: (index: number) => void;
  resumeJob: (index: number) => void;
  deleteJob: (index: number) => void;
  setObjective: (text: string | undefined) => void;
  showObjective: () => void;
  viewReports: (jobIndex?: number) => void;
  addAgent: (model: string, role: string) => void;
  removeAgent: (name: string) => void;
  changeAgentRole: (name: string, role: string) => void;
  listAgents: () => void;
  askAgent: (name: string, message: string) => void;
  debateAll: (topic: string) => void;
  reviewLast: () => void;
  attachFile: (filePath: string, message?: string) => void;
  exportTalk: (format?: string, lastN?: number) => void;
  editMessages: () => void;
  addDirective: (text: string) => void;
  removeDirective: (index: number) => void;
  toggleDirective: (index: number) => void;
  listDirectives: () => void;
  addPlatformBinding: (platform: string, scope: string, permission: string) => void;
  removePlatformBinding: (index: number) => void;
  listPlatformBindings: () => void;
  showPlaybook: () => void;
}

export interface CommandResult {
  handled: true;
}

type CommandHandler = (args: string, ctx: CommandContext) => CommandResult;

export interface CommandInfo {
  name: string;
  description: string;
}

/** Handle /model <alias|id> — switch the active model. */
function handleModelCommand(args: string, ctx: CommandContext): CommandResult {
  if (!args) {
    ctx.openModelPicker();
    return { handled: true };
  }

  const resolvedModel = ALIAS_TO_MODEL_ID[args.toLowerCase()] ?? args;
  ctx.switchModel(resolvedModel);
  return { handled: true };
}

/** Handle /clear — clear the current session. */
function handleClearCommand(_args: string, ctx: CommandContext): CommandResult {
  ctx.clearSession();
  return { handled: true };
}

/** Handle /save [title] — save current chat to Talks list, optionally with a title. */
function handleSaveCommand(args: string, ctx: CommandContext): CommandResult {
  const title = args.trim() || undefined;
  ctx.saveTalk(title);
  return { handled: true };
}

/** Handle /topic <title> — set topic title and save current chat to Talks list. */
function handleTopicCommand(args: string, ctx: CommandContext): CommandResult {
  if (!args.trim()) {
    ctx.addSystemMessage('Usage: /topic <title>');
    return { handled: true };
  }
  ctx.saveTalk(args.trim());
  return { handled: true };
}

/** Handle /pin [N] — pin the last assistant message or N-th from bottom. */
function handlePinCommand(args: string, ctx: CommandContext): CommandResult {
  const n = args.trim() ? parseInt(args.trim(), 10) : undefined;
  if (n !== undefined && (isNaN(n) || n < 1)) {
    ctx.addSystemMessage('Usage: /pin [N] — N is a positive number');
    return { handled: true };
  }
  ctx.pinMessage(n);
  return { handled: true };
}

/** Handle /unpin [N] — unpin the most recent pin or pin #N. */
function handleUnpinCommand(args: string, ctx: CommandContext): CommandResult {
  const n = args.trim() ? parseInt(args.trim(), 10) : undefined;
  if (n !== undefined && (isNaN(n) || n < 1)) {
    ctx.addSystemMessage('Usage: /unpin [N] — N is a positive number');
    return { handled: true };
  }
  ctx.unpinMessage(n);
  return { handled: true };
}

/** Handle /pins — list all pinned messages. */
function handlePinsCommand(_args: string, ctx: CommandContext): CommandResult {
  ctx.listPins();
  return { handled: true };
}

/** Handle /job <subcommand> — manage jobs. */
function handleJobCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage('Usage: /job add "schedule" prompt | /job pause|resume|delete N');
    return { handled: true };
  }

  // Parse subcommand
  if (trimmed.startsWith('add ')) {
    const rest = trimmed.slice(4).trim();
    // Parse quoted schedule: "schedule" prompt
    const match = rest.match(/^"([^"]+)"\s+(.+)$/s);
    if (!match) {
      ctx.addSystemMessage('Usage: /job add "schedule" prompt text');
      return { handled: true };
    }
    ctx.addJob(match[1], match[2]);
    return { handled: true };
  }

  const subMatch = trimmed.match(/^(pause|resume|delete)\s+(\d+)$/);
  if (subMatch) {
    const action = subMatch[1] as 'pause' | 'resume' | 'delete';
    const index = parseInt(subMatch[2], 10);
    if (action === 'pause') ctx.pauseJob(index);
    else if (action === 'resume') ctx.resumeJob(index);
    else ctx.deleteJob(index);
    return { handled: true };
  }

  ctx.addSystemMessage('Usage: /job add "schedule" prompt | /job pause|resume|delete N');
  return { handled: true };
}

/** Handle /jobs [subcommand] — list jobs, or forward subcommands to /job handler. */
function handleJobsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.listJobs();
    return { handled: true };
  }
  // Forward subcommands (e.g. "/jobs delete 3") to the /job handler
  return handleJobCommand(trimmed, ctx);
}

/** Handle /reports [N] — view job reports for this talk (optionally for job #N). */
function handleReportsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.viewReports();
    return { handled: true };
  }
  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n < 1) {
    ctx.addSystemMessage('Usage: /reports [N] — N is a positive job number');
    return { handled: true };
  }
  ctx.viewReports(n);
  return { handled: true };
}

/** Handle /objective [text|clear] — view, set, or clear the talk objective. */
function handleObjectiveCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.showObjective();
    return { handled: true };
  }
  if (trimmed === 'clear') {
    ctx.setObjective(undefined);
    return { handled: true };
  }
  ctx.setObjective(trimmed);
  return { handled: true };
}

/** Handle /agent <subcommand> — manage agents. */
function handleAgentCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage('Usage: /agent add <model> <role> | /agent remove <name>');
    return { handled: true };
  }

  if (trimmed.startsWith('add ')) {
    const rest = trimmed.slice(4).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      ctx.addSystemMessage('Usage: /agent add <model> <role>');
      return { handled: true };
    }
    const model = parts[0];
    const role = parts[1];
    ctx.addAgent(model, role);
    return { handled: true };
  }

  if (trimmed.startsWith('remove ')) {
    const name = trimmed.slice(7).trim();
    if (!name) {
      ctx.addSystemMessage('Usage: /agent remove <name>');
      return { handled: true };
    }
    ctx.removeAgent(name);
    return { handled: true };
  }

  if (trimmed.startsWith('role ')) {
    const rest = trimmed.slice(5).trim();
    // Parse: "Agent Name newrole" — role is always last word
    const lastSpace = rest.lastIndexOf(' ');
    if (lastSpace === -1) {
      ctx.addSystemMessage('Usage: /agent role <name> <new-role>');
      return { handled: true };
    }
    const name = rest.slice(0, lastSpace).trim();
    const role = rest.slice(lastSpace + 1).trim();
    ctx.changeAgentRole(name, role);
    return { handled: true };
  }

  ctx.addSystemMessage('Usage: /agent add <model> <role> | /agent remove <name> | /agent role <name> <role>');
  return { handled: true };
}

/** Handle /agents — list all agents. */
function handleAgentsCommand(_args: string, ctx: CommandContext): CommandResult {
  ctx.listAgents();
  return { handled: true };
}

/** Handle /ask @<name> <message> — send to specific agent. */
function handleAskCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  // Parse @name from the start
  const match = trimmed.match(/^@(\S+)\s+(.+)$/s);
  if (!match) {
    ctx.addSystemMessage('Usage: /ask @<agent-name> <message>');
    return { handled: true };
  }
  ctx.askAgent(match[1], match[2]);
  return { handled: true };
}

/** Handle /debate <topic> — all agents discuss. */
function handleDebateCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage('Usage: /debate <topic>');
    return { handled: true };
  }
  ctx.debateAll(trimmed);
  return { handled: true };
}

/** Handle /review — non-primary agents critique the last response. */
function handleReviewCommand(_args: string, ctx: CommandContext): CommandResult {
  ctx.reviewLast();
  return { handled: true };
}

/** Handle /file <path> [message] — attach a file (image, PDF, or text). */
function handleFileCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage('Usage: /file <path> [message]');
    return { handled: true };
  }

  // Parse path: support quoted paths and ~/
  let filePath: string;
  let message: string | undefined;

  if (trimmed.startsWith('"')) {
    // Quoted path: /file "path with spaces" optional message
    const endQuote = trimmed.indexOf('"', 1);
    if (endQuote === -1) {
      ctx.addSystemMessage('Unclosed quote in file path');
      return { handled: true };
    }
    filePath = trimmed.slice(1, endQuote);
    message = trimmed.slice(endQuote + 1).trim() || undefined;
  } else {
    // Unquoted: first token is path, rest is message
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      filePath = trimmed;
    } else {
      filePath = trimmed.slice(0, spaceIdx);
      message = trimmed.slice(spaceIdx + 1).trim() || undefined;
    }
  }

  ctx.attachFile(filePath, message);
  return { handled: true };
}

/** Handle /export [format] [last N] — export current talk. */
function handleExportCommand(args: string, ctx: CommandContext): CommandResult {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let format: string | undefined;
  let lastN: number | undefined;

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (!isNaN(num) && num > 0) {
      lastN = num;
    } else if (/^(txt|t|md|m|docx|d)$/i.test(part)) {
      format = part.toLowerCase();
    }
  }

  ctx.exportTalk(format, lastN);
  return { handled: true };
}

/** Handle /edit — open message editor overlay. */
function handleEditCommand(_args: string, ctx: CommandContext): CommandResult {
  ctx.editMessages();
  return { handled: true };
}

/** Handle /directive <subcommand> — manage directives. */
function handleDirectiveCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') {
    ctx.listDirectives();
    return { handled: true };
  }

  const deleteMatch = trimmed.match(/^delete\s+(\d+)$/);
  if (deleteMatch) {
    ctx.removeDirective(parseInt(deleteMatch[1], 10));
    return { handled: true };
  }

  const toggleMatch = trimmed.match(/^toggle\s+(\d+)$/);
  if (toggleMatch) {
    ctx.toggleDirective(parseInt(toggleMatch[1], 10));
    return { handled: true };
  }

  // Everything else is treated as adding a new directive
  ctx.addDirective(trimmed);
  return { handled: true };
}

/** Handle /directives — list all directives. */
function handleDirectivesCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.listDirectives();
    return { handled: true };
  }
  // Forward subcommands to /directive handler
  return handleDirectiveCommand(trimmed, ctx);
}

/** Handle /platform <subcommand> — manage platform bindings. */
function handlePlatformCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') {
    ctx.listPlatformBindings();
    return { handled: true };
  }

  const deleteMatch = trimmed.match(/^delete\s+(\d+)$/);
  if (deleteMatch) {
    ctx.removePlatformBinding(parseInt(deleteMatch[1], 10));
    return { handled: true };
  }

  // Parse: platform scope permission (e.g. "slack #team-product read+write")
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) {
    ctx.addSystemMessage('Usage: /platform <name> <scope> <permission>\nPermission: read, write, read+write');
    return { handled: true };
  }
  const permission = parts[parts.length - 1];
  if (!['read', 'write', 'read+write'].includes(permission)) {
    ctx.addSystemMessage('Invalid permission. Use: read, write, or read+write');
    return { handled: true };
  }
  const platform = parts[0];
  const scope = parts.slice(1, -1).join(' ');
  ctx.addPlatformBinding(platform, scope, permission);
  return { handled: true };
}

/** Handle /platforms — list all platform bindings. */
function handlePlatformsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.listPlatformBindings();
    return { handled: true };
  }
  return handlePlatformCommand(trimmed, ctx);
}

/** Handle /playbook — show full talk configuration overview. */
function handlePlaybookCommand(_args: string, ctx: CommandContext): CommandResult {
  ctx.showPlaybook();
  return { handled: true };
}

/**
 * Registry of slash commands.
 * Add new commands here — they'll be available immediately.
 */
const COMMANDS: Record<string, { handler: CommandHandler; description: string }> = {
  model: { handler: handleModelCommand, description: 'Switch AI model' },
  clear: { handler: handleClearCommand, description: 'Clear current session' },
  save: { handler: handleSaveCommand, description: 'Save chat to Talks' },
  topic: { handler: handleTopicCommand, description: 'Set topic title and save' },
  pin: { handler: handlePinCommand, description: 'Pin an assistant message' },
  unpin: { handler: handleUnpinCommand, description: 'Unpin a message' },
  pins: { handler: handlePinsCommand, description: 'List pinned messages' },
  job: { handler: handleJobCommand, description: 'Add or manage a job' },
  jobs: { handler: handleJobsCommand, description: 'List jobs for this talk' },
  objective: { handler: handleObjectiveCommand, description: 'Set talk objective (system prompt)' },
  reports: { handler: handleReportsCommand, description: 'View job reports' },
  agent: { handler: handleAgentCommand, description: 'Add or remove an agent' },
  agents: { handler: handleAgentsCommand, description: 'List agents for this talk' },
  ask: { handler: handleAskCommand, description: 'Ask a specific agent' },
  debate: { handler: handleDebateCommand, description: 'All agents discuss a topic' },
  review: { handler: handleReviewCommand, description: 'Agents review last response' },
  file: { handler: handleFileCommand, description: 'Attach a file (image, PDF, text)' },
  export: { handler: handleExportCommand, description: 'Export current talk' },
  edit: { handler: handleEditCommand, description: 'Edit messages (mark and delete)' },
  directive: { handler: handleDirectiveCommand, description: 'Add or manage a directive' },
  directives: { handler: handleDirectivesCommand, description: 'List directives for this talk' },
  platform: { handler: handlePlatformCommand, description: 'Add or manage platform bindings' },
  platforms: { handler: handlePlatformsCommand, description: 'List platform bindings' },
  playbook: { handler: handlePlaybookCommand, description: 'Show full talk configuration' },
};

/**
 * Try to dispatch a slash command. Returns true if the input was handled.
 */
export function dispatchCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return false;

  const withoutSlash = trimmed.slice(1);

  // Check explicit commands (e.g. /model, /clear)
  for (const [name, entry] of Object.entries(COMMANDS)) {
    if (withoutSlash === name || withoutSlash.startsWith(name + ' ')) {
      const args = withoutSlash.slice(name.length).trim();
      entry.handler(args, ctx);
      return true;
    }
  }

  // Check bare alias commands (e.g. /opus, /deep, /sonnet)
  const alias = withoutSlash.toLowerCase();
  const aliasModel = ALIAS_TO_MODEL_ID[alias];
  if (aliasModel) {
    ctx.switchModel(aliasModel);
    return true;
  }

  // Unrecognized slash command — show feedback instead of sending as chat
  const cmdWord = withoutSlash.split(/\s/)[0];
  ctx.addSystemMessage(`Unknown command: /${cmdWord}. Type / to see available commands.`);
  return true;
}

/**
 * Get matching command completions for a given prefix.
 * Input should be the text after "/" (e.g. "pi" for "/pi").
 * Returns matching commands sorted by name.
 */
export function getCommandCompletions(prefix: string): CommandInfo[] {
  const lower = prefix.toLowerCase();
  const results: CommandInfo[] = [];

  for (const [name, entry] of Object.entries(COMMANDS)) {
    if (name.startsWith(lower)) {
      // Expand /job into subcommand hints
      if (name === 'job') {
        results.push(
          { name: 'job add "schedule" prompt', description: 'Add a scheduled job' },
          { name: 'job pause N', description: 'Pause job #N' },
          { name: 'job resume N', description: 'Resume job #N' },
          { name: 'job delete N', description: 'Delete job #N' },
        );
      } else if (name === 'file') {
        results.push(
          { name: 'file <path> [message]', description: 'Attach image (jpg, png, heic, webp, gif)' },
        );
      } else if (name === 'export') {
        results.push(
          { name: 'export [txt|md|docx] [last N]', description: 'Export current talk' },
        );
      } else if (name === 'agent') {
        results.push(
          { name: 'agent add <model> <role>', description: 'Add agent with role' },
          { name: 'agent remove <name>', description: 'Remove an agent' },
          { name: 'agent role <name> <role>', description: 'Change role: Analyst, Critic, Strategist, Devil\'s Advocate, Synthesizer, Editor' },
        );
      } else if (name === 'directive') {
        results.push(
          { name: 'directive <text>', description: 'Add a directive' },
          { name: 'directive toggle N', description: 'Enable/disable directive #N' },
          { name: 'directive delete N', description: 'Delete directive #N' },
        );
      } else if (name === 'platform') {
        results.push(
          { name: 'platform <name> <scope> <perm>', description: 'Add binding (read, write, read+write)' },
          { name: 'platform delete N', description: 'Remove binding #N' },
        );
      } else {
        results.push({ name, description: entry.description });
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
