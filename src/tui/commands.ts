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
  listChannelResponses: () => void;
  setChannelResponseEnabled: (index: number, enabled: boolean) => void;
  setChannelResponsePrompt: (index: number, prompt: string) => void;
  setChannelResponseAgent: (index: number, agentName: string) => void;
  clearChannelResponse: (index: number) => void;
  listTools: () => void;
  setToolsMode: (mode: 'off' | 'confirm' | 'auto') => void;
  addAllowedTool: (toolName: string) => void;
  removeAllowedTool: (toolName: string) => void;
  clearAllowedTools: () => void;
  addDeniedTool: (toolName: string) => void;
  removeDeniedTool: (toolName: string) => void;
  clearDeniedTools: () => void;
  showGoogleDocsAuthStatus: () => void;
  setGoogleDocsRefreshToken: (token: string) => void;
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
    ctx.addSystemMessage(
      'Usage: /topic <title>\n' +
      'Example: /topic Q2 launch planning',
    );
    return { handled: true };
  }
  ctx.saveTalk(args.trim());
  return { handled: true };
}

/** Handle /pin [N] — pin the last assistant message or N-th from bottom. */
function handlePinCommand(args: string, ctx: CommandContext): CommandResult {
  const n = args.trim() ? parseInt(args.trim(), 10) : undefined;
  if (n !== undefined && (isNaN(n) || n < 1)) {
    ctx.addSystemMessage(
      'Usage: /pin [N]\n' +
      'Pins the latest assistant message, or the Nth assistant message from the bottom.\n' +
      'Examples: /pin   /pin 2',
    );
    return { handled: true };
  }
  ctx.pinMessage(n);
  return { handled: true };
}

/** Handle /unpin [N] — unpin the most recent pin or pin #N. */
function handleUnpinCommand(args: string, ctx: CommandContext): CommandResult {
  const n = args.trim() ? parseInt(args.trim(), 10) : undefined;
  if (n !== undefined && (isNaN(n) || n < 1)) {
    ctx.addSystemMessage(
      'Usage: /unpin [N]\n' +
      'Removes the most recent pin, or pin #N from /pins.\n' +
      'Examples: /unpin   /unpin 1',
    );
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

/** Handle /job <subcommand> — manage automations. */
function handleJobCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage(
      'Usage:\n' +
      '- /job add "schedule" <prompt>\n' +
      '- /job pause N | /job resume N | /job delete N\n\n' +
      'Schedule examples:\n' +
      '- /job add "every 2h" Summarize open incidents\n' +
      '- /job add "daily 9am" Draft today\'s priorities\n' +
      '- /job add "on platform1" Respond with action items\n' +
      '- /job add "0 9 * * 1-5" Post weekday standup checklist',
    );
    return { handled: true };
  }

  // Parse subcommand
  if (trimmed.startsWith('add ')) {
    const rest = trimmed.slice(4).trim();
    // Parse quoted schedule: "schedule" prompt
    const match = rest.match(/^"([^"]+)"\s+(.+)$/s);
    if (!match) {
      ctx.addSystemMessage(
        'Usage: /job add "schedule" <prompt>\n' +
        'Example: /job add "every 30m" Check Slack for urgent blockers',
      );
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

  ctx.addSystemMessage(
    'Usage:\n' +
    '- /job add "schedule" <prompt>\n' +
    '- /job pause N | /job resume N | /job delete N\n' +
    'Example: /job pause 2',
  );
  return { handled: true };
}

/** Handle /jobs [subcommand] — list automations, or forward subcommands to /job handler. */
function handleJobsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.listJobs();
    return { handled: true };
  }
  // Forward subcommands (e.g. "/jobs delete 3") to the /job handler
  return handleJobCommand(trimmed, ctx);
}

/** Handle /automations [subcommand] — alias of /jobs. */
function handleAutomationsCommand(args: string, ctx: CommandContext): CommandResult {
  return handleJobsCommand(args, ctx);
}

