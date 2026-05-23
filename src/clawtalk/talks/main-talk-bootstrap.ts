/**
 * main-talk-bootstrap.ts — idempotent provisioning of the per-user
 * "Main" system Talk.
 *
 * Triggered lazily from /api/v1/session/me on every authenticated page
 * load. Fast-path: a single SELECT confirms the user already has a
 * system Talk and the function returns. Slow path (first sign-in): we
 * create the Talk with is_system = true, attach the workspace default
 * Talk agent if one is configured, and seed a welcome system message
 * whose checklist is tailored to the user's current setup state.
 *
 * Must run inside withUserContext(userId, ...) so RLS scopes every
 * write to the calling user — the talks.is_system partial unique index
 * (owner_id where is_system = true) then guards against double-creates
 * if two probes race.
 */

import { getDbPg } from '../../db.js';
import {
  createTalk,
  createTalkMessage,
  getOrCreateDefaultThread,
} from '../db/accessors.js';
import { getDefaultTalkAgentIdOrNull } from '../agents/agent-registry.js';
import { getRegisteredAgent } from '../db/agent-accessors.js';
import { setTalkAgents } from '../db/talk-agents.js';

interface SetupChecklist {
  hasProviderKey: boolean;
  hasRegisteredAgent: boolean;
  hasTalk: boolean;
}

export async function ensureMainTalkForUser(userId: string): Promise<string> {
  const db = getDbPg();
  const existing = await db<Array<{ id: string }>>`
    select id
    from public.talks
    where is_system = true
      and owner_id = ${userId}::uuid
    limit 1
  `;
  if (existing[0]) return existing[0].id;

  const talk = await createTalk({
    ownerId: userId,
    topicTitle: 'Main',
    isSystem: true,
  });

  const threadId = await getOrCreateDefaultThread({
    talkId: talk.id,
    ownerId: userId,
  });

  await attachDefaultAgent(talk.id, userId);

  const checklist = await loadSetupChecklist(userId, talk.id);
  await createTalkMessage({
    ownerId: userId,
    talkId: talk.id,
    threadId,
    role: 'system',
    content: buildWelcomeMessage(checklist),
    createdBy: null,
  });

  return talk.id;
}

async function attachDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  // Best-effort: a fresh workspace may have no agents configured yet.
  // The Talk still exists; the user can attach an agent later via the
  // Talk settings UI.
  let agentId: string | null;
  try {
    agentId = await getDefaultTalkAgentIdOrNull();
  } catch {
    return;
  }
  if (!agentId) return;

  const agent = await getRegisteredAgent(agentId);
  if (!agent || !agent.enabled) return;

  await setTalkAgents({
    talkId,
    ownerId,
    agents: [
      {
        id: agent.id,
        sourceKind: 'provider',
        providerId: agent.provider_id,
        modelId: agent.model_id,
        nickname: null,
        nicknameMode: 'auto',
        personaRole: agent.persona_role ?? 'assistant',
        isPrimary: true,
        sortOrder: 0,
      },
    ],
  });
}

async function loadSetupChecklist(
  userId: string,
  newTalkId: string,
): Promise<SetupChecklist> {
  const db = getDbPg();
  // Personal + workspace-shared keys both count — the executor falls
  // back to whichever is available.
  const [personalKey, workspaceKey, agent, talk] = await Promise.all([
    db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.llm_provider_secrets
      where owner_id = ${userId}::uuid
    `,
    db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.workspace_provider_secrets
    `,
    db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.registered_agents
      where owner_id = ${userId}::uuid and enabled = true
    `,
    db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.talks
      where owner_id = ${userId}::uuid
        and is_system = false
        and id <> ${newTalkId}::uuid
    `,
  ]);

  return {
    hasProviderKey:
      (personalKey[0]?.count ?? 0) > 0 || (workspaceKey[0]?.count ?? 0) > 0,
    hasRegisteredAgent: (agent[0]?.count ?? 0) > 0,
    hasTalk: (talk[0]?.count ?? 0) > 0,
  };
}

function buildWelcomeMessage(checklist: SetupChecklist): string {
  const intro =
    'Welcome to ClawTalk!\n\n' +
    'This is your **Main** channel — a built-in space for setup guidance, ' +
    'release notes, and a general-purpose assistant you can ask anything about your workspace.';

  const items: string[] = [];
  if (!checklist.hasProviderKey) {
    items.push(
      "- [ ] **Add an LLM provider key** — open Settings → Providers and paste a key for at least one provider (Anthropic, OpenAI, Gemini, or NVIDIA). Without one, agents can't run.",
    );
  }
  if (!checklist.hasRegisteredAgent) {
    items.push(
      '- [ ] **Register an AI agent** — Settings → AI Agents. Pick a provider, choose a model, and give the agent a name. You can register as many as you like.',
    );
  }
  if (!checklist.hasTalk) {
    items.push(
      '- [ ] **Start your first Talk** — use the **+** button in the sidebar. Talks are where you bring multiple agents together around a single topic.',
    );
  }

  if (items.length === 0) {
    return (
      `${intro}\n\n` +
      "Your setup looks good — you've got a provider, an agent, and at least one Talk going. " +
      "Drop questions here any time; this channel is also where I'll post release notes as ClawTalk evolves."
    );
  }

  return (
    `${intro}\n\n` +
    "Here's what's left to set up:\n\n" +
    items.join('\n') +
    '\n\nOnce those are squared away, this channel will also be where ' +
    "you'll see release notes and any maintenance suggestions."
  );
}
