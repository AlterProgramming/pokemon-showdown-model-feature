'use strict';

const assert = require('assert').strict;

const {
	normalizeRLModelProfile,
	resolveRLModelProfileConfig,
} = require('../../../dist/sim/tools/rl-model-profiles');

describe('RL model profiles', () => {
	it('should normalize value-head aliases to the joint policy value profile', () => {
		assert.equal(normalizeRLModelProfile('joint-policy-value'), 'joint-policy-value');
		assert.equal(normalizeRLModelProfile('value-head'), 'joint-policy-value');
	});

	it('should resolve the new profile as a switch-capable joint policy contract', () => {
		const profile = resolveRLModelProfileConfig('joint-policy-value');

		assert.equal(profile.profile, 'joint-policy-value');
		assert.equal(profile.allowVoluntarySwitches, true);
	});
});
