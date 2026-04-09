# Benchmark Runbook

This is the shortest known-good setup for running the RL benchmark stack on a stronger Windows machine.

This document is intentionally Windows-first because the launcher wrappers here are PowerShell scripts. For the Intel Mac handoff path, use [INTEL_MAC_HANDOFF.md](./INTEL_MAC_HANDOFF.md) for native simulator commands plus the containerized sister-repo model server.

Assumptions:

- `pokemon-showdown` repo is already copied over
- the Python model-server repo (`Pokemon Showdown Agent`) is also copied over
- you are launching from Git Bash
- you want to use existing models only, not train new ones

## 1. Known-Good Versions

- Node: `20.11.0`
- npm: `10.2.4`
- Python: `3.12.x`
- TensorFlow: `2.20.0`
- Keras: `3.13.2`
- Flask: `3.1.3`

## 2. Simulator Repo Setup

From Git Bash in the `pokemon-showdown` repo:

```bash
export PATH="/c/path/to/node-v20.11.0-win-x64:$PATH"
node -v
npm -v

npm ci
npm run build
```

If Node is not installed globally, a portable Node folder is fine as long as it contains `node.exe` and `npm.cmd`.

## 3. Model Server Repo Setup

From Git Bash in the `Pokemon Showdown Agent` repo:

```bash
py -3.12 -m venv .venv
"./.venv/Scripts/python.exe" -m pip install --upgrade pip
"./.venv/Scripts/python.exe" -m pip install Flask==3.1.3 tensorflow==2.20.0 keras==3.13.2
```

Quick validation:

```bash
"./.venv/Scripts/python.exe" -c "import tensorflow as tf, keras; print(tf.__version__); print(keras.__version__)"
```

## 4. Useful Environment Variables

In Git Bash:

```bash
export PS_AGENT_REPO='C:\path\to\Pokemon Showdown Agent'
export PS_AGENT_PY='C:\path\to\Pokemon Showdown Agent\.venv\Scripts\python.exe'
```

You can add those to `~/.bashrc` if this machine will be reused.

## 5. Start the Multi-Model Server

Run this from the `Pokemon Showdown Agent` repo:

```bash
python flask_api_multi.py --mode multi --model-ids model2,model4 --host 127.0.0.1 --port 5000 --workers-per-model 2
```

If you want custom worker counts:

```bash
python flask_api_multi.py --mode multi --model-ids model2,model4 --host 127.0.0.1 --port 5000 --model-worker-overrides model2=2,model4=4
```

Server endpoint for the simulator:

```text
http://127.0.0.1:5000/predict
```

## 6. Run Random-vs-Model Benchmark

From Git Bash in the `pokemon-showdown` repo:

```bash
MSYS_NO_PATHCONV=1 powershell.exe -ExecutionPolicy Bypass -File ./scripts/run-statistical-runner.ps1 \
  -TotalGames 100 \
  -Concurrency 2 \
  -BattleTimeoutMs 180000 \
  -RLModelID "model2" \
  -RLModelProfile joint-policy \
  -RLModelEndpoint "http://127.0.0.1:5000/predict"
```

### Fastest validated local word-policy path

If you are benchmarking `word_policy_v1`, the fastest validated path is the in-process local transport, with benchmark telemetry and replay capture work trimmed on the hot path.

From Git Bash in the `pokemon-showdown` repo:

```bash
TOTAL_GAMES=200 \
CONCURRENCY=10 \
BATTLE_TIMEOUT_MS=180000 \
RL_MODEL_ID=word_policy_v1 \
RL_MODEL_PROFILE=joint-policy \
RL_MODEL_TRANSPORT=local \
RL_ALLOW_VOLUNTARY_SWITCHES=false \
BENCHMARK_QUIET=true \
BENCHMARK_FAST_MODE=true \
BENCHMARK_PREGENERATE_TEAMS=true \
BENCHMARK_WARMUP_GAMES=100 \
RL_AGENT_METRICS_ENABLED=false \
node ./dist/sim/examples/statistical-runner.js \
  --rl-model-id word_policy_v1 \
  --rl-model-profile joint-policy \
  --rl-model-transport local
```

Latest validated result on this path:

- about `1023 games/min` on `1000` games with `CONCURRENCY=10` and `BENCHMARK_WARMUP_GAMES=100`

Validated machine/runtime for that result:

- host: Intel MacBook Pro class machine
- CPU: `Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz`
- logical CPUs: `16`
- RAM: `64 GiB`
- OS: `macOS 26.4` (`Darwin 25.4.0`, `x86_64`)
- Node: `v22.12.0`
- npm: `10.9.0`

Notes:

- No HTTP or IPC model server is needed for this path.
- `BENCHMARK_PREGENERATE_TEAMS=true` moves random team generation out of the timed section.
- `BENCHMARK_WARMUP_GAMES=100` warms the local policy and sim loop before timing starts.
- `BENCHMARK_FAST_MODE=true` disables replay and switch-accounting work that is useful for analysis but not for peak-throughput measurement.
- `RL_AGENT_METRICS_ENABLED=false` disables RL-agent timing telemetry on the request hot path.

With replay capture:

```bash
MSYS_NO_PATHCONV=1 powershell.exe -ExecutionPolicy Bypass -File ./scripts/run-statistical-runner.ps1 \
  -TotalGames 100 \
  -Concurrency 2 \
  -BattleTimeoutMs 180000 \
  -RLModelID "model2" \
  -RLModelProfile joint-policy \
  -RLModelEndpoint "http://127.0.0.1:5000/predict" \
  -ReplayCaptureMode all \
  -ReplayCaptureCount 20 \
  -ReplayOutputDir "logs\\replays" \
  -ReplayGrid
```

## 7. Run Model-vs-Model Benchmark

From Git Bash in the `pokemon-showdown` repo:

```bash
MSYS_NO_PATHCONV=1 powershell.exe -ExecutionPolicy Bypass -File ./scripts/run-model-vs-model.ps1 \
  -TotalGames 100 \
  -Concurrency 2 \
  -BattleTimeoutMs 180000 \
  -ModelAName "Model2" \
  -ModelAID "model2" \
  -ModelAProfile joint-policy \
  -ModelBName "Model4" \
  -ModelBID "model4" \
  -ModelBProfile joint-policy-value \
  -ModelServerEndpoint "http://127.0.0.1:5000/predict"
```

With replay capture:

```bash
MSYS_NO_PATHCONV=1 powershell.exe -ExecutionPolicy Bypass -File ./scripts/run-model-vs-model.ps1 \
  -TotalGames 100 \
  -Concurrency 2 \
  -BattleTimeoutMs 180000 \
  -ModelAName "Model2" \
  -ModelAID "model2" \
  -ModelAProfile joint-policy \
  -ModelBName "Model4" \
  -ModelBID "model4" \
  -ModelBProfile joint-policy-value \
  -ModelServerEndpoint "http://127.0.0.1:5000/predict" \
  -ReplayCaptureMode all \
  -ReplayCaptureCount 20 \
  -ReplayOutputDir "logs\\replays" \
  -ReplayGrid
```

## 8. Common Failure Modes

### PowerShell parameter errors

If PowerShell says it cannot process an argument for `BattleTimeoutMs` or another parameter, it is usually a shell-formatting problem.

Rules:

- in Git Bash, use `\` for line continuation
- in PowerShell, use backticks or put the command on one line

### Dense `quantization_config` error

That usually means Keras version mismatch. The known-good combo for these models is:

- `tensorflow==2.20.0`
- `keras==3.13.2`

### Models missing on the new machine

Make sure the `artifacts/` folder came over with:

- `.keras` model files
- `action_vocab_*.json`
- `training_metadata_*.json`
- `model_registry.json`

If a model still does not load, inspect the metadata file and make sure model/vocab paths are relative rather than pointing back to an absolute path on another machine.

## 9. Minimal Re-run Checklist

If the machine is already set up, the shortest path is:

1. Start the model server in the `Pokemon Showdown Agent` repo.
2. Open another terminal in `pokemon-showdown`.
3. Run either `run-statistical-runner.ps1` or `run-model-vs-model.ps1`.
4. Add replay capture flags only when needed.

For `word_policy_v1` local benchmarking, skip step `1` and use the in-process command above instead.