/** Handle /reports [N] — view automation reports for this talk (optionally for automation #N). */
function handleReportsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.viewReports();
    return { handled: true };
  }
  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n < 1) {
    ctx.addSystemMessage(
      'Usage: /reports [N]\n' +
      'Shows recent automation runs for this talk, or only automation #N.\n' +
      'Examples: /reports   /reports 1',
    );
    return { handled: true };
  }
  ctx.viewReports(n);
  return { handled: true };
}

/** Handle /objective [text|clear] — view, set, or clear the talk objectives. */
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

/** Handle /objectives [text|clear] — alias of /objective. */
function handleObjectivesCommand(args: string, ctx: CommandContext): CommandResult {
  return handleObjectiveCommand(args, ctx);
}

/** Handle /agent <subcommand> — manage agents. */
function handleAgentCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage(
      'Usage:\n' +
      '- /agent add <model> <role>\n' +
      '- /agent remove <name>\n' +
      '- /agent role <name> <role>\n' +
      'Examples:\n' +
      '- /agent add opus strategist\n' +
      '- /agent role Opus critic',
    );
    return { handled: true };
  }

  if (trimmed.startsWith('add ')) {
    const rest = trimmed.slice(4).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      ctx.addSystemMessage(
        'Usage: /agent add <model> <role>\n' +
        'Example: /agent add sonnet analyst',
      );
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
      ctx.addSystemMessage(
        'Usage: /agent remove <name>\n' +
        'Example: /agent remove Opus',
      );
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
      ctx.addSystemMessage(
        'Usage: /agent role <name> <new-role>\n' +
        'Example: /agent role Sonnet strategist',
      );
      return { handled: true };
    }
    const name = rest.slice(0, lastSpace).trim();
    const role = rest.slice(lastSpace + 1).trim();
    ctx.changeAgentRole(name, role);
    return { handled: true };
  }

  ctx.addSystemMessage(
    'Usage:\n' +
    '- /agent add <model> <role>\n' +
    '- /agent remove <name>\n' +
    '- /agent role <name> <role>',
  );
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
    ctx.addSystemMessage(
      'Usage: /ask @<agent-name> <message>\n' +
      'Example: /ask @Opus Critique this rollout plan for risk.',
    );
    return { handled: true };
  }
  ctx.askAgent(match[1], match[2]);
  return { handled: true };
}

/** Handle /debate <topic> — all agents discuss. */
function handleDebateCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.addSystemMessage(
      'Usage: /debate <topic>\n' +
      'Example: /debate Should we ship with feature flags enabled by default?',
    );
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
    ctx.addSystemMessage(
      'Usage: /file <path> [message]\n' +
      'Examples:\n' +
      '- /file ./docs/spec.md\n' +
      '- /file "./screenshots/login bug.png" Explain this issue',
    );
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

/** Handle /directive <subcommand> — manage rules. */
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

  // Everything else is treated as adding a new rule
  ctx.addDirective(trimmed);
  return { handled: true };
}

/** Handle /directives — list all rules. */
function handleDirectivesCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.listDirectives();
    return { handled: true };
  }
  // Forward subcommands to /directive handler
  return handleDirectiveCommand(trimmed, ctx);
}

/** Handle /rule <subcommand> — alias of /directive. */
function handleRuleCommand(args: string, ctx: CommandContext): CommandResult {
  return handleDirectiveCommand(args, ctx);
}

/** Handle /rules — alias of /directives. */
function handleRulesCommand(args: string, ctx: CommandContext): CommandResult {
  return handleDirectivesCommand(args, ctx);
}

