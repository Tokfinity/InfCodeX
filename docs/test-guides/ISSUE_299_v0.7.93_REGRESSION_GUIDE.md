# Issue 299 Previous-Boot Windows ACL Settlement Regression Guide

## Automated checks

1. Two foreign markers from previous Windows boots, split across ProgramData
   and the configured legacy home, cause one lock-scoped native ACL recovery.
   The recovered scope and repair fact are durably recorded before a second
   lock-scoped recheck removes both markers.
2. A set containing a current-boot marker, an identity-free marker, a
   noncanonical boot identity, or corrupt marker data remains blocked with zero
   ACL mutation.
3. Native recovery failure preserves every marker for an idempotent retry.
4. A changed-boot Runtime exit ticket uses the previous-boot recovery path,
   never signals a reused PID, and returns `recovered` with
   `windows_sandbox_acl`.
5. Same-boot settlement continues to require exact owner/process identity and
   Job containment; foreign markers remain fail-closed.
6. A crash after native recovery but before marker clear resumes from the
   durable `previous-boot` scope without losing or repeating the repair fact.
7. A current-boot marker introduced before the clear recheck retains the entire
   marker set and blocks cleanup.
8. If Windows restarts again after recovery was recorded but before clear,
   settlement repeats native recovery on the new boot and updates the durable
   recovery-boot identity before removing markers.

## Windows manual acceptance

1. Create two test ACL markers through separate isolated KodaX owners, retain a
   pending Runtime exit ticket, and restart Windows.
2. Launch the host normally. Verify settlement completes before owner
   reconciliation and no Setup/UAC prompt appears.
3. Repeat without restarting Windows. Verify the host remains blocked and does
   not delete either marker or start a replacement Runtime.
4. Repeat with one marker missing its boot identity. Verify the same fail-closed
   result and retain the diagnostic evidence.
