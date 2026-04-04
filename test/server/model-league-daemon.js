'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const {
	createInitialModelLeagueState,
	ensureModelLeagueDirectories,
	getModelLeagueControlQueuePath,
	loadModelLeagueState,
	saveModelLeagueState,
	writeControlRequest,
	writeTrainingJobFile,
} = require('../../dist/server/model-league/storage');
const {loadModelLeagueConfig} = require('../../dist/server/model-league/config');
const {loadModelLeagueDaemonStatus} = require('../../dist/server/model-league/daemon');
const {runModelLeagueCLI} = require('../../dist/server/model-league/cli');

function makeTempDir(prefix) {
	const root = path.join(__dirname, '..', 'tmp');
	fs.mkdirSync(root, {recursive: true});
	return fs.mkdtempSync(path.join(root, prefix));
}

function writeJson(filePath, data) {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function baseConfig(stateRoot, logRoot) {
	return {
		version: 1,
		format: 'gen9customgame@@@!Team Preview',
		stateRoot: stateRoot.replace(/\\/g, '/'),
		logRoot: logRoot.replace(/\\/g, '/'),
		models: [
			{
				id: 'model-a',
				name: 'Model A',
				modelID: 'model-a-live',
				endpoint: 'https://example.invalid/model-a',
				modelProfile: 'joint-policy',
			},
			{
				id: 'model-b',
				name: 'Model B',
				modelID: 'model-b-live',
				endpoint: 'https://example.invalid/model-b',
				modelProfile: 'joint-policy',
				parentCheckpointId: 'model-a',
				lineageId: 'model-a',
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
				packedTeam: 'Bulbasaur||||razorleaf,sleeppowder||||||',
			},
		],
		benchmarks: [
			{
				id: 'tower-1',
				name: 'Tower 1',
				level: 1,
				opponentModelId: 'model-a',
				opponentTeamId: 'team-a',
				requiredWinRate: 0.5,
				rollouts: 3,
			},
		],
		scheduler: {
			loopIntervalMs: 5000,
			benchmarkIntervalMs: 60000,
			maxConcurrentTasks: 1,
			liveMatchmakingWeight: 60,
			archivedMatchmakingWeight: 20,
			explorationWeight: 20,
			liveRollouts: 2,
			historicalRollouts: 2,
			benchmarkRolloutsDefault: 3,
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
			outputDir: path.join(logRoot, 'replays').replace(/\\/g, '/'),
			grid: false,
			gridRefreshSeconds: 2,
		},
		training: {
			enabled: true,
			minMatches: 1,
			minExamples: 1,
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
	};
}

describe('Model league daemon and CLI slice', () => {
	let originalNoFsWriting;
	let tempDir;
	let configPath;
	let stateRoot;
	let logRoot;

	beforeEach(() => {
		originalNoFsWriting = Config.nofswriting;
		Config.nofswriting = false;
		tempDir = makeTempDir('model-league-daemon-');
		stateRoot = path.join(tempDir, 'state');
		logRoot = path.join(tempDir, 'logs');
		configPath = path.join(tempDir, 'model-league.json');
		writeJson(configPath, baseConfig(stateRoot, logRoot));
	});

	afterEach(() => {
		Config.nofswriting = originalNoFsWriting;
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it('loads daemon status from file-backed state and queued jobs', async () => {
		const config = loadModelLeagueConfig(configPath);
		await ensureModelLeagueDirectories(config);

		const state = createInitialModelLeagueState(config, configPath);
		state.daemon.status = 'running';
		state.daemon.pid = 1234;
		state.daemon.loopCount = 9;
		state.daemon.heartbeatAt = '2026-03-31T00:01:00.000Z';
		state.daemon.lastLoopAt = '2026-03-31T00:00:30.000Z';
		state.checkpoints[0].matchCount = 5;
		state.teams[0].matchCount = 4;
		saveModelLeagueState(config, state);

		await writeTrainingJobFile(config, {
			jobId: 'job-1',
			modelCheckpointId: 'model-a',
			parentCheckpointId: null,
			lineageId: 'model-a',
			createdAt: '2026-03-31T00:02:00.000Z',
			requestedBy: 'daemon',
			status: 'pending',
			bundleDir: path.join(stateRoot, 'training/bundles/job-1'),
			manifestPath: path.join(stateRoot, 'training/bundles/job-1/manifest.json'),
			matchCount: 5,
			exampleCount: 5,
			exampleFiles: [],
			matchIds: [],
			outboundWebhookDeliveredAt: null,
			outboundWebhookError: null,
			completionPayload: null,
			error: null,
		});
		await writeControlRequest(config, {
			id: 'control-1',
			type: 'resume',
			createdAt: '2026-03-31T00:02:10.000Z',
			requestedBy: 'tester',
		});

		const status = await loadModelLeagueDaemonStatus(configPath);
		assert.equal(status.status, 'running');
		assert.equal(status.paused, false);
		assert.equal(status.pid, 1234);
		assert.equal(status.loopCount, 9);
		assert.equal(status.trainingJobs, 1);
		assert.equal(status.queuedControlRequests, 1);
		assert.equal(status.checkpoints, 2);
		assert.equal(status.teams, 2);
		assert.equal(status.stats.trainingBundles, 0);
		assert.equal(status.benchmarkProgress.total, 1);
		assert.equal(status.benchmarkProgress.cleared, 0);
	});

	it('queues CLI control requests into the file-backed queue and reflects them in status', async () => {
		const config = loadModelLeagueConfig(configPath);
		await ensureModelLeagueDirectories(config);
		const initialState = loadModelLeagueState(config, configPath);
		saveModelLeagueState(config, initialState);

		await writeControlRequest(config, {
			id: 'control-1',
			type: 'pause',
			createdAt: '2026-03-31T00:03:00.000Z',
			requestedBy: 'tester',
		});

		await runModelLeagueCLI(['--config', configPath, 'enqueue-training', 'model-b']);

		const queueDir = getModelLeagueControlQueuePath(config);
		const queueEntries = fs.readdirSync(queueDir).filter(name => name.endsWith('.json'));
		assert.equal(queueEntries.length, 2);

		const queuedRequests = queueEntries.map(fileName => JSON.parse(fs.readFileSync(path.join(queueDir, fileName), 'utf8')));
		assert.equal(queuedRequests.some(request => request.type === 'enqueue-training' && request.modelCheckpointId === 'model-b'), true);

		const status = await loadModelLeagueDaemonStatus(configPath);
		assert.equal(status.queuedControlRequests, 2);
	});
});