/** Handle /platform <subcommand> — manage channel connections. */
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

  // Parse: platform scope permission (e.g. "slack channel:C123 read+write")
  const match = trimmed.match(/^(\S+)\s+(.+)\s+(read\+write|read|write)$/i);
  if (!match) {
    ctx.addSystemMessage(
      'Usage: /channel <platform> <scope> <permission>\n' +
      'Platforms: slack (full support), telegram/whatsapp (connection + event jobs)\n' +
      'Slack scope formats:\n' +
      '- channel:C12345678 (recommended)\n' +
      '- #general (default connected Slack account)\n' +
      '- kimfamily:#general (explicit account ID + channel)\n' +
      'Permission: read | write | read+write\n' +
      'Examples:\n' +
      '- /channel slack channel:C0AF9BZ3V3L read+write\n' +
      '- /channel slack kimfamily:#general read+write\n' +
      '- /channel slack #general read\n' +
      '- /channel telegram group:-1001234567890 read\n' +
      '- /channel whatsapp group:1203630... read',
    );
    return { handled: true };
  }
  const platform = match[1];
  const permission = match[3].toLowerCase();
  let scope = match[2].trim();
  if (
    (scope.startsWith('"') && scope.endsWith('"')) ||
    (scope.startsWith('\'') && scope.endsWith('\''))
  ) {
    scope = scope.slice(1, -1).trim();
  }
  if (!scope) {
    ctx.addSystemMessage('Scope cannot be empty. Use /channel <platform> <scope> <permission>.');
    return { handled: true };
  }
  if (platform.toLowerCase() === 'slack') {
    const looksLikeDisplayLabel = /\s+#/.test(scope)
      && !scope.startsWith('#')
      && !/^[a-z0-9._-]+:#/i.test(scope)
      && !/^account:[a-z0-9._-]+:/i.test(scope)
      && !/^channel:/i.test(scope)
      && !/^user:/i.test(scope)
      && !/^slack:/i.test(scope);
    if (looksLikeDisplayLabel) {
      ctx.addSystemMessage(
        'Slack scope looks like a display label. Use account ID format instead, for example:\n' +
        '- /channel slack lilagames:#team-product read+write\n' +
        '- /channel slack channel:C01JZCR4ATU read+write',
      );
      return { handled: true };
    }
  }
  ctx.addPlatformBinding(platform, scope, permission);
  return { handled: true };
}

/** Handle /platforms — list all channel connections. */
function handlePlatformsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.listPlatformBindings();
    return { handled: true };
  }
  return handlePlatformCommand(trimmed, ctx);
}

/** Handle /channel <subcommand> — alias of /platform. */
function handleChannelCommand(args: string, ctx: CommandContext): CommandResult {
  return handlePlatformCommand(args, ctx);
}

/** Handle /channels — alias of /platforms. */
function handleChannelsCommand(args: string, ctx: CommandContext): CommandResult {
  return handlePlatformsCommand(args, ctx);
}

/** Handle /response <subcommand> — manage channel response settings. */
function handleResponseCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') {
    ctx.listChannelResponses();
    return { handled: true };
  }

  const setMatch = trimmed.match(/^set\s+(\d+)\s+(on|off)$/i);
  if (setMatch) {
    const index = parseInt(setMatch[1], 10);
    const enabled = setMatch[2].toLowerCase() === 'on';
    ctx.setChannelResponseEnabled(index, enabled);
    return { handled: true };
  }

  const promptMatch = trimmed.match(/^prompt\s+(\d+)\s+(.+)$/is);
  if (promptMatch) {
    const index = parseInt(promptMatch[1], 10);
    const prompt = promptMatch[2].trim();
    if (!prompt) {
      ctx.addSystemMessage('Usage: /response prompt <connectionN> <text>');
      return { handled: true };
    }
    ctx.setChannelResponsePrompt(index, prompt);
    return { handled: true };
  }

  const agentMatch = trimmed.match(/^agent\s+(\d+)\s+(.+)$/is);
  if (agentMatch) {
    const index = parseInt(agentMatch[1], 10);
    const agentName = agentMatch[2].trim();
    if (!agentName) {
      ctx.addSystemMessage('Usage: /response agent <connectionN> <agent name>');
      return { handled: true };
    }
    ctx.setChannelResponseAgent(index, agentName);
    return { handled: true };
  }

  const clearMatch = trimmed.match(/^clear\s+(\d+)$/i);
  if (clearMatch) {
    const index = parseInt(clearMatch[1], 10);
    ctx.clearChannelResponse(index);
    return { handled: true };
  }

  ctx.addSystemMessage(
    'Usage:\n' +
    '- /response list\n' +
    '- /response set <connectionN> on|off\n' +
    '- /response prompt <connectionN> <text>\n' +
    '- /response agent <connectionN> <agent name>\n' +
    '- /response clear <connectionN>\n' +
    'Examples:\n' +
    '- /response set 1 on\n' +
    '- /response prompt 1 Reply with concise action items and owners\n' +
    '- /response agent 1 Opus Strategist',
  );
  return { handled: true };
}

