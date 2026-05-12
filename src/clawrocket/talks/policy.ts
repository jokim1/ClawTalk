export const TALK_POLICY_MAX_AGENTS = 12;

function parsePolicyAgentCandidates(
  rawPolicy: string,
  maxItems: number,
): string[] {
  let candidates: unknown[] = [];
  try {
    const parsed = JSON.parse(rawPolicy) as unknown;
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const asRecord = parsed as Record<string, unknown>;
      if (Array.isArray(asRecord.agents)) {
        candidates = asRecord.agents;
      } else if (Array.isArray(asRecord.models)) {
        candidates = asRecord.models;
      } else {
        candidates = [asRecord.agent, asRecord.model];
      }
    } else if (typeof parsed === 'string') {
      candidates = [parsed];
    }
  } catch {
    candidates = rawPolicy.split(/[|,]/);
  }

  return [
    ...new Set(
      candidates
        .map((candidate) =>
          typeof candidate === 'string' ? candidate.trim() : '',
        )
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

export function parsePolicyAgentsForExecution(
  llmPolicy: string | null,
): string[] {
  const raw = llmPolicy?.trim();
  if (!raw) return [];
  return parsePolicyAgentCandidates(raw, TALK_POLICY_MAX_AGENTS);
}

export function parsePolicyAgentsForUiBadges(
  llmPolicy: string | null,
  maxBadges: number,
): string[] {
  const raw = llmPolicy?.trim();
  if (!raw) return [];
  return parsePolicyAgentCandidates(raw, maxBadges);
}
