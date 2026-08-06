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

	it('should return undefined for unrecognized profile strings', () => {
		assert.equal(normalizeRLModelProfile('typo'), undefined);
		assert.equal(normalizeRLModelProfile('joint_policy_bad'), undefined);
		assert.equal(normalizeRLModelProfile(''), undefined);
	});

	it('should normalize all known aliases to canonical profile names', () => {
		assert.equal(normalizeRLModelProfile('moveonly'), 'move-only');
		assert.equal(normalizeRLModelProfile('model1'), 'move-only');
		assert.equal(normalizeRLModelProfile('joint'), 'joint-policy');
		assert.equal(normalizeRLModelProfile('model2'), 'joint-policy');
		assert.equal(normalizeRLModelProfile('custom'), 'custom');
	});

	it('should expose the Model1 NoT target as an explicit history-bearing profile', () => {
		assert.equal(normalizeRLModelProfile('model1-not-elman3'), 'not-elman-policy');
		const profile = resolveRLModelProfileConfig('not-elman-policy');
		assert.equal(profile.profile, 'not-elman-policy');
		assert.equal(profile.requiresStateHistory, true);
		assert.equal(profile.allowVoluntarySwitches, false);
	});
});
