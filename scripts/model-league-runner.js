const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const sim = require('../dist/sim');
const {RLAgentAI} = require('../dist/sim/tools/rl-agent');
const {BattleStream, getPlayerStreams, Teams} = sim;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTING_REPO = process.env.LEAGUE_REPORTING_REPO || path.resolve(PROJECT_ROOT, '..', 'Pokemon-Showdown-Sim');
const TOTAL_PER_PAIR = Number(process.env.LEAGUE_GAMES_PER_PAIR || 10);
const CONCURRENCY = Number(process.env.LEAGUE_CONCURRENCY || 6);
const BATTLE_TIMEOUT_MS = Number(process.env.LEAGUE_BATTLE_TIMEOUT_MS || 180000);
const PROGRESS_EVERY = Number(process.env.LEAGUE_PROGRESS_EVERY || 500);
const RUN_ID = process.env.LEAGUE_RUN_ID || defaultRunID();
const RUN_LABEL = process.env.LEAGUE_RUN_LABEL || 'league_run';
const RUN_STATUS = process.env.LEAGUE_RUN_STATUS || 'exploratory';
const RUN_TYPE = process.env.LEAGUE_RUN_TYPE || 'mixed';
const OUTPUT_ROOT = process.env.LEAGUE_OUTPUT_ROOT || '/tmp/model-league-runs';
const RUN_DIR = process.env.LEAGUE_RUN_DIR || path.join(OUTPUT_ROOT, RUN_ID);
const OUTPUT_PATH = process.env.LEAGUE_OUTPUT_PATH || path.join(RUN_DIR, 'result.json');
const FAILURE_LOG_PATH = process.env.LEAGUE_FAILURE_LOG_PATH || path.join(RUN_DIR, 'failures.jsonl');
const METADATA_PATH = path.join(RUN_DIR, 'run_metadata.json');
const PRE_HEALTH_PATH = path.join(RUN_DIR, 'service_health_before.json');
const POST_HEALTH_PATH = path.join(RUN_DIR, 'service_health_after.json');
const REGISTER_HISTORY = process.env.LEAGUE_REGISTER_HISTORY !== '0';
const SET_LATEST = process.env.LEAGUE_SET_LATEST === '1';
const PYTHON = process.env.LEAGUE_PYTHON || 'python3';
const SERVICE_WAIT_SECONDS = Number(process.env.LEAGUE_SERVICE_WAIT_SECONDS || 60);
const SERVICE_WAIT_INTERVAL_MS = Number(process.env.LEAGUE_SERVICE_WAIT_INTERVAL_MS || 1000);

const ALL_MODELS = [
  {id: 'word_policy_v1', endpoint: 'local://default', transport: 'local'},
  {id: 'entity_action_bc_v1_20260408_0428', endpoint: 'http://127.0.0.1:5001/predict', transport: 'http'},
  {id: 'entity_action_v2_20260409_1811', endpoint: 'http://127.0.0.1:5002/predict', transport: 'http'},
  {id: 'model5', endpoint: 'http://127.0.0.1:5000/predict', transport: 'http'},
  {id: 'model4', endpoint: 'http://127.0.0.1:5000/predict', transport: 'http'},
  {id: 'model2', endpoint: 'http://127.0.0.1:5000/predict', transport: 'http'},
  {id: 'model1', endpoint: 'http://127.0.0.1:5000/predict', transport: 'http'},
];

const requestedModelIDs = (process.env.LEAGUE_MODELS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const MODELS = requestedModelIDs.length
  ? ALL_MODELS.filter((model) => requestedModelIDs.includes(model.id))
  : ALL_MODELS;
let FINALIZED = false;

function defaultRunID() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-') + '_' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function generatedAt() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ensureRunDir() {
  fs.mkdirSync(RUN_DIR, {recursive: true});
  fs.writeFileSync(METADATA_PATH, JSON.stringify({
    runId: RUN_ID,
    label: RUN_LABEL,
    status: RUN_STATUS,
    runType: RUN_TYPE,
    startedAt: generatedAt(),
    outputPath: OUTPUT_PATH,
    failureLogPath: FAILURE_LOG_PATH,
    models: MODELS.map((model) => model.id),
    concurrency: CONCURRENCY,
    totalPerPair: TOTAL_PER_PAIR,
  }, null, 2));
}

