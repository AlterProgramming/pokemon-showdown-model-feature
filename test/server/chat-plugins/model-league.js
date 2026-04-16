'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const {makeUser, destroyUser} = require('../../users-utils');
const {Teams} = require('../../../dist/sim/teams');

const CONFIG_PATH = path.resolve(__dirname, '../../../config/model-league.json');
const ACTIVE_CONFIG_POINTER_PATH = path.resolve(__dirname, '../../../databases/model-league/active-config.json');
const FIXTURE_ROOT = path.resolve(__dirname, '../../tmp/model-league');
const STATE_ROOT = path.join(FIXTURE_ROOT, 'state');
const LOG_ROOT = path.join(FIXTURE_ROOT, 'logs');
const STATE_PATH = path.join(STATE_ROOT, 'state.json');
const QUEUE_DIR = path.join(STATE_ROOT, 'control-requests');

function makePackedTeam(species, moves) {
	return Teams.pack([{
		name: species,
		species,
		item: 'Leftovers',
		ability: 'Pressure',
		moves,
		nature: 'Serious',
		evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
	}]);
}

function makeFixtureConfig() {
	return {
		version: 1,
		format: 'gen9customgame@@@!Team Preview',
		stateRoot: STATE_ROOT.replace(/\\/g, '/'),
		logRoot: LOG_ROOT.replace(/\\/g, '/'),
		models: [
			{
				id: 'model-a',
				name: 'Model A',
				modelID: 'model-a',
				endpoint: 'https://example.invalid/model-a',
				modelProfile: 'joint-policy',
				allowVoluntarySwitches: true,
				active: true,
				archived: false,
				lineageId: 'model-a',
				sampleWeight: 1,
				allowedTeamIds: ['team-a'],
			},
			{
				id: 'model-b',
				name: 'Model B',
				modelID: 'model-b',
				endpoint: 'https://example.invalid/model-b',
				modelProfile: 'joint-policy',
				allowVoluntarySwitches: false,
				active: false,
				archived: true,
				parentCheckpointId: 'model-a',
				lineageId: 'model-a',
				sampleWeight: 0.5,
				allowedTeamIds: ['team-a'],
			},
		],
		teams: [
			{
				id: 'team-a',
				name: 'Team A',
				packedTeam: makePackedTeam('Pikachu', ['Thunderbolt', 'Quick Attack']),
				active: true,
				archived: false,
				sampleWeight: 1,
			},
			{
				id: 'team-b',
				name: 'Team B',
				packedTeam: makePackedTeam('Bulbasaur', ['Razor Leaf', 'Sleep Powder']),
				active: false,
				archived: true,
				sampleWeight: 0.5,
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
			outputDir: 'logs/model-league/replays',
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

function makeFixtureState() {
	return {
		version: 1,
		updatedAt: '2026-03-31T00:00:00.000Z',
		configPath: 'config/model-league.json',
		daemon: {
			status: 'running',
			pid: 4242,
			startedAt: '2026-03-31T00:00:00.000Z',
			heartbeatAt: '2026-03-31T00:01:00.000Z',
			lastLoopAt: '2026-03-31T00:00:30.000Z',
			loopCount: 12,
			activeTask: {
				type: 'live',
				startedAt: '2026-03-31T00:00:20.000Z',
				description: 'Live ladder match',
			},
			lastError: null,
			webhook: {
				enabled: false,
				listening: false,
				host: null,
				port: null,
				path: null,
				lastReceivedAt: null,
				lastError: null,
			},
		},
		checkpoints: [
			{
				id: 'model-a',
				name: 'Model A',
				modelID: 'model-a',
				endpoint: 'https://example.invalid/model-a',
				modelProfile: 'joint-policy',
				allowVoluntarySwitches: true,
				active: true,
				archived: false,
				lineageId: 'model-a',
				parentCheckpointId: null,
				sampleWeight: 1,
				allowedTeamIds: ['team-a'],
				createdAt: '2026-03-31T00:00:00.000Z',
				lastTrainingJobAt: null,
				matchCount: 7,
				liveMatchCount: 4,
				historicalMatchCount: 2,
				benchmarkMatchCount: 1,
				exampleCount: 21,
				trainingBuffer: {
					matchCount: 4,
					exampleCount: 18,
					exampleFiles: [],
					matchIds: [],
					lastBundleCreatedAt: null,
				},
				metadata: null,
			},
			{
				id: 'model-b',
				name: 'Model B',
				modelID: 'model-b',
				endpoint: 'https://example.invalid/model-b',
				modelProfile: 'joint-policy',
				allowVoluntarySwitches: false,
				active: false,
				archived: true,
				lineageId: 'model-a',
				parentCheckpointId: 'model-a',
				sampleWeight: 0.5,
				allowedTeamIds: ['team-a'],
				createdAt: '2026-03-30T00:00:00.000Z',
				lastTrainingJobAt: '2026-03-31T00:00:10.000Z',
				matchCount: 5,
				liveMatchCount: 1,
				historicalMatchCount: 3,
				benchmarkMatchCount: 1,
				exampleCount: 14,
				trainingBuffer: {
					matchCount: 2,
					exampleCount: 10,
					exampleFiles: [],
					matchIds: [],
					lastBundleCreatedAt: '2026-03-31T00:00:10.000Z',
				},
				metadata: null,
			},
		],
		teams: [
			{
				id: 'team-a',
				name: 'Team A',
				packedTeam: makePackedTeam('Pikachu', ['Thunderbolt', 'Quick Attack']),
				active: true,
				archived: false,
				sampleWeight: 1,
				createdAt: '2026-03-31T00:00:00.000Z',
				matchCount: 6,
				liveMatchCount: 3,
				historicalMatchCount: 2,
				benchmarkMatchCount: 1,
				metadata: null,
			},
			{
				id: 'team-b',
				name: 'Team B',
				packedTeam: makePackedTeam('Bulbasaur', ['Razor Leaf', 'Sleep Powder']),
				active: false,
				archived: true,
				sampleWeight: 0.5,
				createdAt: '2026-03-30T00:00:00.000Z',
				matchCount: 4,
				liveMatchCount: 1,
				historicalMatchCount: 2,
				benchmarkMatchCount: 1,
				metadata: null,
			},
		],
		modelRatings: [
			{
				id: 'model-a',
				name: 'Model A',
				elo: 1540,
				wins: 9,
				losses: 3,
				ties: 1,
				totalMatches: 13,
				lastUpdatedAt: '2026-03-31T00:00:30.000Z',
				lastOpponentId: 'model-b',
			},
			{
				id: 'model-b',
				name: 'Model B',
				elo: 1460,
				wins: 4,
				losses: 8,
				ties: 1,
				totalMatches: 13,
				lastUpdatedAt: '2026-03-31T00:00:20.000Z',
				lastOpponentId: 'model-a',
			},
		],
		teamRatings: [
			{
				id: 'team-a',
				name: 'Team A',
				elo: 1515,
				wins: 8,
				losses: 2,
				ties: 1,
				totalMatches: 11,
				lastUpdatedAt: '2026-03-31T00:00:30.000Z',
				lastOpponentId: 'team-b',
			},
			{
				id: 'team-b',
				name: 'Team B',
				elo: 1485,
				wins: 3,
				losses: 6,
				ties: 2,
				totalMatches: 11,
				lastUpdatedAt: '2026-03-31T00:00:20.000Z',
				lastOpponentId: 'team-a',
			},
		],
		recentMatches: [],
		recentBenchmarkRuns: [],
		benchmarkProgress: [
			{
				id: 'tower-1',
				name: 'Tower 1',
				level: 1,
				requiredWinRate: 0.5,
				lastRunAt: '2026-03-31T00:00:00.000Z',
				lastChallengerModelId: 'model-a',
				lastChallengerTeamId: 'team-a',
				lastWinRate: 0.67,
				lastConfidenceLow: 0.5,
				lastConfidenceHigh: 0.83,
				cleared: true,
				clearedAt: '2026-03-31T00:00:00.000Z',
			},
		],
		trainingJobs: [
			{
				jobId: 'job-pending-1',
				modelCheckpointId: 'model-a',
				parentCheckpointId: null,
				lineageId: 'model-a',
				createdAt: '2026-03-31T00:00:05.000Z',
				requestedBy: 'system',
				status: 'pending',
				bundleDir: 'training/pending/job-pending-1',
				manifestPath: 'training/pending/job-pending-1/manifest.json',
				matchCount: 4,
				exampleCount: 12,
				exampleFiles: [],
				matchIds: [],
				outboundWebhookDeliveredAt: null,
				outboundWebhookError: null,
				completionPayload: null,
				error: null,
			},
		],
		processedControlRequestIds: [],
		processedCompletedJobIds: [],
		stats: {
			liveMatches: 7,
			historicalMatches: 4,
			benchmarkRuns: 2,
			trainingBundles: 1,
			decisionExamplesCaptured: 18,
		},
	};
}

function backupConfigFile() {
	if (fs.existsSync(CONFIG_PATH)) {
		return fs.readFileSync(CONFIG_PATH, 'utf8');
	}
	return null;
}

function restoreConfigFile(backup) {
	if (backup === null) {
		fs.rmSync(CONFIG_PATH, {force: true});
		return;
	}
	fs.mkdirSync(path.dirname(CONFIG_PATH), {recursive: true});
	fs.writeFileSync(CONFIG_PATH, backup);
}

function backupActiveConfigPointer() {
	if (fs.existsSync(ACTIVE_CONFIG_POINTER_PATH)) {
		return fs.readFileSync(ACTIVE_CONFIG_POINTER_PATH, 'utf8');
	}
	return null;
}

function restoreActiveConfigPointer(backup) {
	if (backup === null) {
		fs.rmSync(ACTIVE_CONFIG_POINTER_PATH, {force: true});
		return;
	}
	fs.mkdirSync(path.dirname(ACTIVE_CONFIG_POINTER_PATH), {recursive: true});
	fs.writeFileSync(ACTIVE_CONFIG_POINTER_PATH, backup);
}

function writeActiveConfigPointer(configPath) {
	fs.mkdirSync(path.dirname(ACTIVE_CONFIG_POINTER_PATH), {recursive: true});
	fs.writeFileSync(ACTIVE_CONFIG_POINTER_PATH, JSON.stringify({
		configPath,
		updatedAt: '2026-03-31T00:00:00.000Z',
		pid: 4242,
	}, null, 2));
}

function writeFixtureFiles() {
	fs.mkdirSync(STATE_ROOT, {recursive: true});
	fs.mkdirSync(LOG_ROOT, {recursive: true});
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(makeFixtureConfig(), null, 2));
	fs.writeFileSync(STATE_PATH, JSON.stringify(makeFixtureState(), null, 2));
}

function readQueueFiles() {
	if (!fs.existsSync(QUEUE_DIR)) return [];
	return fs.readdirSync(QUEUE_DIR).filter(file => file.endsWith('.json')).sort();
}

describe('Model League admin surface', () => {
	let originalConfig;
	let originalActiveConfigPointer;
	let originalNoFsWriting;
	let createdDevelopmentRoom = false;
	let adminUser;
	let viewerUser;

	before(() => {
		Chat.loadPlugins();
	});

	beforeEach(() => {
		originalConfig = backupConfigFile();
		originalActiveConfigPointer = backupActiveConfigPointer();
		originalNoFsWriting = Config.nofswriting;
		Config.nofswriting = false;
		writeFixtureFiles();
		if (!Rooms.get('development')) {
			Rooms.createChatRoom('development', 'Development');
			createdDevelopmentRoom = true;
		}
		adminUser = makeUser('ModelLeagueAdmin');
		adminUser.tempGroup = '~';
		adminUser.updateIdentity();
		viewerUser = makeUser('ModelLeagueViewer');
	});

	afterEach(() => {
		Config.nofswriting = originalNoFsWriting;
		if (adminUser) {
			destroyUser(adminUser);
			adminUser = null;
		}
		if (viewerUser) {
			destroyUser(viewerUser);
			viewerUser = null;
		}
		if (createdDevelopmentRoom) {
			Rooms.get('development')?.destroy();
			createdDevelopmentRoom = false;
		}
		fs.rmSync(FIXTURE_ROOT, {recursive: true, force: true});
		restoreConfigFile(originalConfig);
		restoreActiveConfigPointer(originalActiveConfigPointer);
	});

	it('renders the admin page with daemon, checkpoint, team, benchmark, and training sections', async () => {
		const pageContext = {
			title: '',
			checkCan(permission, target, room) {
				if (!adminUser.can(permission, target, room)) {
					throw new Chat.ErrorMessage('Permission denied.');
				}
			},
		};
		const html = await Chat.pages.modelleague.call(pageContext, [], adminUser, adminUser.connections[0]);
		assert.match(html, /Model League Admin/);
		assert.match(html, /Daemon status/);
		assert.match(html, /Heartbeat/);
		assert.match(html, /Checkpoints/);
		assert.match(html, /Archived/);
		assert.match(html, /Teams/);
		assert.match(html, /Pending Training Jobs/);
		assert.match(html, /Benchmark Tower/);
		assert.match(html, /Model Leaderboard/);
		assert.match(html, /Team Leaderboard/);
		assert.match(html, /Pending Control Requests/);
		assert.match(html, /Pause daemon/);
		assert.match(html, /Force benchmark/);
		assert.match(html, /Queue training/);
	});

	it('rejects non-admin users from the page', async () => {
		const pageContext = {
			title: '',
			checkCan(permission, target, room) {
				if (!viewerUser.can(permission, target, room)) {
					throw new Chat.ErrorMessage('Permission denied.');
				}
			},
		};
		await assert.rejects(
			() => Chat.pages.modelleague.call(pageContext, [], viewerUser, viewerUser.connections[0]),
			/Permission denied/
		);
	});

	it('queues control requests for daemon actions', async () => {
		const devRoom = Rooms.get('development');
		assert.equal(readQueueFiles().length, 0);
		const commandContext = {
			checkCan(permission, target, room) {
				if (!adminUser.can(permission, target, room)) {
					throw new Chat.ErrorMessage('Permission denied.');
				}
			},
			sendReply() {},
		};

		const cases = [
			[Chat.commands.modelleague.pause, '', 'pause', null],
			[Chat.commands.modelleague.resume, '', 'resume', null],
			[Chat.commands.modelleague.forcebenchmark, '', 'force-benchmark', null],
			[Chat.commands.modelleague.forcesnapshot, '', 'force-snapshot', null],
			[Chat.commands.modelleague.enqueuetraining, 'model-b', 'enqueue-training', 'model-b'],
		];
		for (const [handler, target, expectedType, expectedCheckpointId] of cases) {
			const previousCount = readQueueFiles().length;
			await handler.call(commandContext, target, devRoom, adminUser, adminUser.connections[0]);
			const requests = readQueueFiles().map(file => JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, file), 'utf8')));
			assert.equal(requests.length, previousCount + 1);
			const request = requests.find(entry => entry.type === expectedType);
			assert.ok(request, `Expected a ${expectedType} control request.`);
			assert.equal(request.requestedBy, adminUser.id);
			if (expectedCheckpointId) {
				assert.equal(request.modelCheckpointId, expectedCheckpointId);
			}
		}
	});

	it('uses the active runtime config pointer for page rendering and queued actions', async () => {
		const customConfigPath = path.join(FIXTURE_ROOT, 'custom', 'model-league.custom.json');
		const customStateRoot = path.join(FIXTURE_ROOT, 'custom-state');
		const customLogRoot = path.join(FIXTURE_ROOT, 'custom-logs');
		const customQueueDir = path.join(customStateRoot, 'control-requests');
		const customConfig = makeFixtureConfig();
		customConfig.format = 'gen9ou';
		customConfig.stateRoot = customStateRoot.replace(/\\/g, '/');
		customConfig.logRoot = customLogRoot.replace(/\\/g, '/');
		const customState = makeFixtureState();
		customState.configPath = customConfigPath.replace(/\\/g, '/');
		customState.daemon.loopCount = 77;
		customState.stats.liveMatches = 99;
		fs.mkdirSync(path.dirname(customConfigPath), {recursive: true});
		fs.mkdirSync(customStateRoot, {recursive: true});
		fs.mkdirSync(customLogRoot, {recursive: true});
		fs.writeFileSync(customConfigPath, JSON.stringify(customConfig, null, 2));
		fs.writeFileSync(path.join(customStateRoot, 'state.json'), JSON.stringify(customState, null, 2));
		writeActiveConfigPointer(customConfigPath);

		const pageContext = {
			title: '',
			checkCan(permission, target, room) {
				if (!adminUser.can(permission, target, room)) {
					throw new Chat.ErrorMessage('Permission denied.');
				}
			},
		};
		const html = await Chat.pages.modelleague.call(pageContext, [], adminUser, adminUser.connections[0]);
		assert.match(html, /gen9ou/);
		assert.match(html, /77/);
		assert.match(html, new RegExp(customConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

		const devRoom = Rooms.get('development');
		const commandContext = {
			checkCan(permission, target, room) {
				if (!adminUser.can(permission, target, room)) {
					throw new Chat.ErrorMessage('Permission denied.');
				}
			},
			sendReply() {},
		};
		await Chat.commands.modelleague.pause.call(commandContext, '', devRoom, adminUser, adminUser.connections[0]);
		const queued = fs.readdirSync(customQueueDir).filter(file => file.endsWith('.json'));
		assert.equal(queued.length, 1);
		const request = JSON.parse(fs.readFileSync(path.join(customQueueDir, queued[0]), 'utf8'));
		assert.equal(request.type, 'pause');
	});
});
