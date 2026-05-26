// Tests for content_edits accessors + apply handler.
//
// NOTE — these tests reference the `content_edits` table which is not
// created until commit 8 of the direct-edit redesign (plan Section H).
// Currently SKIPPED with `it.skip` so the file typechecks and runs in
// CI without exercising DB. Commit 8 un-skips them when the migration
// lands.
//
// Coverage (un-skip these in commit 8):
//   - acceptPendingEdit materializes a single edit into body_markdown,
//     deletes the row, CAS-bumps body_version.
//   - rejectPendingEdit deletes the row, body unchanged, no CAS bump.
//   - acceptPendingRun materializes all edits in created_at order,
//     deletes all rows, single CAS bump.
//   - rejectPendingRun deletes all rows for the run, no body change.
//   - materializeEdits correctness across insert/replace/delete/bulk.
//   - 404 on already-deleted row (sibling auto-accept).
//   - version_conflict on stale expectedContentVersion.

import { describe, it } from 'vitest';

describe('content-edits-accessors (postgres + RLS) — SKIPPED until commit 8', () => {
  it.skip('acceptPendingEdit materializes the edit and CAS-bumps body_version', () => {
    // Implemented in commit 8 once content_edits table exists.
  });
  it.skip('rejectPendingEdit deletes the row without touching body', () => {
    // Implemented in commit 8.
  });
  it.skip('acceptPendingRun materializes all run edits + single CAS bump', () => {
    // Implemented in commit 8.
  });
  it.skip('rejectPendingRun deletes all run rows without touching body', () => {
    // Implemented in commit 8.
  });
  it.skip('auto-accept-prior on new runId materializes prior + inserts new in one tx', () => {
    // Implemented in commit 8.
  });
  it.skip('same-run repeated calls collapse per the plan Section C table', () => {
    // Implemented in commit 8.
  });
  it.skip('anchor_missing on replace/delete returns isError', () => {
    // Implemented in commit 8.
  });
  it.skip('doc_size_limit on oversize markdown returns isError', () => {
    // Implemented in commit 8.
  });
  it.skip('version_conflict on stale expectedContentVersion (accept only)', () => {
    // Implemented in commit 8.
  });
  it.skip('404 not_found when sibling auto-accept already deleted the row', () => {
    // Implemented in commit 8.
  });
});
