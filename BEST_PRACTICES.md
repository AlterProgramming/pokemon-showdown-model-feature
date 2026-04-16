# Best Practices

This note is for humans and mini-models working together on this repo.
It is meant to keep the work feeling like a team effort and to keep the
debugging loop focused.

## 1. Work Like A Teammate

- Assume other agents' edits are intentional unless the file clearly conflicts.
- Treat each thread reply like a task on the board, not as isolated chatter.
- Keep momentum by finishing one small useful thing before widening scope.
- If you need help, ask for one narrow thing instead of re-explaining the whole project.

## 2. Read Before You Reach

- Re-read the current source before editing it.
- Trust code, logs, screenshots, and recordings over memory.
- If the runtime behavior disagrees with the code, treat that as a clue, not a contradiction.
- Prefer the smallest patch that explains the observed behavior.

## 3. Keep Ownership Clear

- Give one agent one question or one file slice.
- Do not overlap edits unless the task truly requires it.
- If someone else is already changing the same area, coordinate before touching it.
- Do not delete or “simplify” another agent's work just because it looks unfamiliar.
- Keep agent nicknames in the agent roster, and keep those separate from the repo's real contributor names.

## 4. Make The State Obvious

- Prefer clear status text over vague status text.
- Keep logs readable and short enough to scan.
- If a UI element is there to guide the user, it should be stable and easy to interpret.
- Avoid noisy flicker, repeated re-renders, and conflicting overlays.
- For turn-based automation, treat each `bridge_request_id` as one-and-done: do not re-send the same turn after a terminal response.

## 5. Use The Right Model For The Right Step

- Mini models are best for local reading, extraction, and verification.
- Larger models are best for synthesis when many pieces need to be stitched together.
- Do not spend a big pass on a question that can be answered by one targeted read.
- When a task stops teaching you something new, shrink the question.
- If the current model family has a mini variant, use that mini delegate by default for helper work.
- Only reach for a stronger delegate when the task truly needs more breadth or reasoning depth.

## 6. Verify Early

- After each meaningful change, run the smallest useful test.
- If the narrow test is green, stop there before widening to the full suite.
- If a bug appears in a recording or screenshot, confirm the live code path before reworking unrelated pieces.
- Keep a note of the exact file and line when you discover the issue.
- When you run tests, prefer a separate mini runner so verification stays independent and the main thread keeps a cleaner context.

## 7. If The Work Feels Slippery

- Pause and define the next observation.
- Ask what evidence would actually change the conclusion.
- Cut the scope until the next step is obvious.
- Prefer one clean fix over three partial ones.

## 8. What Good Looks Like

- The code change is small and understandable.
- The test says what the code now guarantees.
- The UI, if any, stays calm instead of noisy.
- The conversation feels like a coordinated pair or team, not a pile of disconnected guesses.

## 9. Record The Team

- When a mini agent meaningfully touches a task, add a short note in `AGENT_ROSTER.md`.
- Use the agent nickname, not a project contributor name.
- Keep the note factual and short: what the agent inspected, changed, or confirmed.
- If the task later changes hands, note that too so the thread history stays readable.
