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

#### Attempt 2

- Added a repo-native release stability analyzer at `tools/release-stability-lint.mjs`.
- The analyzer uses the TypeScript compiler API directly instead of delegating to ESLint.
- It reports processing load as files, lines, nodes, heap usage, and phase timings.
- It combines compiler diagnostics with custom release-oriented AST rules for ignored Promise executor returns, async functions without await, and object-like template interpolation.

#### What Improved

- Release validation now has a project-native path focused on application logic, not just generic style.
- The processing load of static analysis is now visible instead of implicit.
- The analyzer creates a stable place to add future release rules without trying to force everything through ESLint.

#### What Still Needs Work

- The first custom rule set is intentionally small; race-condition style checks are not yet modeled.
- The analyzer still needs a staged-only or frontier-only mode if we want to use it directly in send workflows.
- Findings should eventually be grouped into release blockers vs advisory findings.

#### Attempt 3

- Added a high-confidence `state-mutation-after-async-boundary` rule.
- The rule counts writes to likely shared state roots that happen after an `await`.
- The rule currently tracks roots such as `entry`, `state`, `checkpoint`, `progress`, `job`, `this.state`, and nested aliases such as `selection.modelA`.
- The analyzer now emits both the count and the processing load so the gate can be tuned over time.

#### Observed Gate Snapshot

```text
scope: release
files: 17
lines: 7878
nodes: 46933
heap_mb: ~1523.5
total_ms: ~19327.1

finding_counts:
  release/state-mutation-after-async-boundary: 56
  release/ts-diagnostic: 28
  release/no-object-stringify: 8
  release/no-async-without-await: 5
```

#### What Improved

- We now have a concrete high-confidence occurrence count for one release-risk pattern.
- The gate is measurable enough to tune rather than argue about abstractly.
- The output already points to the real hot zones: browser bridge ledger handling and model-league daemon state updates.

#### What Still Needs Work

- The async-mutation rule still counts each write site rather than grouping related bursts into one higher-level mutation cluster.
- The analyzer is still expensive enough that it should be treated as a release gate, not a hot inner-loop lint step.
- The next refinement should distinguish guarded mutations from unguarded ones so the count tracks actual remediation progress more closely.

#### Attempt 4

- Added branch-aware clustering to `tools/release-stability-lint.mjs`.
- Findings are now assigned to stabilization buckets such as:
  - `bridge/ledger-settlement-state-machine`
  - `bridge/snapshot-reconstruction-boundary`
  - `daemon/post-runner-settlement`
  - `daemon/operational-truth`
  - `typing/raw-request-union-boundary`
- The analyzer now prints `cluster_counts` alongside raw `finding_counts`.
- Fixed a linter false-positive path by treating `for await (...)` as a real async boundary.

#### Observed Gate Snapshot

```text
scope: release
files: 17
lines: 7878
nodes: 46933
heap_mb: ~1514.8
total_ms: ~11688.0

finding_counts:
  release/state-mutation-after-async-boundary: 56
  release/ts-diagnostic: 28
  release/no-object-stringify: 8
  release/no-async-without-await: 2

cluster_counts:
  daemon/post-runner-settlement: 28
  bridge/ledger-settlement-state-machine: 17
  daemon/operational-truth: 14
  bridge/snapshot-reconstruction-boundary: 5
  typing/raw-request-union-boundary: 5
```

#### What Improved

- The release gate now reports contact surfaces instead of only per-line noise.
- The highest-pressure stabilization zones are visible immediately: daemon post-runner settlement, bridge ledger settlement, and daemon operational truth.
- `no-async-without-await` false positives dropped from 5 to 2 after recognizing `for await` loops.

#### What Still Needs Work

- `state-mutation-after-async-boundary` is still counted per write site inside each bucket, so bucket totals remain bursty.
- One browser-bridge `no-async-without-await` finding remains uncategorized and should either be justified or normalized.
- The next refinement should distinguish guarded post-await mutations from unguarded ones so the bucket totals start reflecting remediation, not just surface area.

#### Attempt 5

