'use strict';

const assert = require('assert').strict;

const {RLModelClient} = require('../../../dist/sim/tools/rl-model-client');
const {ensureLocalWordPolicyHandler} = require('../../../dist/sim/tools/word-policy-local');

describe('RLModelClient', () => {
	const originalFetch = global.fetch;
	const originalWarn = console.warn;

	afterEach(() => {
		global.fetch = originalFetch;
		console.warn = originalWarn;
		RLModelClient.unregisterLocalHandler('local://test-word-policy');
	});

	it('should persist the last successful exchange', async () => {
		global.fetch = async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => JSON.stringify({type: 'move', best_move: {slot: 1}}),
		});

		const client = new RLModelClient({
			endpoint: 'http://127.0.0.1:5000/predict',
			modelID: 'test-model',
			modelProfile: 'joint-policy',
		});
		const payload = {state_vector: [1, 2, 3], side: {id: 'p1', name: 'Bot'}};
		const response = await client.query(payload, () => 'p1 (Bot)');

		assert.deepEqual(response, {type: 'move', best_move: {slot: 1}});
		assert.equal(client.lastRequest, payload);
		assert.deepEqual(client.lastResponse, {type: 'move', best_move: {slot: 1}});
	});

	it('should retry once after a retryable 503 response', async () => {
		let fetchCount = 0;
		console.warn = () => {};
		global.fetch = async () => {
			fetchCount++;
			if (fetchCount === 1) {
				return {
					ok: false,
					status: 503,
					statusText: 'SERVICE UNAVAILABLE',
					text: async () => JSON.stringify({error: 'worker timed out', retryable: true}),
				};
			}
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				text: async () => JSON.stringify({type: 'move', best_move: {slot: 2}}),
			};
		};

		const client = new RLModelClient({
			endpoint: 'http://127.0.0.1:5000/predict',
			modelID: 'test-model',
			modelProfile: 'joint-policy',
			retryDelayMs: 0,
		});
		const payload = {state_vector: [1, 2, 3], side: {id: 'p1', name: 'Bot'}};
		const response = await client.query(payload, () => 'p1 (Bot)');

		assert.equal(fetchCount, 2);
		assert.deepEqual(response, {type: 'move', best_move: {slot: 2}});
		assert.equal(client.lastRequest, payload);
		assert.deepEqual(client.lastResponse, {type: 'move', best_move: {slot: 2}});
	});

	it('should support the IPC transport', async function () {
		this.timeout(15000);

		const client = new RLModelClient({
			endpoint: 'ipc://word-policy',
			transport: 'ipc',
			modelID: 'test-model',
			modelProfile: 'joint-policy',
		});
		const payload = {
			battle_state: {
				p1: {active_uid: 'p1a', slots: ['p1a', 'p1b']},
				p2: {active_uid: 'p2a', slots: ['p2a', 'p2b']},
				mons: {
					p1a: {uid: 'p1a', species: 'Pikachu', hp_frac: 0.7, fainted: false, boosts: {}, observed_moves: []},
					p1b: {uid: 'p1b', species: 'Bulbasaur', hp_frac: 1.0, fainted: false, boosts: {}, observed_moves: []},
					p2a: {uid: 'p2a', species: 'Squirtle', hp_frac: 0.4, fainted: false, boosts: {}, observed_moves: []},
					p2b: {uid: 'p2b', species: 'Charmander', hp_frac: 1.0, fainted: false, boosts: {}, observed_moves: []},
				},
			},
			perspective_player: 'p1',
			legal_moves: [{move: 'Thunderbolt', slot: 1}],
			legal_switches: [{slot: 2, hp_frac: 1.0}],
			active: [{}],
			side: {id: 'p1', name: 'Bot'},
		};

		const response = await client.query(payload, () => 'p1 (Bot)');

		assert.equal(response.type, 'move');
		assert.equal(client.lastRequest, payload);
		assert.deepEqual(client.lastResponse, response);
	});

	it('should support the local transport', async () => {
		RLModelClient.registerLocalHandler('local://test-word-policy', payload => ({
			type: 'move',
			best_move: {slot: payload.legal_moves[0].slot},
		}));

		const client = new RLModelClient({
			endpoint: 'local://test-word-policy',
			transport: 'local',
			modelID: 'word_policy_v1',
			modelProfile: 'joint-policy',
		});
		const payload = {
			battle_state: {p1: {}, p2: {}, mons: {}},
			perspective_player: 'p1',
			legal_moves: [{move: 'Thunderbolt', slot: 1}],
			legal_switches: [],
		};

		const response = await client.query(payload, () => 'p1');

		assert.deepEqual(response, {type: 'move', best_move: {slot: 1}});
		assert.equal(client.lastRequest, payload);
		assert.deepEqual(client.lastResponse, response);
	});

	it('should support the built-in local word policy handler', async () => {
		ensureLocalWordPolicyHandler('local://word-policy');

		const client = new RLModelClient({
			endpoint: 'local://word-policy',
			transport: 'local',
			modelID: 'word_policy_v1',
			modelProfile: 'joint-policy',
		});
		const payload = {
			battle_state: {
				p1: {active_uid: 'p1a', slots: ['p1a', 'p1b']},
				p2: {active_uid: 'p2a', slots: ['p2a']},
				mons: {
					p1a: {uid: 'p1a', species: 'Pikachu', hp_frac: 0.8, fainted: false, boosts: {}, observed_moves: []},
					p1b: {uid: 'p1b', species: 'Bulbasaur', hp_frac: 1.0, fainted: false, boosts: {}, observed_moves: []},
					p2a: {uid: 'p2a', species: 'Squirtle', hp_frac: 0.35, fainted: false, boosts: {}, observed_moves: []},
				},
			},
			perspective_player: 'p1',
			legal_moves: [
				{move: 'Thunderbolt', id: 'thunderbolt', slot: 1},
				{move: 'Growl', id: 'growl', slot: 2},
			],
			legal_switches: [{slot: 2, hp_frac: 1.0}],
			active: [{}],
		};

		const response = await client.query(payload, () => 'p1');

		assert.equal(response.type, 'move');
		assert.equal(response.best_move.slot, 1);
		assert.equal(client.lastRequest, payload);
		assert.deepEqual(client.lastResponse, response);
	});
});
