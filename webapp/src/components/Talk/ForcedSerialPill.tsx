// Tiny inline pill rendered below the just-sent user message when the
// server forced serial routing because the turn was an @doc edit on a
// Talk with multiple agents (plan D7). Dismisses with the next user
// turn — that's the parent's responsibility (don't pass the prop in).

import { Info } from 'lucide-react';

export function ForcedSerialPill(): JSX.Element {
  return (
    <div
      className="forced-serial-pill"
      role="note"
      aria-label="Doc-edit serialization notice"
    >
      <Info size={12} aria-hidden="true" />
      <span>Routing agents serially for this @doc edit.</span>
    </div>
  );
}
