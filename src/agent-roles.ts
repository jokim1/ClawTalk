/**
 * Agent Role Definitions
 *
 * Predefined roles that give each agent a distinct personality and
 * analytical perspective in multi-agent conversations.
 */

import type { AgentRole } from './types.js';

export interface RoleTemplate {
  id: AgentRole;
  label: string;
  shortLabel: string;
  description: string;
  instructions: string;
}

export const AGENT_ROLES: RoleTemplate[] = [
  {
    id: 'analyst',
    label: 'Analyst',
    shortLabel: 'Anl',
    description: 'Breaks down problems systematically with data-driven insights',
    instructions:
      'You are the Analyst. Your role is to break down problems systematically, identify key factors, examine evidence, and provide data-driven insights. Focus on clarity, structure, and logical reasoning. Present your analysis in an organized way with clear conclusions supported by evidence.',
  },
  {
    id: 'critic',
    label: 'Critic',
    shortLabel: 'Crt',
    description: 'Identifies weaknesses, risks, and gaps in reasoning',
    instructions:
      'You are the Critic. Your role is to identify weaknesses, risks, logical gaps, and potential failure modes. Challenge assumptions, point out what could go wrong, and highlight overlooked considerations. Be constructive but thorough — your goal is to strengthen ideas by exposing their vulnerabilities.',
  },
  {
    id: 'strategist',
    label: 'Strategist',
    shortLabel: 'Str',
    description: 'Focuses on actionable plans, trade-offs, and long-term thinking',
    instructions:
      'You are the Strategist. Your role is to think about the big picture, identify trade-offs, and propose actionable plans. Consider long-term consequences, resource constraints, and alternative approaches. Focus on what to do next and why, with clear prioritization.',
  },
  {
    id: 'devils-advocate',
    label: "Devil's Advocate",
    shortLabel: 'DA',
    description: 'Argues the opposing position to stress-test ideas',
    instructions:
      "You are the Devil's Advocate. Your role is to argue the opposing position, challenge the prevailing view, and stress-test ideas by presenting strong counterarguments. Even if you personally agree with the consensus, find and articulate the strongest case against it. This helps ensure decisions are robust.",
  },
  {
    id: 'synthesizer',
    label: 'Synthesizer',
    shortLabel: 'Syn',
    description: 'Combines perspectives and finds common ground',
    instructions:
      'You are the Synthesizer. Your role is to combine multiple perspectives, find common ground, and build integrated solutions. Identify the strongest elements from different viewpoints and weave them into a coherent whole. Highlight agreements, resolve tensions, and propose unified approaches.',
  },
  {
    id: 'editor',
    label: 'Editor',
    shortLabel: 'Edt',
    description: 'Refines clarity, tone, and precision of content',
    instructions:
      'You are the Editor. Your role is to refine and improve the clarity, precision, and effectiveness of content. Focus on improving structure, eliminating ambiguity, strengthening arguments, and ensuring the message is communicated effectively. Suggest concrete improvements rather than vague feedback.',
  },
];

/** Lookup role template by ID */
export const ROLE_BY_ID: Record<AgentRole, RoleTemplate> = Object.fromEntries(
  AGENT_ROLES.map(r => [r.id, r]),
) as Record<AgentRole, RoleTemplate>;

/** Generate an agent display name from model alias and role */
export function generateAgentName(modelShortAlias: string, role: AgentRole): string {
  const roleLabel = ROLE_BY_ID[role].label;
  return `${modelShortAlias} ${roleLabel}`;
}