function healthURLForModel(model) {
  if (model.transport !== 'http') return null;
  return model.endpoint.replace(/\/predict$/, '/health');
}

async function waitForServices() {
  const urls = [...new Set(MODELS.map(healthURLForModel).filter(Boolean))];
  if (!urls.length) return;
  const deadline = Date.now() + SERVICE_WAIT_SECONDS * 1000;
  while (true) {
    const pending = [];
    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) pending.push(`${url} status=${response.status}`);
      } catch (error) {
        pending.push(`${url} error=${String(error && error.message || error)}`);
      }
    }
    if (!pending.length) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for league services: ${pending.join('; ')}`);
    }
    console.log(`[service-wait] pending=${pending.join(' | ')}`);
    await new Promise((resolve) => setTimeout(resolve, SERVICE_WAIT_INTERVAL_MS));
  }
}

function preparedTeamPair() {
  return {
    p1Team: Teams.pack(Teams.generate('gen9randombattle')),
    p2Team: Teams.pack(Teams.generate('gen9randombattle')),
  };
}

function makeConfigEntry(model) {
  return {
    endpoint: model.endpoint,
    transport: model.transport,
    modelID: model.id,
    modelProfile: 'joint-policy',
    allowVoluntarySwitches: false,
  };
}

function collectServiceHealth(targetPath) {
  const collector = path.join(REPORTING_REPO, 'scripts', 'collect_model_service_health.py');
  const latest = path.join(REPORTING_REPO, 'docs', 'model_service_health_latest.json');
  const args = [collector, '--generated-at', generatedAt()];
  const seen = new Set();
  for (const model of MODELS) {
    const url = healthURLForModel(model);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    args.push('--service', `${model.id}=${url}`);
  }
  try {
    execFileSync(PYTHON, args, {
      cwd: REPORTING_REPO,
      stdio: 'inherit',
    });
    fs.copyFileSync(latest, targetPath);
  } catch (error) {
    fs.writeFileSync(targetPath, JSON.stringify({
      generated_at: generatedAt(),
      status: 'collector_error',
      error: String(error && error.stack || error),
    }, null, 2));
  }
}

function registerRun() {
  if (!REGISTER_HISTORY) return;
  const registerScript = path.join(REPORTING_REPO, 'scripts', 'register_model_league_run.py');
  const args = [
    registerScript,
    '--result-json', OUTPUT_PATH,
    '--run-id', RUN_ID,
    '--label', RUN_LABEL,
    '--status', RUN_STATUS,
    '--run-type', RUN_TYPE,
    '--generated-at', generatedAt(),
    '--run-dir', RUN_DIR,
    '--raw-result-path', OUTPUT_PATH,
    '--failure-log-path', FAILURE_LOG_PATH,
    '--service-health-before-path', PRE_HEALTH_PATH,
    '--service-health-after-path', POST_HEALTH_PATH,
    '--note', `Automated league run from pokemon-showdown-model-feature/scripts/model-league-runner.js.`,
  ];
  if (SET_LATEST) args.push('--set-latest');
  execFileSync(PYTHON, args, {
    cwd: REPORTING_REPO,
    stdio: 'inherit',
  });
  execFileSync(PYTHON, [path.join(REPORTING_REPO, 'scripts', 'render_model_dashboard.py')], {
    cwd: REPORTING_REPO,
    stdio: 'inherit',
  });
}

function finalizeRun({fatalError} = {}) {
  if (FINALIZED) return;
  FINALIZED = true;
  if (fatalError) {
    fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({
      gameIndex: null,
      pairing: 'runner',
      p1: null,
      p2: null,
      error: String(fatalError && fatalError.stack || fatalError),
    }) + '\n', 'utf8');
  }
  collectServiceHealth(POST_HEALTH_PATH);
  if (fs.existsSync(OUTPUT_PATH)) {
    registerRun();
  }
}

async function runBattle(p1Model, p2Model, teams) {
  const battleStream = new BattleStream();
  const streams = getPlayerStreams(battleStream);
  const p1 = new RLAgentAI(streams.p1, makeConfigEntry(p1Model));
  const p2 = new RLAgentAI(streams.p2, makeConfigEntry(p2Model));
  void p1.start();
  void p2.start();

  let winner = null;
  const battleLoop = (async () => {
    for await (const chunk of streams.omniscient) {
      const winIndex = chunk.indexOf('|win|');
      if (winIndex >= 0) {
        const nameStart = winIndex + 5;
        const nameEnd = chunk.indexOf('\n', nameStart);
        winner = chunk.slice(nameStart, nameEnd >= 0 ? nameEnd : undefined).trim();
      }
    }
  })();

  const spec = {formatid: 'gen9randombattle'};
  const p1spec = {name: p1Model.id, team: teams.p1Team};
  const p2spec = {name: p2Model.id, team: teams.p2Team};
  const battlePromise = (async () => {
    await streams.omniscient.write(
      `>start ${JSON.stringify(spec)}\n` +
      `>player p1 ${JSON.stringify(p1spec)}\n` +
      `>player p2 ${JSON.stringify(p2spec)}`
    );
    await battleLoop;
    return winner;
  })();

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Battle timed out after ${BATTLE_TIMEOUT_MS}ms`)), BATTLE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([battlePromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    p1.stop();
    p2.stop();
    await streams.omniscient.writeEnd();
  }
}

