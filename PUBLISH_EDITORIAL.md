# Publish Editorial

This document keeps the compact publish plan honest.
It is not just a checklist. It is an editorial standard for how changes
should be prepared, tested, and sent.

## Compact Publish Plan

```text
discovery:
  inspect branch state
  inspect send-scope files
  inspect the smallest relevant validation path

reweight:
  separate receive debt from send debt
  identify the strict checks that apply to the outgoing delta
  decide what quality bar can be advanced in this attempt

execute:
  run the send gate
  stage only intended files
  commit with a precise message
  push only after the attempt has actually tried to improve quality
```

## Editorial Standard

- A publish attempt must improve something concrete: validation clarity, send hygiene, documentation, correctness, or operational reliability.
- A publish attempt must not hide behind receive debt if the outgoing delta can still be made cleaner.
- A publish attempt should prefer a smaller, defensible improvement over a larger vague one.
- A publish attempt should record what was tried, what held, and what remains rough.
- A publish attempt that discovers a blocker should still leave behind a better map of the blocker.

## Attempt Rule

Each attempt must try.

That means:

- Do not publish with a passive summary when one more targeted check, cleanup, or clarification is available.
- Do not treat "already passing" as the end of thought; look for one compact improvement in the send path.
- Do not widen scope just to look busy. The attempt should be real, not theatrical.

## Running Improvements

### 2026-04-09

#### Attempt 1

- Split lint behavior into receive and send paths.
- Receive lint now tolerates style drift from synced code.
- Send lint now runs strict checks only on the current send-scope frontier.
- Added a dedicated PowerShell send runner so the send gate works in this sandbox without relying on Node spawning `git`.

#### What Improved

- Publish scope is clearer.
- Strict style is preserved for outbound changes.
- Incoming style debt no longer blocks all validation by default.

#### What Still Needs Work

- Receive lint still fails on non-style logic and type-related lint issues in model-related files.
- Full test execution is still blocked by those deeper issues and by sandbox restrictions around the test bootstrap path.
- The send runner currently defines scope from `git status`; it could later learn finer distinctions such as staged-only mode.

## Next Improvement Candidates

- Add a staged-only send mode for cases where the working tree is mixed.
- Add a compact publish summary command that reports discovery, reweighting, execution, and residual risk.
- Add a receive-test command that skips style and focuses on type and runtime blockers.
- Add a final pre-push note template that records what the attempt concretely improved.
