# Analysis Tooling Design

This document collects the design for the next repo-native tooling layer that
supports release stabilization, branch-local reasoning, and delegated agent
work.

## Goals

- Provide graph-shaped search over the TypeScript codebase.
- Make release-lint buckets traceable back to contact surfaces and owners.
- Surface post-`await` mutation risk in terms of state roots and settlement
  blocks.
- Preserve compact branch-local maps so later passes do not restart from zero.
- Support branch-scoped validation, feedback capture, and validated-branch
  commit flow for delegated work.

## Design Branches

- Graph Search And Bucket Anchors
- Async Mutation And State-Surface Analysis
- Seam Maps And Type-Flow Queries
- Analyzer UX And Branch Workflow
- Persistent Compact Maps And Delegation Artifacts

## Synthesis

### System Shape

The proposed system is one repo-native analysis stack with five cooperating
subsystems:

1. `codegraph`
2. `stategraph`
3. `typeflow-map`
4. `release-stability-lint`
5. `branch-artifacts`

The intent is not to build five unrelated tools. The intent is to share one
TypeScript program/index and expose different query/report layers over it.

```text
tsconfig -> shared TS program/index
        -> codegraph
        -> stategraph
        -> typeflow-map
        -> release-stability-lint
        -> branch-artifacts
```

### 1. `codegraph`

Purpose:
- fast symbol/import/call contact graph over repo TS files
- branch-scoped graph queries
- bucket-to-line anchor lookup for release findings

Core outputs:
- `file -> imported symbols -> local callers -> outbound IO touchpoints`
- `cluster -> files -> line anchors -> likely owner`

Example queries:
```text
codegraph contacts server/browser-model-bridge.ts
codegraph callers normalizeBrowserModelRequest
codegraph bucket bridge/snapshot-reconstruction-boundary
codegraph branch --base upstream/master --head HEAD
```

Useful result shape:
```json
{
  "bucket": "bridge/snapshot-reconstruction-boundary",
  "anchors": [
    {"file": "server/browser-model-bridge.ts", "line": 680, "kind": "request-boundary"},
    {"file": "server/browser-model-bridge.ts", "line": 687, "kind": "snapshot-encoding"}
  ],
  "contacts": [
    "sim/tools/protocol-state-tracker.ts",
    "sim/tools/rl-action-helpers.ts"
  ]
}
```

### 2. `stategraph`

Purpose:
- extract durable state roots from interfaces and classes
- map post-`await` mutations back to state roots and settlement blocks
- roll those results back into release buckets

Core outputs:
- `state root -> readers -> writers -> async boundaries`
- `settlement block -> captured objects -> post-await writes`

Target use cases:
- `ModelLeagueState` field ownership
- daemon settlement blocks
- browser request-ledger settlement

Example queries:
```text
stategraph roots server/model-league/types.ts
stategraph async-mutations server/model-league/daemon.ts
stategraph settlement daemon/post-runner-settlement
```

Useful result shape:
```json
{
  "root": "ModelLeagueState.checkpoints",
  "writers": [
    {"file": "server/model-league/daemon.ts", "function": "runMatch", "phase": "post-await"}
  ],
  "settlementBlocks": [
    {
      "function": "runMatch",
      "captured": ["selection.modelA", "selection.teamA"],
      "restoredById": true
    }
  ]
}
```

### 3. `typeflow-map`

Purpose:
- map `raw type -> normalized type -> downstream consumer`
- answer union-field access questions quickly
- preserve seam maps for repeated work

Core outputs:
- normalization seam table
- union-field access table
- downstream consumer map

Target use cases:
- `ChoiceRequest.active` access sites
- `SideID -> 'p1' | 'p2'` assumption sites
- RL request projection seams

Example queries:
```text
typeflow-map seam --from ChoiceRequest
typeflow-map union-field --type ChoiceRequest --field active
typeflow-map consumers --symbol buildLegalSwitchTargets
```

Useful result shape:
```json
{
  "rawType": "ChoiceRequest",
  "normalizedType": "NormalizedRLRequest",
  "seamFunction": "normalizeBrowserModelRequest",
  "consumers": [
    "sim/tools/protocol-state-tracker.ts#applyRequest",
    "sim/tools/rl-agent.ts#receiveRequest",
    "server/browser-model-bridge.ts#deriveLegalMoves"
  ]
}
```

### 4. `release-stability-lint`

Purpose:
- evolve from repo-scope release checks into a branch-aware gate
- produce scoped findings, bucket ledgers, and owner/action plans
- drive delegated validation and commit decisions