function pairings(models) {
  const out = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) out.push([models[i], models[j]]);
  }
  return out;
}

function createGames() {
  const games = [];
  for (const [a, b] of pairings(MODELS)) {
    const mirroredPairs = TOTAL_PER_PAIR / 2;
    for (let n = 0; n < mirroredPairs; n++) {
      const teams = preparedTeamPair();
      games.push({a, b, p1: a, p2: b, teams});
      games.push({a, b, p1: b, p2: a, teams: {p1Team: teams.p2Team, p2Team: teams.p1Team}});
    }
  }
  return games;
}

function fitElo(models, pairResults) {
  const ratings = Object.fromEntries(models.map((m) => [m.id, 1500]));
  const k = 8 / 400.0;
  for (let iter = 0; iter < 5000; iter++) {
    const grad = Object.fromEntries(models.map((m) => [m.id, 0]));
    for (const r of pairResults) {
      const ra = ratings[r.a];
      const rb = ratings[r.b];
      const p = 1 / (1 + Math.pow(10, -(ra - rb) / 400.0));
      const total = r.winsA + r.winsB;
      const diff = r.winsA - total * p;
      grad[r.a] += diff;
      grad[r.b] -= diff;
    }
    for (const m of models) ratings[m.id] += k * grad[m.id];
    const mean = models.reduce((s, m) => s + ratings[m.id], 0) / models.length;
    for (const m of models) ratings[m.id] += 1500 - mean;
  }
  return ratings;
}

