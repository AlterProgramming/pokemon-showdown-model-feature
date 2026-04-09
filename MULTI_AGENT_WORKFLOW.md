# Multi-Agent Workflow

This note captures the coordination rules that have been working well for this repo when multiple mini-agents are helping with the same problem.

## 1. Use Mini Agents For Narrow Questions

- Give each mini agent one bounded question or one small file slice.
- Prefer read-only investigation, localization, and verification tasks.
- Keep the ask concrete enough that the agent can finish without needing the whole conversation history.

## 2. Keep Ownership Clear

- Explicitly assign files or responsibility before an edit task starts.
- Treat other agents' changes as intentional unless a file clearly conflicts with the current task.
- Do not revert another agent's edits just because they look unfamiliar.
- If two agents are likely to touch the same file, pause and coordinate first.

## 3. Prefer A Team Shape

- Use one agent to observe, one to propose, and one to integrate when the work is broad.
- Let mini agents handle local details and let one synthesis pass make the final call.
- If the work becomes cross-cutting or stateful, stop adding more parallel edits and switch to integration mode.

## 4. Prefer The Mini Variant

- When delegating helper work, use the mini variant of the current model family by default.
- For example, if the main thread is using `gpt-5.4`, prefer `gpt-5.4-mini` for narrow delegated tasks.
- Only use a stronger delegate when the task genuinely needs broader reasoning or synthesis.
- A mini agent should feel like a lower-topology helper, not a second equal-power copy of the main thread.

## 5. When To Avoid Delegation

- Do not delegate urgent blocking work that the next step depends on.
- Keep tightly coupled fixes local when the implementation depends on a lot of shared context.
- If the task is mostly one file and one obvious fix, it is usually faster to do it directly.

## 6. Protect The Source Of Truth

- Re-read the relevant source files before changing behavior.
- Prefer code over memory when the behavior is unclear.
- If logs, screenshots, or recordings conflict with the code, inspect the current code path first, then use the artifact to confirm the runtime behavior.

## 7. Good Review Loop

1. Mini agents gather evidence.
2. One synthesis pass identifies the real issue.
3. The patch is small and focused.
4. Tests verify the change.
5. When possible, delegate the test run to a separate mini runner so the main thread keeps a clean context and the verification gets an independent sanity check.
6. If the result still looks odd, repeat with a narrower question.

## 8. Signs The Task Has Drifted

- The conversation keeps re-explaining the same context.
- Multiple agents are touching the same code path without a clear reason.
- The fix is getting broader than the symptom.
- You are spending more time coordinating than learning something new.

When that happens, stop widening the search and shrink the question.