- Refactored model-league daemon settlement to use a `frontier -> settled` pattern in `server/model-league/daemon.ts`.
- `runMatch` and `runBenchmark` now capture ids before `await runner.runBatch()` and restore live checkpoints, teams, progress, and state by id before mutating.
- `makeTrainingJob`, `start`, `stop`, and `tick` were also moved onto the same post-await restoration discipline.
- In parallel, browser bridge ledger settlement was rewritten to re-read the live ledger entry by `bridgeRequestId` after awaits.
- The request tracker now narrows `ChoiceRequest` structurally before touching `active`.

#### Observed Gate Snapshot

```text
scope: release
files: 17
lines: 8030
nodes: 47523
heap_mb: ~1518.5
total_ms: ~10784.2

finding_counts:
  release/ts-diagnostic: 22
  release/no-object-stringify: 8
  release/no-async-without-await: 2

cluster_counts:
  bridge/snapshot-reconstruction-boundary: 5
  daemon/boundary-contracts: 4
  transport/serialization-hygiene: 4
  typing/duplicate-normalization-frontiers: 4
  daemon/operational-truth: 3
  typing/perspective-side-projection: 3
  daemon/post-runner-settlement: 2
```

#### What Improved

- The async-mutation class dropped out of the current release snapshot entirely.
- `daemon/post-runner-settlement` collapsed from a dominant bucket to residual type-level issues in the runner.
- The raw request union boundary no longer leaks `request.active` assumptions through the tracker.
- Browser ledger settlement now uses live-entry revalidation rather than captured entry mutation.

#### What Still Needs Work

- The remaining dominant release work is type-shape cleanup, not async state settlement.
- `bridge/snapshot-reconstruction-boundary` is now the highest-pressure single branch.
- The analyzer still has one uncategorized `resolveModelServingKind` async warning that should either be normalized or exempted by rule design.

#### Attempt 6

- Recorded the canonical branch-artifacts path for `codex/model-feature-added` in the frontier artifact.
- Removed the stale duplicate artifact tree created by the earlier branch-name bug.
- Added explicit artifact hygiene notes to the analysis design so later agents do not rediscover the canonical path.

#### What Improved

- The docs now separate durable branch artifacts from temporary duplicate noise.
- The frontier artifact carries the keep-tracked / keep-ignored split as a durable note.

#### What Still Needs Work

- The branch-artifacts helper still needs a tiny discovery index if we want lookup by task family.
- The frontier note still depends on manual updates instead of automatic commit ingestion.

## Next Improvement Candidates

- Add a staged-only send mode for cases where the working tree is mixed.
- Add a compact publish summary command that reports discovery, reweighting, execution, and residual risk.
- Add a receive-test command that skips style and focuses on type and runtime blockers.
- Add a final pre-push note template that records what the attempt concretely improved.
- Extend release lint with state-mutation and concurrency rules aimed at daemon, bridge, and runner code.

## Tick Ledger

Start this ledger at zero from the scheduling change forward. Do not backfill old runs.

```text
ticks:
  local_validation: 0
  subagent_wait: 0
  integration: 0
```

Meaning:

- `local_validation`
  - release-lint
  - send-lint
  - targeted test or type gates
- `subagent_wait`
  - time spent waiting for delegated branches to return validated results
- `integration`
  - regrouping
  - commit shaping
  - artifact cleanup
  - push prep

### Tick Update Rule

- Add `+1` when a category becomes the dominant bottleneck in a pass.
- Add `+2` only when that category clearly consumed multiple avoidable reruns or a long blocked wait.
- Prefer undercounting to inflating the ledger.

## Scheduling Rule

Validation should be batched, not fired on every local edit.

```text
edit -> local branch check -> delegated branch check -> integration -> one fix:send sweep -> final release/send gate
```

Rules:

- Do not run `release-stability-lint` again until a coherent patch set lands.
- Do not run strict `lint:send` repeatedly during semantic cleanup.
- Use branch-scoped release-lint as the semantic stop condition inside worker branches.
- Reserve `fix:send` for the integrated dirty frontier, not each branch in isolation.
- Run broader tests only after release and send gates are stable enough to justify the cost.