/** Handle /responses — alias of /response. */
function handleResponsesCommand(args: string, ctx: CommandContext): CommandResult {
  return handleResponseCommand(args, ctx);
}

/** Handle /tools <subcommand> — list and manage talk tool policy. */
function handleToolsCommand(args: string, ctx: CommandContext): CommandResult {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') {
    ctx.listTools();
    return { handled: true };
  }

  const modeMatch = trimmed.match(/^mode\s+(off|confirm|auto)$/i);
  if (modeMatch) {
    ctx.setToolsMode(modeMatch[1].toLowerCase() as 'off' | 'confirm' | 'auto');
    return { handled: true };
  }

  const addAllow = trimmed.match(/^allow\s+add\s+([a-zA-Z0-9_.-]+)$/);
  if (addAllow) {
    ctx.addAllowedTool(addAllow[1]);
    return { handled: true };
  }
  const removeAllow = trimmed.match(/^allow\s+remove\s+([a-zA-Z0-9_.-]+)$/);
  if (removeAllow) {
    ctx.removeAllowedTool(removeAllow[1]);
    return { handled: true };
  }
  if (/^allow\s+clear$/i.test(trimmed)) {
    ctx.clearAllowedTools();
    return { handled: true };
  }

  const addDeny = trimmed.match(/^deny\s+add\s+([a-zA-Z0-9_.-]+)$/);
  if (addDeny) {
    ctx.addDeniedTool(addDeny[1]);
    return { handled: true };
  }
  const removeDeny = trimmed.match(/^deny\s+remove\s+([a-zA-Z0-9_.-]+)$/);
  if (removeDeny) {
    ctx.removeDeniedTool(removeDeny[1]);
    return { handled: true };
  }
  if (/^deny\s+clear$/i.test(trimmed)) {
    ctx.clearDeniedTools();
    return { handled: true };
  }

  if (/^auth\s+status$/i.test(trimmed)) {
    ctx.showGoogleDocsAuthStatus();
    return { handled: true };
  }

  const authSetMatch = trimmed.match(/^auth\s+set-refresh\s+(.+)$/i);
  if (authSetMatch) {
    const token = authSetMatch[1].trim();
    if (!token) {
      ctx.addSystemMessage('Usage: /tools auth set-refresh <google-refresh-token>');
      return { handled: true };
    }
    ctx.setGoogleDocsRefreshToken(token);
    return { handled: true };
  }

  ctx.addSystemMessage(
    'Usage:\n' +
    '- /tools\n' +
    '- /tools mode off|confirm|auto\n' +
    '- /tools allow add <tool> | /tools allow remove <tool> | /tools allow clear\n' +
    '- /tools deny add <tool> | /tools deny remove <tool> | /tools deny clear\n' +
    '- /tools auth status\n' +
    '- /tools auth set-refresh <google-refresh-token>\n' +
    'Examples:\n' +
    '- /tools mode confirm\n' +
    '- /tools allow add google_docs_write\n' +
    '- /tools deny add shell_exec\n' +
    '- /tools auth status',
  );
  return { handled: true };
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
  clear: { handler: handleClearCommand, description: 'Clear current session' },
  save: { handler: handleSaveCommand, description: 'Save chat to Talks' },
  topic: { handler: handleTopicCommand, description: 'Set topic title and save' },
  pin: { handler: handlePinCommand, description: 'Pin an assistant message' },
  unpin: { handler: handleUnpinCommand, description: 'Unpin a message' },
  pins: { handler: handlePinsCommand, description: 'List pinned messages' },
  objectives: { handler: handleObjectivesCommand, description: 'Set talk objectives (desired outcome)' },
  reports: { handler: handleReportsCommand, description: 'View automation reports' },
  agent: { handler: handleAgentCommand, description: 'Add or remove an agent' },
  agents: { handler: handleAgentsCommand, description: 'List agents for this talk' },
  ask: { handler: handleAskCommand, description: 'Ask a specific agent' },
  debate: { handler: handleDebateCommand, description: 'All agents discuss a topic' },
  file: { handler: handleFileCommand, description: 'Attach a file (image, PDF, text)' },
  export: { handler: handleExportCommand, description: 'Export current talk' },
  edit: { handler: handleEditCommand, description: 'Edit messages (mark and delete)' },
  rule: { handler: handleRuleCommand, description: 'Add or manage a rule' },
  rules: { handler: handleRulesCommand, description: 'List rules for this talk' },
  tools: { handler: handleToolsCommand, description: 'List tools and set tool execution policy' },
  playbook: { handler: handlePlaybookCommand, description: 'Show full talk configuration' },
};

