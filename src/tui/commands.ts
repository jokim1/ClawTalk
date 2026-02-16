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
  setPlatformBehavior: (
    platformRef: string,
    updates: { agentName?: string | null; onMessagePrompt?: string | null },
  ) => void;
  listPlatformBehaviors: () => void;
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

function normalizeSlackScope(scope: string): string | null {
  const rawTrimmed = scope.trim();
  if (!rawTrimmed) return null;

  const quoted =
    (rawTrimmed.startsWith('"') && rawTrimmed.endsWith('"')) ||
    (rawTrimmed.startsWith("'") && rawTrimmed.endsWith("'"));
  const trimmed = quoted ? rawTrimmed.slice(1, -1).trim() : rawTrimmed;
  if (!trimmed) return null;

  const normalizeInner = (value: string): string | null => {
    const inner = value.trim();
    if (!inner) return null;

    if (/^(?:\*|all|slack:\*)$/i.test(inner)) {
      return 'slack:*';
    }

    const channel = inner.match(/^channel:([a-z0-9]+)$/i) ?? inner.match(/^slack:channel:([a-z0-9]+)$/i);
    if (channel?.[1]) {
      return `channel:${channel[1].toUpperCase()}`;
    }

    const user = inner.match(/^user:([a-z0-9]+)$/i) ?? inner.match(/^slack:user:([a-z0-9]+)$/i);
    if (user?.[1]) {
      return `user:${user[1].toUpperCase()}`;
    }

    const namedChannel =
      inner.match(/^#([a-z0-9._-]+)$/i) ??
      inner.match(/^channel:#?([a-z0-9._-]+)$/i) ??
      inner.match(/^slack:channel:#?([a-z0-9._-]+)$/i);
    if (namedChannel?.[1]) {
      return `#${namedChannel[1].toLowerCase()}`;
    }

    if (/^[a-z0-9._-]+$/i.test(inner)) {
      return `#${inner.toLowerCase()}`;
    }

    return null;
  };

  const accountViaKeyword = trimmed.match(/^account:([a-z0-9._-]+):(.+)$/i);
  if (accountViaKeyword?.[1] && accountViaKeyword?.[2]) {
    const normalizedInner = normalizeInner(accountViaKeyword[2]);
    if (!normalizedInner) return null;
    return `${accountViaKeyword[1].toLowerCase()}:${normalizedInner}`;
  }

  const accountViaSpace = trimmed.match(/^([a-z0-9._-]+)\s+(#?[a-z0-9._-]+)$/i);
  if (accountViaSpace?.[1] && accountViaSpace?.[2] && accountViaSpace[2].startsWith('#')) {
    const normalizedInner = normalizeInner(accountViaSpace[2]);
    if (!normalizedInner) return null;
    return `${accountViaSpace[1].toLowerCase()}:${normalizedInner}`;
  }

  const accountViaPrefix = trimmed.match(/^([a-z0-9._-]+):(.+)$/i);
  if (accountViaPrefix?.[1] && accountViaPrefix?.[2]) {
    const prefix = accountViaPrefix[1].toLowerCase();
    const scoped = accountViaPrefix[2].trim();
    const looksAccountScoped =
      !['channel', 'user', 'slack'].includes(prefix) &&
      (scoped.startsWith('#') ||
        /^channel:/i.test(scoped) ||
        /^user:/i.test(scoped) ||
        /^slack:\*/i.test(scoped) ||
        scoped === '*' ||
        scoped === 'all');
    if (looksAccountScoped) {
      const normalizedInner = normalizeInner(scoped);
      if (normalizedInner) {
        return `${prefix}:${normalizedInner}`;
      }
    }
  }

  return normalizeInner(trimmed);
}

function consumeOptionValue(input: string): { value?: string; rest: string; error?: string } {
  const trimmed = input.trimStart();
  if (!trimmed) {
    return { rest: '', error: 'missing value' };
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const closeIdx = trimmed.indexOf(quote, 1);
    if (closeIdx === -1) {
      return { rest: '', error: `missing closing ${quote}` };
    }
    return {
      value: trimmed.slice(1, closeIdx),
      rest: trimmed.slice(closeIdx + 1).trimStart(),
    };
  }

  const tokenMatch = trimmed.match(/^(\S+)(?:\s+|$)([\s\S]*)$/);
  if (!tokenMatch) {
    return { rest: '', error: 'missing value' };
  }
  return {
    value: tokenMatch[1],
    rest: tokenMatch[2] ?? '',
  };
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
    ctx.addSystemMessage(
      'Usage: /job add "schedule" prompt | /job pause|resume|delete N\n' +
      'Schedule: time (daily 9am, every 2h, cron) or event (on <scope> or on platformN)\n' +
      'Tip: For auto-replies on a platform binding, prefer /platform behavior set platformN --on-message "<prompt>".',
    );
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

/** Handle /platform behavior ... — per-binding behavior config. */
function handlePlatformBehaviorCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') {
    ctx.listPlatformBehaviors();
    return { handled: true };
  }

  const clearMatch = trimmed.match(/^clear\s+(\S+)$/i);
  if (clearMatch) {
    ctx.setPlatformBehavior(clearMatch[1], { agentName: null, onMessagePrompt: null });
    return { handled: true };
  }

  const payload = trimmed.match(/^set\s+(.+)$/i)?.[1]?.trim() ?? trimmed;
  const firstToken = payload.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!firstToken?.[1]) {
    ctx.addSystemMessage(
      'Usage: /platform behavior [list] | /platform behavior set <platformN> [--agent <name|off>] [--on-message "<prompt|off>"]',
    );
    return { handled: true };
  }

  const platformRef = firstToken[1];
  let rest = (firstToken[2] ?? '').trimStart();

  let hasAgent = false;
  let hasOnMessage = false;
  let agentName: string | null | undefined;
  let onMessagePrompt: string | null | undefined;

  while (rest.length > 0) {
    if (rest.startsWith('--agent')) {
      hasAgent = true;
      const consumed = consumeOptionValue(rest.slice('--agent'.length));
      if (!consumed.value || consumed.error) {
        ctx.addSystemMessage('Usage: --agent <name|off>');
        return { handled: true };
      }
      const raw = consumed.value.trim();
      agentName = /^(off|none|default)$/i.test(raw) ? null : raw;
      rest = consumed.rest;
      continue;
    }

    if (rest.startsWith('--on-message')) {
      hasOnMessage = true;
      const consumed = consumeOptionValue(rest.slice('--on-message'.length));
      if (consumed.value === undefined || consumed.error) {
        ctx.addSystemMessage('Usage: --on-message "<prompt|off>"');
        return { handled: true };
      }
      const raw = consumed.value.trim();
      onMessagePrompt = /^(off|none|disable|disabled)$/i.test(raw) ? null : raw;
      rest = consumed.rest;
      continue;
    }

    const badToken = rest.split(/\s+/)[0];
    ctx.addSystemMessage(
      `Unknown option "${badToken}". ` +
      'Use: /platform behavior set <platformN> [--agent <name|off>] [--on-message "<prompt|off>"]',
    );
    return { handled: true };
  }

  if (!hasAgent && !hasOnMessage) {
    ctx.addSystemMessage(
      'Usage: /platform behavior set <platformN> [--agent <name|off>] [--on-message "<prompt|off>"]\n' +
      'Examples:\n' +
      '  /platform behavior set platform1 --agent DeepSeek\n' +
      '  /platform behavior set platform1 --on-message "Reply only if asked directly."\n' +
      '  /platform behavior clear platform1',
    );
    return { handled: true };
  }

  ctx.setPlatformBehavior(platformRef, {
    ...(hasAgent ? { agentName: agentName ?? null } : {}),
    ...(hasOnMessage ? { onMessagePrompt: onMessagePrompt ?? null } : {}),
  });
  return { handled: true };
}

/** Handle /platform <subcommand> — manage platform bindings. */
function handlePlatformCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') {
    ctx.listPlatformBindings();
    return { handled: true };
  }

  const behaviorMatch = trimmed.match(/^behavior(?:\s+([\s\S]+))?$/i);
  if (behaviorMatch) {
    return handlePlatformBehaviorCommand(behaviorMatch[1] ?? '', ctx);
  }

  const deleteMatch = trimmed.match(/^delete\s+(\d+)$/);
  if (deleteMatch) {
    ctx.removePlatformBinding(parseInt(deleteMatch[1], 10));
    return { handled: true };
  }

  const addPrefix = trimmed.match(/^add\s+(.+)$/i);
  const payload = addPrefix?.[1] ? addPrefix[1].trim() : trimmed;

  // Parse: platform scope permission (e.g. "slack #team-product read+write")
  const parts = payload.split(/\s+/);
  if (parts.length < 3) {
    ctx.addSystemMessage(
      'Usage: /platform <name> <scope> <permission>\n' +
      'Permission: read, write, read+write\n' +
      'Examples:\n' +
      '  /platform slack kimfamily:#general read+write\n' +
      '  /platform slack channel:C01234567 read+write\n' +
      '  /platform behavior set platform1 --agent DeepSeek --on-message "Reply with concise action items."',
    );
    return { handled: true };
  }
  const permission = parts[parts.length - 1];
  if (!['read', 'write', 'read+write'].includes(permission)) {
    ctx.addSystemMessage('Invalid permission. Use: read, write, or read+write');
    return { handled: true };
  }
  const platform = parts[0].trim().toLowerCase();
  const rawScope = parts.slice(1, -1).join(' ');
  if (platform === 'slack') {
    const normalizedScope = normalizeSlackScope(rawScope);
    if (!normalizedScope) {
      ctx.addSystemMessage(
        'Invalid Slack scope. Use channel:<ID>, user:<ID>, #channel, account:#channel, or slack:* ' +
        '(examples: #general, kimfamily:#general, channel:C12345678).',
      );
      return { handled: true };
    }
    ctx.addPlatformBinding(platform, normalizedScope, permission);
    return { handled: true };
  }
  ctx.addPlatformBinding(platform, rawScope, permission);
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
  platform: { handler: handlePlatformCommand, description: 'Add bindings or set platform behaviors' },
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
          { name: 'job add "on <scope|platformN>" prompt', description: 'Add event-driven job (legacy path; prefer /platform behavior for inbound auto-replies)' },
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
          { name: 'platform add <name> <scope> <perm>', description: 'Add binding (Slack examples: kimfamily:#general, channel:<id>, user:<id>, slack:*)' },
          { name: 'platform <name> <scope> <perm>', description: 'Shorthand for platform add' },
          { name: 'platform delete N', description: 'Remove binding #N' },
          { name: 'platform behavior', description: 'List platform behavior rules' },
          { name: 'platform behavior set platformN --agent <name>', description: 'Set per-platform responder agent (does not auto-reply by itself)' },
          { name: 'platform behavior set platformN --on-message "<prompt>"', description: 'Enable inbound auto-reply prompt for platformN' },
          { name: 'platform behavior clear platformN', description: 'Clear behavior config for platformN' },
        );
      } else {
        results.push({ name, description: entry.description });
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
