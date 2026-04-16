'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const {FS} = require('../../dist/lib/fs');
const {normalizeRLModelProfile} = require('../../dist/sim/tools/rl-model-profiles');
const {
	loadModelLeagueConfig,
} = require('../../dist/server/model-league/config');
const {
	appendModelLeagueEvent,
	archiveControlRequest,
	applyTrainingCompletionPayloadToState,
	createInitialModelLeagueState,
	ensureModelLeagueDirectories,
	getModelLeagueControlArchivePath,
	getModelLeagueControlQueuePath,
	getModelLeagueEventsPath,
	getModelLeagueStatePath,
	getModelLeagueTrainingDir,
	loadCompletedTrainingPayloads,
	loadModelLeagueState,
	loadQueuedControlRequests,
	loadTrainingJobFiles,
	removeCompletedTrainingPayload,
	removeTrainingJobFile,
	saveModelLeagueState,
	writeCompletedTrainingPayload,
	writeControlRequest,
	writeTrainingJobFile,
} = require('../../dist/server/model-league/storage');
const {applyRatingMatch} = require('../../dist/server/model-league/ratings');

function makeTempDir(prefix) {
	const root = path.join(__dirname, '..', 'tmp');
	fs.mkdirSync(root, {recursive: true});
	return fs.mkdtempSync(path.join(root, prefix));
}

