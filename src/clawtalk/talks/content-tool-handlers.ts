// Tool handlers for the Content feature.
//
// `propose_content_append` is the agent-facing surface for proposing a
// new block into the Talk's attached document. The user accepts or
// rejects via the ProposalCard UI (PR 6); the accept path applies the
// patch with CAS + drift detection.

import { createProposal, getContentByTalkId } from '../db/content-accessors.js';

export interface ProposeContentAppendInput {
  talkId: string;
  userId: string;
  runId: string | null;
  agentId: string | null;
  messageId?: string | null;
  args: Record<string, unknown>;
}

export type ToolResult = {
  result: string;
  isError?: boolean;
};

export async function executeProposeContentAppend(
  input: ProposeContentAppendInput,
): Promise<ToolResult> {
  const rawAnchor = input.args.after_anchor_id;
  const rawMarkdown = input.args.markdown;
  const rawRationale = input.args.rationale;

  if (typeof rawMarkdown !== 'string' || rawMarkdown.trim().length === 0) {
    return {
      result:
        'Error: propose_content_append requires a non-empty `markdown` string.',
      isError: true,
    };
  }
  if (
    rawAnchor !== null &&
    rawAnchor !== undefined &&
    typeof rawAnchor !== 'string'
  ) {
    return {
      result:
        'Error: `after_anchor_id` must be a string anchor ID, or null to prepend at the top.',
      isError: true,
    };
  }
  if (
    rawRationale !== null &&
    rawRationale !== undefined &&
    typeof rawRationale !== 'string'
  ) {
    return {
      result: 'Error: `rationale` must be a string when provided.',
      isError: true,
    };
  }

  const content = await getContentByTalkId(input.talkId);
  if (!content) {
    return {
      result:
        'Error: this Talk has no attached document. Cannot propose an append.',
      isError: true,
    };
  }

  const afterAnchorId =
    typeof rawAnchor === 'string' && rawAnchor.length > 0 ? rawAnchor : null;

  const result = await createProposal({
    contentId: content.id,
    ownerId: content.ownerId,
    kind: 'append',
    afterAnchorId,
    insertedMarkdown: rawMarkdown,
    rationale: typeof rawRationale === 'string' ? rawRationale : null,
    proposedByRunId: input.runId,
    proposedByAgentId: input.agentId ?? null,
    proposedByMessageId: input.messageId ?? null,
  });

  switch (result.kind) {
    case 'content_not_found':
      return {
        result: 'Error: the attached document was not found.',
        isError: true,
      };
    case 'anchor_missing':
      return {
        result: `Error: anchor "${result.anchorId}" is not in the current document. Re-read the outline and propose against a current anchor.`,
        isError: true,
      };
    case 'doc_size_limit':
      return {
        result: `Error: the proposed markdown would push the document past the size limit (would be ${result.wouldBeBytes} bytes).`,
        isError: true,
      };
    case 'ok':
      return {
        result: JSON.stringify({
          proposalId: result.proposal.id,
          status: result.proposal.status,
          afterAnchorId: result.proposal.afterAnchorId,
          contentId: content.id,
        }),
      };
  }
}
