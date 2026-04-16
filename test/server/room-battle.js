'use strict';

const assert = require('assert').strict;

const { makeUser } = require('../users-utils');
const { Teams } = require('../../dist/sim/teams');

function waitUntil(check, timeoutMs = 1000, intervalMs = 10) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			try {
				if (check()) return resolve();
			} catch (error) {
				return reject(error);
			}
			if (Date.now() - start >= timeoutMs) {
				return reject(new Error('Timed out waiting for condition.'));
			}
			setTimeout(tick, intervalMs);
		};
		tick();
	});
}

describe('Simulator abstraction layer features', () => {
	describe('Battle', () => {
		let p1, p2, room;
		let originalFetch;
		afterEach(() => {
			if (originalFetch !== undefined) {
				global.fetch = originalFetch;
				originalFetch = undefined;
			}
			if (p1) {
				p1.disconnectAll();
				p1.destroy();
			}
			if (p2) {
				p2.disconnectAll();
				p2.destroy();
			}
			if (room) room.destroy();
		});

		it('should not get players out of sync in rated battles on rename', () => {
			// Regression test for 47263c8749
			const packedTeam = 'Weavile||lifeorb||swordsdance,knockoff,iceshard,iciclecrash|Jolly|,252,,,4,252|||||';
			p1 = makeUser("MissingNo.");
			p2 = makeUser();
			room = Rooms.createBattle({
				format: '',
				players: [{ user: p1, team: packedTeam }, { user: p2, team: packedTeam }],
				allowRenames: false,
			});
			assert(room.battle);
			p1.resetName();
			for (const player of room.battle.players) {
				assert.equal(player, room.battle.playerTable[toID(player.name)]);
			}
		});

		it('should feed automated model opponents only their side-filtered battle state', async () => {
			originalFetch = global.fetch;
			const modelRequests = [];
			global.fetch = async (url, options) => {
				modelRequests.push({
					url,
					body: JSON.parse(options.body),
				});
				return new global.Response(JSON.stringify({
					type: 'move',
					best_move: { slot: 1 },
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			};

			const bulkyTeam = Teams.pack([
				{
					name: 'Chansey',
					species: 'Chansey',
					item: 'Leftovers',
					ability: 'Natural Cure',
					moves: ['Soft-Boiled', 'Seismic Toss'],
					nature: 'Bold',
					evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
				},
				{
					name: 'Skarmory',
					species: 'Skarmory',
					item: 'Leftovers',
					ability: 'Sturdy',
					moves: ['Protect', 'Roost'],
					nature: 'Impish',
					evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
				},
			]);
			p1 = makeUser('Human');
			room = Rooms.createBattle({
				format: 'gen9customgame@@@!Team Preview',
				players: [
					{ user: p1, team: bulkyTeam },
					{
						user: null,
						name: 'Model Bot',
						avatar: '169',
						team: bulkyTeam,
						automation: {
							type: 'rl-model',
							endpoint: 'http://model.invalid/predict',
							modelID: 'model-test',
							modelProfile: 'joint-policy',
						},
					},
				],
			});
			assert(room.battle);
			assert.equal(room.title, 'Human vs. Model Bot');
			assert.equal(room.battle.p2.name, 'Model Bot');
			assert.equal(room.battle.p2.isAutomated, true);

			await waitUntil(() => modelRequests.length >= 1);
			const firstRequest = modelRequests[0].body;
			assert.equal(firstRequest.perspective_player, 'p2');
			assert.equal(firstRequest.side.name, 'Model Bot');

			assert.deepEqual(firstRequest.battle_state.p1.slots.slice(1).filter(Boolean), []);
			const opponentMons = Object.values(firstRequest.battle_state.mons)
				.filter(mon => mon.player === 'p1');
			assert.equal(opponentMons.length, 1);
			assert.equal(opponentMons[0].uid, firstRequest.battle_state.p1.active_uid);

			room.battle.choose(p1, 'move 1');
			await waitUntil(() => modelRequests.length >= 2);
		});

		it('should score model victories as losses for the human side', () => {
			originalFetch = global.fetch;
			global.fetch = async () => new global.Response(JSON.stringify({
				type: 'move',
				best_move: { slot: 1 },
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});

			const originalLogChallenges = Config.logchallenges;
			Config.logchallenges = true;
			try {
				const bulkyTeam = Teams.pack([
					{
						name: 'Chansey',
						species: 'Chansey',
						item: 'Leftovers',
						ability: 'Natural Cure',
						moves: ['Soft-Boiled', 'Seismic Toss'],
						nature: 'Bold',
						evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
					},
				]);
				p1 = makeUser('Human');
				room = Rooms.createBattle({
					format: 'gen9customgame@@@!Team Preview',
					players: [
						{ user: p1, team: bulkyTeam },
						{
							user: null,
							name: 'Model Bot',
							avatar: '169',
							team: bulkyTeam,
							automation: {
								type: 'rl-model',
								endpoint: 'http://model.invalid/predict',
								modelID: 'model-test',
								modelProfile: 'joint-policy',
							},
						},
					],
				});
				assert(room.battle);

				let loggedScore = null;
				room.battle.logBattle = score => {
					loggedScore = score;
					return Promise.resolve();
				};

				room.battle.end('Model Bot');
				assert.equal(loggedScore, 0);
			} finally {
				Config.logchallenges = originalLogChallenges;
			}
		});
	});

	describe('BattleStream', () => {
		it('should work (slow)', async () => {
			Config.simulatorprocesses = 1;
			const PM = require('../../dist/server/room-battle').PM;
			assert.equal(PM.processes.length, 0);
			PM.spawn(1, true);
			assert.equal(PM.processes[0].getLoad(), 0);

			const stream = PM.createStream();
			assert.equal(PM.processes[0].getLoad(), 1);
			stream.write(
				'>version a2393dfd2a2da5594148bf99eea514e72b136c2c\n' +
				'>start {"formatid":"gen8randombattle","seed":[9619,36790,28450,62465],"rated":"Rated battle"}\n' +
				'>player p1 {"name":"p1","avatar":"ethan","team":"","rating":1507,"seed":[59512,58581,51338,7861]}\n' +
				'>player p2 {"name":"p2","avatar":"dawn","team":"","rating":1447,"seed":[33758,53485,62378,29757]}\n'
			);
			assert((await stream.read()).includes('|switch|'));
			assert((await stream.read()).startsWith('sideupdate\np1\n|request|'));
			assert((await stream.read()).startsWith('sideupdate\np2\n|request|'));
			stream.write(
				'>p1 move 1\n' +
				'>p2 move 1\n'
			);
			assert((await stream.read()).includes('|move|'));
			assert((await stream.read()).startsWith('sideupdate\np1\n|request|'));
			assert((await stream.read()).startsWith('sideupdate\np2\n|request|'));
			stream.destroy();
			assert.equal(PM.processes[0].getLoad(), 0);

			const stream2 = PM.createStream();
			assert.equal(PM.processes[0].getLoad(), 1);
			stream2.write(
				'>version a2393dfd2a2da5594148bf99eea514e72b136c2c\n' +
				'>start {"formatid":"gen8randombattle","seed":[9619,36790,28450,62465],"rated":"Rated battle"}\n' +
				'>player p1 {"name":"p1","avatar":"ethan","team":"","rating":1507,"seed":[59512,58581,51338,7861]}\n' +
				'>player p2 {"name":"p2","avatar":"dawn","team":"","rating":1447,"seed":[33758,53485,62378,29757]}\n' +
				'>p1 move 1\n' +
				'>p2 move 1\n'
			);
			assert(await stream2.read());
			stream2.writeEnd();
			await stream2.readAll();
			assert.equal(PM.processes[0].getLoad(), 0);
			PM.unspawn();
		});
	});
});
