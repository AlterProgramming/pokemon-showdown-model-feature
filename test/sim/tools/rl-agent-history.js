'use strict';

const assert = require('node:assert/strict');
const {appendRLModelStateHistory} = require('../../../dist/sim/tools/rl-agent');

describe('RL agent model state history', function () {
	it('keeps a bounded copied history for sequence models', function () {
		const history = [];
		const first = appendRLModelStateHistory(history, [1, 2], 3);
		assert.deepEqual(first, [[1, 2]]);

		const secondVector = [3, 4];
		const second = appendRLModelStateHistory(first, secondVector, 3);
		secondVector[0] = 99;
		assert.deepEqual(second, [[1, 2], [3, 4]]);

		const third = appendRLModelStateHistory(second, [5, 6], 3);
		const fourth = appendRLModelStateHistory(third, [7, 8], 3);
		assert.deepEqual(fourth, [[3, 4], [5, 6], [7, 8]]);
	});
});
