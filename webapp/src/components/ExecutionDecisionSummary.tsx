import type { ExecutionDecision } from '../lib/api';

function getExecutionBackendLabel(
  executionDecision: ExecutionDecision,
): string {
  switch (executionDecision.backend) {
    case 'container':
      return 'Container';
    case 'host_codex':
      return 'Codex host';
    default:
      return 'Direct';
  }
}

function getExecutionAuthLabel(executionDecision: ExecutionDecision): string {
  switch (executionDecision.authPath) {
    case 'subscription':
      return 'subscription';
    case 'api_key':
      return 'API key';
    case 'host_login':
      return 'host login';
    case 'none':
      return 'no auth';
  }
}

export function ExecutionDecisionSummary({
  executionDecision,
}: {
  executionDecision?: ExecutionDecision | null;
}) {
  if (!executionDecision) return null;
  return (
    <div className="execution-decision-summary">
      <p>
        <strong>Execution:</strong> {getExecutionBackendLabel(executionDecision)}{' '}
        via {getExecutionAuthLabel(executionDecision)} ·{' '}
        {executionDecision.credentialSource}
      </p>
      <p>{executionDecision.plannerReason}</p>
    </div>
  );
}