function summarize(standings, pairMap, startedAt) {
  const pairResults = [...pairMap.values()];
  const ratings = fitElo(MODELS, pairResults);
  const ranking = MODELS.map((m) => ({
    model: m.id,
    wins: standings[m.id].wins,
    losses: standings[m.id].losses,
    elo: Math.round(ratings[m.id]),
  })).sort((a, b) => b.elo - a.elo);

  return {
    runId: RUN_ID,
    label: RUN_LABEL,
    status: RUN_STATUS,
    runType: RUN_TYPE,
    totalGames: pairResults.reduce((sum, pair) => sum + pair.winsA + pair.winsB + pair.ties, 0),
    wallSeconds: (Date.now() - startedAt) / 1000,
    perPairGames: TOTAL_PER_PAIR,
    concurrency: CONCURRENCY,
    models: MODELS.map((model) => model.id),
    ranking,
    pairings: pairResults.map((pair) => ({
      pairing: `${pair.a} vs ${pair.b}`,
      [pair.a]: pair.winsA,
      [pair.b]: pair.winsB,
      ties: pair.ties,
    })),
    artifacts: {
      runDir: RUN_DIR,
      resultJson: OUTPUT_PATH,
      failureLog: FAILURE_LOG_PATH,
      serviceHealthBefore: PRE_HEALTH_PATH,
      serviceHealthAfter: POST_HEALTH_PATH,
    },
  };
}

async function main() {
  ensureRunDir();
  collectServiceHealth(PRE_HEALTH_PATH);
  await waitForServices();

  const startedAt = Date.now();
  const games = createGames();
  const standings = Object.fromEntries(MODELS.map((m) => [m.id, {wins: 0, losses: 0}]));
  const pairMap = new Map();
  let nextIndex = 0;
  let completed = 0;
  let failures = 0;
  const totalGames = games.length;

  fs.writeFileSync(FAILURE_LOG_PATH, '', 'utf8');

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= totalGames) return;
      const game = games[i];
      try {
        const winner = await runBattle(game.p1, game.p2, game.teams);
        const sorted = [game.a.id, game.b.id].sort();
        const key = sorted.join('::');
        if (!pairMap.has(key)) pairMap.set(key, {a: sorted[0], b: sorted[1], winsA: 0, winsB: 0, ties: 0});
        const pair = pairMap.get(key);
        if (winner !== game.p1.id && winner !== game.p2.id) {
          pair.ties += 1;
        } else {
          standings[winner].wins += 1;
          const loser = winner === game.p1.id ? game.p2.id : game.p1.id;
          standings[loser].losses += 1;
          if (winner === pair.a) pair.winsA += 1;
          else pair.winsB += 1;
        }
      } catch (error) {
        failures += 1;
        fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({
          gameIndex: i,
          pairing: `${game.a.id} vs ${game.b.id}`,
          p1: game.p1.id,
          p2: game.p2.id,
          error: String(error && error.stack || error),
        }) + '\n', 'utf8');
        console.error(`[failure] game=${i} ${String(error && error.stack || error)}`);
      }
      completed += 1;
      if (completed % PROGRESS_EVERY === 0 || completed === totalGames) {
        const snapshot = summarize(standings, pairMap, startedAt);
        snapshot.completed = completed;
        snapshot.failures = failures;
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2));
        const leader = snapshot.ranking[0];
        console.log(
          `[progress] run=${RUN_ID} completed=${completed}/${totalGames} failures=${failures} leader=${leader.model} elo=${leader.elo} wall_s=${snapshot.wallSeconds.toFixed(1)}`
        );
      }
    }
  }

  try {
    await Promise.all(Array.from({length: CONCURRENCY}, () => worker()));
    const final = summarize(standings, pairMap, startedAt);
    final.completed = completed;
    final.failures = failures;
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(final, null, 2));
    console.log(JSON.stringify(final, null, 2));
  } finally {
    finalizeRun();
  }
}

process.on('unhandledRejection', (error) => {
  console.error(error);
  try {
    finalizeRun({fatalError: error});
  } finally {
    process.exitCode = 1;
  }
});

process.on('uncaughtException', (error) => {
  console.error(error);
  try {
    finalizeRun({fatalError: error});
  } finally {
    process.exitCode = 1;
  }
});

main().catch((error) => {
  console.error(error);
  finalizeRun({fatalError: error});
  process.exitCode = 1;
});