/**
 * Hidden compatibility commands.
 * These keep old command names working without advertising them in help/completions.
 */
const HIDDEN_COMMANDS: Record<string, CommandHandler> = {
  objective: handleObjectiveCommand,
  model: handleModelCommand,
  directive: handleDirectiveCommand,
  directives: handleDirectivesCommand,
  platform: handlePlatformCommand,
  platforms: handlePlatformsCommand,
  job: handleJobCommand,
  jobs: handleJobsCommand,
  automations: handleAutomationsCommand,
  channel: handleChannelCommand,
  channels: handleChannelsCommand,
  response: handleResponseCommand,
  responses: handleResponsesCommand,
  review: handleReviewCommand,
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

  // Hidden compatibility commands (not shown in suggestions/help)
  for (const [name, handler] of Object.entries(HIDDEN_COMMANDS)) {
    if (withoutSlash === name || withoutSlash.startsWith(name + ' ')) {
      const args = withoutSlash.slice(name.length).trim();
      handler(args, ctx);
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
  ctx.addSystemMessage(
    `Unknown command: /${cmdWord}\n` +
    'Type / to see command suggestions, then use ↑/↓ and Enter to pick one.',
  );
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
          { name: 'job add "schedule" prompt', description: 'Add a scheduled automation' },
          { name: 'job add "on <scope|platformN>" prompt', description: 'Add event-driven automation (triggers on channel messages)' },
          { name: 'job pause N', description: 'Pause automation #N' },
          { name: 'job resume N', description: 'Resume automation #N' },
          { name: 'job delete N', description: 'Delete automation #N' },
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
      } else if (name === 'rule') {
        results.push(
          { name: `${name} <text>`, description: 'Add a rule' },
          { name: `${name} toggle N`, description: 'Enable/disable rule #N' },
          { name: `${name} delete N`, description: 'Delete rule #N' },
        );
      } else if (name === 'channel') {
        results.push(
          {
            name: `${name} <platform> <scope> <perm>`,
            description: 'Add connection (Slack full support; Telegram/WhatsApp for event jobs)',
          },
          { name: `${name} delete N`, description: 'Remove channel connection #N' },
        );
      } else if (name === 'tools') {
        results.push(
          { name: 'tools', description: 'List available/enabled tools and current mode' },
          { name: 'tools mode off|confirm|auto', description: 'Set tool execution mode for this talk' },
          { name: 'tools allow add <tool>', description: 'Allow-list a tool for this talk' },
          { name: 'tools deny add <tool>', description: 'Deny-list a tool for this talk' },
          { name: 'tools auth status', description: 'Check Google Docs auth readiness' },
          { name: 'tools auth set-refresh <token>', description: 'Update Google refresh token for Docs tools' },
        );
      } else if (name === 'objectives') {
        results.push(
          { name: `${name} <text>`, description: 'Set one-sentence desired outcome for this talk' },
          { name: `${name} clear`, description: 'Clear objectives for this talk' },
        );
      } else if (name === 'reports') {
        results.push(
          { name: 'reports', description: 'Show recent automation reports for this talk' },
          { name: 'reports N', description: 'Show reports for automation #N' },
        );
      } else {
        results.push({ name, description: entry.description });
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
