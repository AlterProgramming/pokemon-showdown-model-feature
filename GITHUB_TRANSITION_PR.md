# Intel Mac Transition PR Body

## Summary

- Adds browser-model bridge and model-league support in `pokemon-showdown`.
- Cleans up repo hygiene so machine-local benchmark output and league state do not appear in Git.
- Adds a tracked `config/model-league.example.json` template and Intel Mac handoff docs.
- Pairs with a sister-repo change that runs the Python model server in Docker or another Linux VM for Intel macOS.

## Branch purpose

- Make the current RL/model-serving workflow reproducible on a second laptop.
- Keep `pokemon-showdown` native on macOS.
- Avoid native Intel-macOS TensorFlow friction by running the Python model server in a Linux-compatible runtime.

## Known-good versions

- Simulator docs in this branch were validated with Node `20.11.0` and npm `10.2.4`.
- `node pokemon-showdown ...` requires built-in `fetch`, which means Node `18+`.
- Sister repo runtime target: Python `3.12.x`, Flask `3.1.3`, Keras `3.13.2`, TensorFlow `2.20.0`.

## Local ports

- Simulator server: `8000` by default
- Model server: `127.0.0.1:5000`
- Browser bridge: `127.0.0.1:5051`

## Required local config

- Keep `config/config.js` local and ignored.
- Copy `config/model-league.example.json` to ignored local `config/model-league.json` before using `pokemon-showdown model-league ...`.
- Edit the local model IDs and endpoints to match the artifacts actually present on the machine.

## Files that remain local-only

- `config/config.js`
- `config/model-league.json`
- `benchmark_runs/`
- `logs/`
- `databases/model-league/`
- `databases/model-league-test/`
- benchmark and replay logs such as `model-vs-model-*.log`

## Validation after clone

1. In the sister repo, start the containerized model server and verify `GET /health`.
2. In `pokemon-showdown`, run `npm ci`.
3. Run `node build`.
4. Run one focused Mocha file.
5. Start `node pokemon-showdown start`.
6. Start `node pokemon-showdown browser-model-bridge --model-endpoint http://127.0.0.1:5000/predict`.
7. Run one direct benchmark command from `INTEL_MAC_HANDOFF.md`.
8. Confirm `git status` stays clean apart from ignored local state.
