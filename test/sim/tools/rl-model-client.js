'use strict';

const assert = require('assert').strict;

const {RLModelClient} = require('../../../dist/sim/tools/rl-model-client');

describe('RLModelClient', () => {
	const originalFetch = global.fetch;
	const originalWarn = console.warn;

	afterEach(() => {
		global.fetch = originalFetch;
		console.warn = originalWarn;
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
});
