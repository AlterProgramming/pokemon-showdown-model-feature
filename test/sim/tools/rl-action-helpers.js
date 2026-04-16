'use strict';

const assert = require('assert').strict;

const {
	buildLegalMoveOptions,
	buildLegalReviveTargets,
	buildLegalSwitchTargets,
	extractSwitchSlot,
	getPrimaryActivePokemon,
	hasReviveSelectionRequest,
	requestSlotForChoice,
} = require('../../../dist/sim/tools/rl-action-helpers');

describe('RL action helpers', () => {
	it('should derive move options without disabled moves', () => {
		const options = buildLegalMoveOptions({
			moves: [
				{move: 'Thunderbolt', id: 'thunderbolt', disabled: false},
				{move: 'Protect', id: 'protect', disabled: true},
				{move: 'Volt Switch', id: 'voltswitch'},
			],
		});

		assert.deepEqual(options, [
			{slot: 1, move: 'Thunderbolt', id: 'thunderbolt', disabled: false},
			{slot: 3, move: 'Volt Switch', id: 'voltswitch', disabled: false},
		]);
	});

	it('should pick the active pokemon and detect revive requests', () => {
		const team = [
			{ident: 'p1: Pikachu', details: 'Pikachu, L50', condition: '0 fnt', active: false, reviving: false},
			{ident: 'p1: Raichu', details: 'Raichu, L50', condition: '200/200', active: true, reviving: true},
		];

		assert.equal(getPrimaryActivePokemon(team), team[1]);
		assert.equal(hasReviveSelectionRequest(team), true);
	});

	it('should build switch and revive targets using stable slot resolution', () => {
		const team = [
			{ident: 'p1: Pikachu', details: 'Pikachu, L50', condition: '200/200', active: true, reviving: false},
			{ident: 'p1: Charizard', details: 'Charizard, L50', condition: '0 fnt', active: false, reviving: false},
			{ident: 'p1: Blastoise', details: 'Blastoise, L50', condition: '150/150', active: false, reviving: false},
		];
		const resolveStableSlot = (player, ident) => {
			assert.equal(player, 'p1');
			if (ident === 'p1: Blastoise') return 6;
			return undefined;
		};

		assert.deepEqual(buildLegalSwitchTargets('p1', team, resolveStableSlot), [
			{
				slot: 6,
				request_slot: 3,
				ident: 'p1: Blastoise',
				details: 'Blastoise, L50',
				condition: '150/150',
				active: false,
				fainted: false,
				reviving: false,
			},
		]);
		assert.deepEqual(buildLegalReviveTargets('p1', team, resolveStableSlot), [
			{
				slot: 2,
				request_slot: 2,
				ident: 'p1: Charizard',
				details: 'Charizard, L50',
				condition: '0 fnt',
				active: false,
				fainted: true,
				reviving: false,
			},
		]);
	});

	it('should resolve switch slots from model responses in priority order', () => {
		assert.equal(requestSlotForChoice({request_slot: 4, slot: 2}), 4);
		assert.equal(requestSlotForChoice({slot: 2}), 2);
		assert.equal(extractSwitchSlot({best_switch: {request_slot: 5, slot: 1}}), 5);
		assert.equal(extractSwitchSlot({best_revive: {slot: 3}}), 3);
		assert.equal(extractSwitchSlot({slot: 6}), 6);
	});
});