Recommended CLI surface:
```text
npm run lint:release -- --scope branch --base upstream/master --head HEAD
npm run lint:release -- --scope branch --changed-only --format compact
npm run lint:release -- --scope branch --format json --report-out .codex/release-report.json
npm run lint:release -- --owners tools/release-buckets.json
```

Recommended pipeline:
```text
discover changed files
-> scope findings
-> assign cluster
-> resolve owner
-> print compact summary
-> emit json report
-> mark commit-ready / validate-only
```

Example owner map:
```json
{
  "daemon/post-runner-settlement": {
    "owner": "Wegener",
    "priority": "high",
    "nextAction": "restore settlement state by id after await"
  },
  "typing/duplicate-normalization-frontiers": {
    "owner": "Planck",
    "priority": "medium",
    "nextAction": "normalize at adapter boundary"
  }
}
```

### 5. `branch-artifacts`

Purpose:
- store compact branch-local maps so later passes do not restart from zero
- keep branch ownership, seam state, validated commits, and feedback deltas

Suggested storage:
```text
.codex/branch-artifacts/<repo>/<branch>/<task-id>/
  state.json
  summary.md
  feedback.log
```

Suggested `state.json` shape:
```json
{
  "taskId": "release-lint-daemon-boundary",
  "repo": "pokemon-showdown",
  "branch": "codex/model-feature-added",
  "owner": "DaemonBoundary",
  "status": "active",
  "topology": [
    {"node": "server/model-league/config.ts", "role": "boundary-normalization"},
    {"node": "server/model-league/webhooks.ts", "role": "ingress/egress-contract"},
    {"node": "server/model-league/daemon.ts", "role": "settlement"}
  ],
  "seams": [
    {"from": "config.ts", "to": "daemon.ts", "contract": "requiredWinRate normalized to number"}
  ],
  "openRisks": [
    "runner type drift still unresolved"
  ],
  "validatedCommits": [
    {
      "sha": "abc123",
      "scope": ["server/model-league/config.ts"],
      "invariant": "benchmark rate is numeric before range checks"
    }
  ]
}
```

Lifecycle:
```text
init -> discover -> delegate -> validate -> commit -> compact -> handoff
```

Artifact hygiene:
- keep canonical artifacts under the full branch slug, such as `codex-model-feature-added`
- treat duplicate branch-name trees like `model-feature-added` as temporary noise
- keep durable artifacts tracked only when they represent the canonical branch-local state
- keep scratch trees and regeneration leftovers ignored or removed

### Shared Data Model

All five subsystems should share one compact vocabulary:

- `bucket`: a release-stability cluster
- `owner`: current branch owner or responsible agent
- `anchor`: file/line range backing a bucket
- `stateRoot`: durable mutable state surface
- `seam`: raw-to-normalized or boundary contract
- `validatedCommit`: commit tied to an explicit invariant

That shared vocabulary is what lets the graph tools, analyzer, and artifact
store talk to each other.

### Agent Workflow Integration

Recommended delegated loop:

```text
load branch artifact
-> run branch-scoped release lint
-> resolve owner + anchors
-> inspect seam/state graph
-> patch one branch-local invariant
-> re-run validation
-> if validated, branch owner commits
-> append feedback delta
-> compact artifact state
```

This matches the current operating rule:
- disjoint branch ownership
- validated-branch commit by the owning agent
- compact feedback after each branch

### Rollout Order

#### Slice 1

- Add branch-scoped mode and JSON output to `release-stability-lint`
- Add bucket-owner lookup
- Add compact branch summary output

This is the smallest slice with immediate operational value.

#### Slice 2

- Build `typeflow-map` union-field queries
- Add seam maps for raw request / normalized request flows

This should cut the current type-shape cleanup cost the fastest.

#### Slice 3

- Build `stategraph` state-root extraction
- Add post-`await` mutation grouping by settlement block

This is the next release-stability multiplier after type seams.

#### Slice 4

- Build `codegraph` contact queries and bucket anchors
- Add branch-scoped graph summaries

This reduces repeated manual topology reconstruction.

#### Slice 5

- Add `branch-artifacts`
- Persist topology, seam, validation, feedback, and commit state

This makes multi-turn delegated work cumulative instead of repetitive.

### Immediate Recommendation

Build Slice 1 and Slice 2 first.

Why:
- they are smallest
- they directly answer the feedback the agents repeated most often
- they strengthen the current release workflow before broadening the tool
  surface

That means the next concrete implementation target should be:

1. branch-scoped `release-stability-lint`
2. bucket-owner report output
3. `typeflow-map` query for union-field access and seam summaries
