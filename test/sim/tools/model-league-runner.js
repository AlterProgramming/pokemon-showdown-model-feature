'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const {Teams} = require('../../../dist/sim/teams');
const {ModelLeagueRunner} = require('../../../dist/sim/tools/model-league-runner');

describe('ModelLeagueRunner', () => {
	const originalFetch = global.fetch;
	let tempDir;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-league-runner-'));
	});

	afterEach(() => {
		global.fetch = originalFetch;
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	function makeTeam(species, move) {
		return Teams.pack([
			{
				name: species,
				species,
				item: 'Focus Sash',
				ability: 'Soundproof',
				moves: [move],
				nature: 'Jolly',
				evs: {hp: 252, atk: 252, def: 4, spa: 0, spd: 0, spe: 0},
			},
		]);
	}

	it('should run seeded side-swapped rollouts and capture per-decision examples', async () => {
		const requests = [];
		const savedReplays = [];
		global.fetch = async (url, options) => {
			requests.push({
				url,
				body: JSON.parse(options.body),
			});
			return new global.Response(JSON.stringify({
				type: 'move',
				best_move: {slot: 1},
			}), {
				status: 200,
				headers: {'Content-Type': 'application/json'},
			});
		};

		const runner = new ModelLeagueRunner({
			format: 'gen9customgame',
			modelA: {
				id: 'model-a',
				name: 'Model A',
				modelID: 'model-a-id',
				endpoint: 'http://model.invalid/a',
				modelProfile: 'joint-policy',
				teamId: 'team-a',
				team: makeTeam('Electrode', 'Thunderbolt'),
			},
			modelB: {
				id: 'model-b',
				name: 'Model B',
				modelID: 'model-b-id',
				endpoint: 'http://model.invalid/b',
				modelProfile: 'joint-policy',
				teamId: 'team-b',
				team: makeTeam('Magikarp', 'Splash'),
			},
			rollouts: 2,
			sideSwap: true,
			baseSeed: '1,2,3,4',
			captureTrainingExamples: true,
			captureReplays: true,
			replayCaptureMode: 'all',
			replayOutputDir: path.join(tempDir, 'replays'),
			replayCaptureCount: 2,
			battleTimeoutMs: 20_000,
			onReplaySaved: info => savedReplays.push(info),
		});

		const batch = await runner.runRolloutBatch({batchId: 'league-test', rollouts: 2});
		assert.equal(batch.batchId, 'league-test');
		assert.equal(batch.rollouts, 2);
		assert.equal(batch.sideSwap, true);
		assert.equal(batch.battles.length, 2);
		assert.equal(batch.modelAWins, 2);
		assert.equal(batch.modelBWins, 0);
		assert.equal(batch.ties, 0);
		assert.equal(batch.battles[0].p1.id, 'model-a');
		assert.equal(batch.battles[0].p2.id, 'model-b');
		assert.equal(batch.battles[1].p1.id, 'model-b');
		assert.equal(batch.battles[1].p2.id, 'model-a');
		assert.equal(batch.replayPaths.length, 2);
		assert.equal(savedReplays.length, 2);
		assert.equal(savedReplays.every(info => info.outcome === 'win'), true);
		assert.equal(batch.replayPaths.every(replayPath => fs.existsSync(replayPath)), true);
		assert.equal(requests.length > 0, true);
		assert.equal(batch.battles.every(battle => battle.trainingExamples.length > 0), true);
		assert.equal(batch.battles.every(battle => battle.trainingExamples.every(example => example.modelCheckpointId)), true);
		assert.equal(batch.battles.every(battle => battle.trainingExamples.every(example => example.teamId === 'team-a' || example.teamId === 'team-b')), true);
		assert.equal(batch.battles.every(battle => battle.trainingExamples.every(example => example.teamId !== example.modelCheckpointId)), true);
		assert.equal(batch.battles.every(battle => battle.trainingExamples.every(example => example.result)), true);
		assert.equal(batch.winRateA >= 0 && batch.winRateA <= 1, true);
		assert.equal(batch.confidenceLow >= 0 && batch.confidenceHigh <= 1, true);
	});
});
