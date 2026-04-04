# Intel Mac Handoff

This runbook is the lowest-friction path for bringing the simulator stack up on an Intel Mac while keeping the Python model server on a Linux-compatible runtime.

## Deployment shape

- Run `pokemon-showdown` natively on macOS.
- Run the sister repo (`Pokemon Showdown Agent`) in Docker or another Linux VM on the same Mac, following that repo's `docs/INTEL_MAC_CONTAINER_RUNBOOK.md`.
- Keep mutable local files out of Git:
  - `config/config.js`
  - `config/model-league.json`
  - `logs/`
  - `benchmark_runs/`
  - `databases/model-league/`

## Known-good versions

- Current branch notes were last validated with Node `20.11.0` and npm `10.2.4`.
- The checked-in `pokemon-showdown` CLI wrapper requires built-in `fetch`, which means Node `18+`.
- Python `3.12.x` is the expected runtime for the sister repo.

For the Intel Mac handoff, install one current Node LTS release and use it consistently for install, build, and runtime commands.

## Local simulator setup

```bash
git clone <your simulator fork url>
cd pokemon-showdown
npm ci
node build
cp config/model-league.example.json config/model-league.json
```

Then edit `config/model-league.json` so the `models[*].id`, `modelID`, and `endpoint` values match the model artifacts you actually plan to serve.

## Focused validation

Run one narrow test first:

```bash
node ./node_modules/mocha/bin/mocha.js --no-config --file ./test/main.js test/server/room-battle.js --timeout 15000 --exit
```

Start the simulator server:

```bash
node pokemon-showdown start
```

In another terminal, start the browser bridge:

```bash
node pokemon-showdown browser-model-bridge --model-endpoint http://127.0.0.1:5000/predict
```

Default ports:

- simulator server: `8000` unless overridden by local config
- model server: `http://127.0.0.1:5000/predict`
- browser bridge: `http://127.0.0.1:5051/predict`

## Portable benchmark entrypoints

These commands work from a standard macOS shell after `node build`.

Random-vs-model:

```bash
TOTAL_GAMES=20 \
CONCURRENCY=2 \
BATTLE_TIMEOUT_MS=180000 \
RL_MODEL_ID=model2 \
RL_MODEL_PROFILE=joint-policy \
RL_MODEL_ENDPOINT=http://127.0.0.1:5000/predict \
node ./dist/sim/examples/statistical-runner.js
```

Model-vs-model:

```bash
TOTAL_GAMES=20 \
CONCURRENCY=2 \
BATTLE_TIMEOUT_MS=180000 \
MODEL_SERVER_ENDPOINT=http://127.0.0.1:5000/predict \
MODEL_A_NAME=Model2 \
MODEL_A_ID=model2 \
MODEL_A_PROFILE=joint-policy \
MODEL_B_NAME=Model4 \
MODEL_B_ID=model4 \
MODEL_B_PROFILE=joint-policy-value \
node ./dist/sim/examples/model-vs-model-runner.js
```

Portable environment variables used by the simulator:

- `RL_MODEL_ENDPOINT`
- `RL_MODEL_ID`
- `RL_MODEL_PROFILE`
- `RL_ALLOW_VOLUNTARY_SWITCHES`
- `MODEL_SERVER_ENDPOINT`

## Model server contract

The simulator assumes the sister repo exposes:

- `GET /health`
- `POST /predict`

Expected defaults:

- model inference endpoint: `http://127.0.0.1:5000/predict`
- browser bridge endpoint: `http://127.0.0.1:5051/predict`

`/predict` must accept both:

- legacy vector payloads using `state_vector`
- entity payloads using `battle_state`

## Fresh-machine checklist

1. Clone both repos.
2. Bring up the sister repo container and confirm `curl http://127.0.0.1:5000/health`.
3. Run `npm ci` and `node build` here.
4. Copy `config/model-league.example.json` to ignored local `config/model-league.json`.
5. Run one narrow Mocha file.
6. Start `node pokemon-showdown start`.
7. Start `node pokemon-showdown browser-model-bridge --model-endpoint http://127.0.0.1:5000/predict`.
8. Run one direct benchmark command from this document.

If you need the PR write-up for the GitHub handoff, use `GITHUB_TRANSITION_PR.md` in this repo as the starting body.
