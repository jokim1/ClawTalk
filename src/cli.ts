#!/usr/bin/env node

/**
 * RemoteClaw CLI
 *
 * Entry point for the remoteclaw command
 */

import { Command } from 'commander';
import { loadConfig, saveConfig, resolveGatewayConfig, getConfigPath } from './config.js';
import type { BillingOverride } from './config.js';
import { ChatService } from './services/chat.js';
import { getStatus as getTailscaleStatus } from './services/tailscale.js';
import { launchRemoteClaw } from './tui/app.js';

const program = new Command();

program
  .name('remoteclaw')
  .description('Remote LLM chat TUI for Moltbot gateway')
  .version('0.1.0')
  .option('-g, --gateway <url>', 'Gateway URL (e.g. http://100.x.x.x:18789)')
  .option('-t, --token <token>', 'Gateway authentication token')
  .option('-m, --model <model>', 'Model to use (e.g. anthropic/claude-sonnet-4-5)')
  .option('-s, --session <name>', 'Session name to resume or create')
  .action(async (opts) => {
    const resolved = resolveGatewayConfig({
      gateway: opts.gateway,
      token: opts.token,
      model: opts.model,
    });

    // Auto-persist gateway/token to config when provided via CLI
    if (opts.gateway || opts.token) {
      const existing = loadConfig();
      if (opts.gateway) existing.gatewayUrl = opts.gateway;
      if (opts.token) existing.gatewayToken = opts.token;
      saveConfig(existing);
    }

    // Validate gateway is reachable before launching TUI
    const chatService = new ChatService({
      gatewayUrl: resolved.gatewayUrl,
      gatewayToken: resolved.gatewayToken,
      agentId: resolved.agentId || 'remoteclaw',
      model: resolved.defaultModel,
    });

    const healthy = await chatService.checkHealth();
    if (!healthy) {
      const tsStatus = getTailscaleStatus();

      console.error(`\nCannot reach gateway at ${resolved.gatewayUrl}\n`);

      switch (tsStatus) {
        case 'not-installed':
          console.error('Tailscale is not installed. Install it with: brew install tailscale');
          break;
        case 'not-running':
          console.error('Tailscale daemon is not running. Start it with: brew services start tailscale');
          break;
        case 'logged-out':
          console.error('Tailscale is not authenticated. Run: tailscale up');
          break;
        case 'connected':
          console.error(`Tailscale is connected but the gateway is unreachable at ${resolved.gatewayUrl}`);
          console.error(`  - Is the Moltbot gateway running on the remote machine?`);
          console.error(`  - Can you reach it? curl ${resolved.gatewayUrl}/health`);
          if (!resolved.gatewayToken) {
            console.error('  - Do you need an auth token? remoteclaw config --token <token>');
          }
          break;
      }
      console.error(`\nConfig file: ${getConfigPath()}`);
      console.error('Set gateway:  remoteclaw config --gateway <url>');
      console.error('Set token:    remoteclaw config --token <token>\n');
      process.exit(1);
    }

    await launchRemoteClaw({
      gatewayUrl: resolved.gatewayUrl,
      gatewayToken: resolved.gatewayToken,
      model: opts.model || resolved.defaultModel,
      sessionName: opts.session,
    });
  });

// Config subcommand
const configCmd = program
  .command('config')
  .description('View or update RemoteClaw configuration')
  .option('-g, --gateway <url>', 'Set gateway URL')
  .option('-t, --token <token>', 'Set gateway auth token')
  .option('-m, --model <model>', 'Set default model')
  .option('--billing <spec>', 'Set billing for a provider (provider:mode[:plan[:price]], e.g. anthropic:subscription:Max:200)')
  .option('--voice-auto-send', 'Auto-send after voice transcription (skip editing)')
  .option('--voice-auto-play', 'Auto-play TTS for assistant responses')
  .option('--voice-tts-voice <voice>', 'TTS voice (e.g. nova, alloy, echo, shimmer)')
  .option('--no-voice-auto-play', 'Disable TTS auto-play')
  .option('--show', 'Show current configuration')
  .action((opts) => {
    const config = loadConfig();
    let updated = false;

    if (opts.gateway) {
      config.gatewayUrl = opts.gateway;
      updated = true;
    }

    if (opts.token) {
      config.gatewayToken = opts.token;
      updated = true;
    }

    if (opts.model) {
      config.defaultModel = opts.model;
      updated = true;
    }

    if (opts.billing) {
      const parts = (opts.billing as string).split(':');
      const provider = parts[0];
      const mode = parts[1] as 'api' | 'subscription';

      if (!provider || !['api', 'subscription'].includes(mode)) {
        console.error('Invalid billing spec. Format: provider:mode[:plan[:price]]');
        console.error('  mode must be "api" or "subscription"');
        console.error('  Example: anthropic:subscription:Max:200');
        process.exit(1);
      }

      if (!config.billing) config.billing = {};

      if (mode === 'api') {
        delete config.billing[provider];
        if (Object.keys(config.billing).length === 0) delete config.billing;
      } else {
        const override: BillingOverride = { mode };
        if (parts[2]) override.plan = parts[2];
        if (parts[3]) override.monthlyPrice = Number(parts[3]);
        config.billing[provider] = override;
      }

      updated = true;
    }

    if (opts.voiceAutoSend !== undefined || opts.voiceAutoPlay !== undefined || opts.voiceTtsVoice) {
      if (!config.voice) config.voice = {};
      if (opts.voiceAutoSend !== undefined) config.voice.autoSend = true;
      if (opts.voiceAutoPlay === false) {
        config.voice.autoPlay = false;
      } else if (opts.voiceAutoPlay === true || opts.voiceAutoPlay !== undefined) {
        config.voice.autoPlay = true;
      }
      if (opts.voiceTtsVoice) config.voice.ttsVoice = opts.voiceTtsVoice;
      updated = true;
    }

    if (updated) {
      saveConfig(config);
      console.log('Configuration saved.\n');
    }

    // Always show config after update, or when --show is passed, or when no flags given
    if (updated || opts.show || (!opts.gateway && !opts.token && !opts.model && !opts.billing)) {
      console.log(`Config file: ${getConfigPath()}\n`);
      console.log(`  Gateway URL:   ${config.gatewayUrl}`);
      console.log(`  Gateway Token: ${config.gatewayToken ? '********' : '(not set)'}`);
      console.log(`  Default Model: ${config.defaultModel || '(not set)'}`);
      console.log(`  Agent ID:      ${config.agentId || 'remoteclaw'}`);
      if (config.billing && Object.keys(config.billing).length > 0) {
        console.log(`  Billing:`);
        for (const [provider, b] of Object.entries(config.billing)) {
          const details = b.mode === 'subscription'
            ? `${b.plan ?? 'Sub'} $${b.monthlyPrice ?? '?'}/mo`
            : 'API (per-token)';
          console.log(`    ${provider}: ${details}`);
        }
      } else {
        console.log(`  Billing:       (default API pricing)`);
      }
      if (config.voice) {
        console.log(`  Voice:`);
        console.log(`    Auto-send:   ${config.voice.autoSend ? 'on' : 'off'}`);
        console.log(`    Auto-play:   ${config.voice.autoPlay !== false ? 'on' : 'off'}`);
        if (config.voice.ttsVoice) console.log(`    TTS voice:   ${config.voice.ttsVoice}`);
        if (config.voice.ttsSpeed) console.log(`    TTS speed:   ${config.voice.ttsSpeed}`);
      }
      console.log('');
    }
  });

program.parse();