async function waitForFile(filePath, timeoutMs = 1000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(filePath)) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${filePath}`);
}

function writeJson(filePath, data) {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function baseConfig(overrides = {}) {
	return {
		version: 1,
		format: 'gen9customgame@@@!Team Preview',
		stateRoot: 'databases/model-league-test',
		logRoot: 'logs/model-league-test',
		models: [
			{
				id: 'model-a',
				name: 'Model A',
				modelID: 'model-a-live',
				endpoint: 'http://127.0.0.1:5000/predict',
				modelProfile: 'joint-policy',
				allowedTeamIds: ['team-a'],
			},
			{
				id: 'model-b',
				name: 'Model B',
				modelID: 'model-b-live',
				endpoint: 'http://127.0.0.1:5000/predict',
				modelProfile: 'joint-policy-value',
				parentCheckpointId: 'model-a',
				lineageId: 'lineage-a',
			},
		],
		teams: [
			{
				id: 'team-a',
				name: 'Team A',
				packedTeam: 'Pikachu||||thunderbolt,quickattack||||||',
			},
			{
				id: 'team-b',
				name: 'Team B',
				packedTeam: 'Eevee||||tackle,tailwhip||||||',
			},
		],
		benchmarks: [
			{
				id: 'tower-1',
				name: 'Tower 1',
				level: 1,
				opponentModelId: 'model-a',
				opponentTeamId: 'team-a',
				requiredWinRate: 0.6,
			},
		],
		scheduler: {
			loopIntervalMs: 5000,
			benchmarkIntervalMs: 3600000,
			maxConcurrentTasks: 1,
			liveMatchmakingWeight: 60,
			archivedMatchmakingWeight: 20,
			explorationWeight: 20,
			liveRollouts: 6,
			historicalRollouts: 4,
			benchmarkRolloutsDefault: 10,
			sideSwap: true,
			matchmakingWindow: 125,
			recentMatchLimit: 30,
		},
		ratings: {
			initialElo: 1000,
			minElo: 1000,
		},
		replay: {
			captureMode: 'none',
			captureCount: 0,
			outputDir: 'logs/model-league-test/replays',
			grid: false,
			gridRefreshSeconds: 2,
		},
		training: {
			enabled: true,
			minMatches: 2,
			minExamples: 3,
			cooldownMs: 1000,
			examplesDir: 'training/examples',
			bundleDir: 'training/bundles',
			pendingJobDir: 'training/pending',
			completedJobDir: 'training/completed',
		},
		webhooks: {
			outboundTrainingRequested: null,
			inboundTrainingCompleted: null,
		},
		...overrides,
	};
}

describe('Model league foundation', () => {
	let originalNoFsWriting;
	let tempDir;
	let configPath;

	beforeEach(() => {
		originalNoFsWriting = Config.nofswriting;
		Config.nofswriting = false;
		tempDir = makeTempDir('model-league-');
		configPath = path.join(tempDir, 'model-league.json');
	});

	afterEach(() => {
		Config.nofswriting = originalNoFsWriting;
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it('validates league config and normalizes defaults', () => {
		writeJson(configPath, baseConfig());
		const config = loadModelLeagueConfig(configPath);

		assert.equal(config.version, 1);
		assert.equal(config.format, 'gen9customgame@@@!Team Preview');
		assert.equal(config.models[0].allowVoluntarySwitches, true);
		assert.equal(config.models[1].modelProfile, normalizeRLModelProfile('joint-policy-value'));
		assert.equal(config.scheduler.liveMatchmakingWeight + config.scheduler.archivedMatchmakingWeight + config.scheduler.explorationWeight, 1);
		assert.equal(config.benchmarks[0].requiredWinRate, 0.6);
	});

	it('rejects benchmark references to missing models or teams', () => {
		writeJson(configPath, baseConfig({
			benchmarks: [
				{
					id: 'bad',
					name: 'Bad',
					level: 1,
					opponentModelId: 'missing',
					opponentTeamId: 'team-a',
				},
			],
		}));

		assert.throws(() => loadModelLeagueConfig(configPath), /missing opponentModelId/);
	});

	it('hydrates persisted state with new config entries without losing runtime data', async () => {
		writeJson(configPath, baseConfig());
		const config = loadModelLeagueConfig(configPath);
		await ensureModelLeagueDirectories(config);

		const state = createInitialModelLeagueState(config, configPath);
		state.checkpoints[0].matchCount = 7;
		state.checkpoints[0].trainingBuffer.matchIds.push('match-1');
		state.teams[0].matchCount = 11;
		state.recentMatches.push({
			id: 'match-1',
			type: 'live',
			schedulerBucket: 'live',
			recordedAt: new Date().toISOString(),
			format: config.format,
			rollouts: 2,
			sideSwap: true,
			modelAId: 'model-a',
			modelBId: 'model-b',
			teamAId: 'team-a',
			teamBId: 'team-b',
			modelAWins: 1,
			modelBWins: 1,
			ties: 0,
			winRateA: 0.5,
			confidenceLow: 0.25,
			confidenceHigh: 0.75,
			modelAEloBefore: 1000,
			modelAEloAfter: 1008,
			modelBEloBefore: 1000,
			modelBEloAfter: 992,
			teamAEloBefore: 1000,
			teamAEloAfter: 1008,
			teamBEloBefore: 1000,
			teamBEloAfter: 992,
			replayPaths: [],
			exampleFiles: {},
		});
		saveModelLeagueState(config, state);

		await waitForFile(getModelLeagueStatePath(config));
		const refreshedConfigPath = path.join(tempDir, 'model-league-updated.json');
		writeJson(refreshedConfigPath, baseConfig({
			models: [
				...baseConfig().models,
				{
					id: 'model-c',
					name: 'Model C',
					modelID: 'model-c-live',
					endpoint: 'http://127.0.0.1:5000/predict',
					modelProfile: 'joint-policy',
				},
			],
			teams: [
				...baseConfig().teams,
				{
					id: 'team-c',
					name: 'Team C',
					packedTeam: 'Bulbasaur||||tackle,growl||||||',
				},
			],
			benchmarks: [
				...baseConfig().benchmarks,
				{
					id: 'tower-2',
					name: 'Tower 2',
					level: 2,
					opponentModelId: 'model-c',
					opponentTeamId: 'team-c',
					requiredWinRate: 0.65,
				},
			],
		}));
		const refreshedConfig = loadModelLeagueConfig(refreshedConfigPath);
		const hydratedState = loadModelLeagueState(refreshedConfig, refreshedConfigPath);

		assert.equal(hydratedState.checkpoints.some(checkpoint => checkpoint.id === 'model-c'), true);
		assert.equal(hydratedState.teams.some(team => team.id === 'team-c'), true);
		assert.equal(hydratedState.benchmarkProgress.some(benchmark => benchmark.id === 'tower-2'), true);
		assert.equal(hydratedState.checkpoints.find(checkpoint => checkpoint.id === 'model-a').matchCount, 7);
		assert.equal(hydratedState.teams.find(team => team.id === 'team-a').matchCount, 11);
		assert.equal(hydratedState.recentMatches[0].id, 'match-1');
	});

	it('persists queued control requests, training jobs, and completion payloads', async () => {
		writeJson(configPath, baseConfig());
		const config = loadModelLeagueConfig(configPath);
		await ensureModelLeagueDirectories(config);

		const controlRequest = {
			id: 'control-1',
			type: 'pause',
			createdAt: new Date().toISOString(),
			requestedBy: 'tester',
		};
		await writeControlRequest(config, controlRequest);
		await waitForFile(path.join(getModelLeagueControlQueuePath(config), 'control-1.json'));

		const loadedRequests = await loadQueuedControlRequests(config);
		assert.deepEqual(loadedRequests, [controlRequest]);

		await archiveControlRequest(config, 'control-1');
		assert.equal(fs.existsSync(path.join(getModelLeagueControlQueuePath(config), 'control-1.json')), false);
		assert.equal(fs.existsSync(path.join(getModelLeagueControlArchivePath(config), 'control-1.json')), true);

		const job = {
			jobId: 'job-1',
			modelCheckpointId: 'model-a',
			parentCheckpointId: null,
			lineageId: 'lineage-a',
			createdAt: new Date().toISOString(),
			requestedBy: 'daemon',
			status: 'pending',
			bundleDir: path.join(tempDir, 'databases/model-league/training/bundles/job-1'),
			manifestPath: path.join(tempDir, 'databases/model-league/training/bundles/job-1/manifest.json'),
			matchCount: 3,
			exampleCount: 4,
			exampleFiles: ['example-1.jsonl'],
			matchIds: ['match-1', 'match-2'],
			outboundWebhookDeliveredAt: null,
			outboundWebhookError: null,
			completionPayload: null,
			error: null,
		};
		await writeTrainingJobFile(config, job);
		await waitForFile(path.join(getModelLeagueTrainingDir(config, config.training.pendingJobDir), 'job-1.json'));

		const loadedJobs = await loadTrainingJobFiles(config);
		assert.deepEqual(loadedJobs, [job]);
		await removeTrainingJobFile(config, 'job-1');
		assert.equal(fs.existsSync(path.join(getModelLeagueTrainingDir(config, config.training.pendingJobDir), 'job-1.json')), false);

		const completion = {
			jobId: 'job-1',
			parentCheckpointId: 'model-a',
			newModelId: 'model-a-v2',
			endpoint: 'http://127.0.0.1:5001/predict',
			modelProfile: 'joint-policy',
			allowVoluntarySwitches: true,
			lineageId: 'lineage-a',
			metadata: {source: 'remote-trainer'},
			activate: true,
		};
		await writeCompletedTrainingPayload(config, completion);
		await waitForFile(path.join(getModelLeagueTrainingDir(config, config.training.completedJobDir), 'job-1.json'));

		const completedPayloads = await loadCompletedTrainingPayloads(config);
		assert.deepEqual(completedPayloads, [completion]);
		const state = createInitialModelLeagueState(config, configPath);
		state.trainingJobs.push(job);
		const checkpoint = applyTrainingCompletionPayloadToState(state, completion);
		assert.equal(checkpoint.id, 'model-a-v2');
		assert.equal(checkpoint.parentCheckpointId, 'model-a');
		assert.equal(state.trainingJobs[0].status, 'registered');
		await removeCompletedTrainingPayload(config, 'job-1');
		assert.equal(fs.existsSync(path.join(getModelLeagueTrainingDir(config, config.training.completedJobDir), 'job-1.json')), false);
	});

	it('saves match events and updates ratings with the shared Elo helper', async () => {
		writeJson(configPath, baseConfig());
		const config = loadModelLeagueConfig(configPath);
		await ensureModelLeagueDirectories(config);

		const state = createInitialModelLeagueState(config, configPath);
		const result = applyRatingMatch({
			entries: state.modelRatings,
			idA: 'model-a',
			nameA: 'Model A',
			idB: 'model-b',
			nameB: 'Model B',
			scoreA: 1,
			now: new Date().toISOString(),
			config,
		});
		assert(result.afterA > result.beforeA);
		assert(result.afterB <= result.beforeB);

		await appendModelLeagueEvent(config, {type: 'match-completed', modelAId: 'model-a'});
		await waitForFile(getModelLeagueEventsPath(config));

		const eventLines = fs.readFileSync(getModelLeagueEventsPath(config), 'utf8').trim().split('\n');
		assert.equal(eventLines.length >= 1, true);
		const parsedEvent = JSON.parse(eventLines[0]);
		assert.equal(parsedEvent.type, 'match-completed');
		assert.equal(parsedEvent.modelAId, 'model-a');
	});

	it('writes the training directories under the configured state root', async () => {
		writeJson(configPath, baseConfig());
		const config = loadModelLeagueConfig(configPath);
		await ensureModelLeagueDirectories(config);

		const examplesDir = getModelLeagueTrainingDir(config, config.training.examplesDir);
		const bundleDir = getModelLeagueTrainingDir(config, config.training.bundleDir);
		const pendingDir = getModelLeagueTrainingDir(config, config.training.pendingJobDir);
		const completedDir = getModelLeagueTrainingDir(config, config.training.completedJobDir);

		assert.equal(fs.existsSync(examplesDir), true);
		assert.equal(fs.existsSync(bundleDir), true);
		assert.equal(fs.existsSync(pendingDir), true);
		assert.equal(fs.existsSync(completedDir), true);
		assert.equal(fs.existsSync(getModelLeagueControlQueuePath(config)), true);
		assert.equal(fs.existsSync(getModelLeagueControlArchivePath(config)), true);
	});
});
