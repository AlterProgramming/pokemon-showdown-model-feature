'use strict';

const assert = require('assert').strict;

const { makeUser } = require('../../users-utils');
const { Teams } = require('../../../dist/sim/teams');

describe('Model battle rematches', () => {
	let user;
	let originalFetch;
	let originalModelBattles;
	const roomsToDestroy = [];

	before(() => {
		Chat.loadPlugins();
	});

	afterEach(() => {
		if (originalFetch !== undefined) {
			global.fetch = originalFetch;
			originalFetch = undefined;
		}
		if (originalModelBattles !== undefined) {
			Config.modelBattles = originalModelBattles;
			originalModelBattles = undefined;
		}
		while (roomsToDestroy.length) {
			const room = roomsToDestroy.pop();
			if (room?.battle || room?.users) room.destroy();
		}
		if (user) {
			user.disconnectAll();
			user.destroy();
			user = null;
		}
	});

	it('should replay a finished model battle with the same teams against another model', async () => {
		originalFetch = global.fetch;
		global.fetch = async () => new global.Response(JSON.stringify({
			type: 'move',
			best_move: { slot: 1 },
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

		originalModelBattles = Config.modelBattles;
		Config.modelBattles = [
			{
				id: 'model1',
				name: 'Model 1',
				endpoint: 'http://model.invalid/predict',
				modelID: 'model1',
				modelProfile: 'joint-policy',
				formats: ['gen9customgame@@@!Team Preview'],
				botName: 'Model 1',
				avatar: 169,
			},
			{
				id: 'model2',
				name: 'Model 2',
				endpoint: 'http://model.invalid/predict',
				modelID: 'model2',
				modelProfile: 'joint-policy',
				formats: ['gen9customgame@@@!Team Preview'],
				botName: 'Model 2',
				avatar: 170,
			},
		];

		const humanTeam = Teams.pack([
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
		const modelTeam = Teams.pack([
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

		user = makeUser('Human');
		const firstRoom = Rooms.createBattle({
			format: 'gen9customgame@@@!Team Preview',
			players: [
				{ user, team: humanTeam },
				{
					user: null,
					name: 'Model 1',
					avatar: '169',
					team: modelTeam,
					automation: {
						type: 'rl-model',
						endpoint: 'http://model.invalid/predict',
						modelID: 'model1',
						modelProfile: 'joint-policy',
					},
				},
			],
		});
		roomsToDestroy.push(firstRoom);
		assert(firstRoom?.battle);

		const originalHumanTeam = Teams.pack(await firstRoom.battle.getPlayerTeam(firstRoom.battle.p1));
		const originalModelTeam = Teams.pack(await firstRoom.battle.getPlayerTeam(firstRoom.battle.p2));

		firstRoom.battle.end('Human');
		await Chat.parse(`/modelbattle replay ${firstRoom.roomid}, model2`, null, user, user.connections[0]);

		assert.equal(user.games.size, 1);
		const [replayRoomid] = [...user.games];
		const replayRoom = Rooms.get(replayRoomid);
		roomsToDestroy.push(replayRoom);
		assert(replayRoom?.battle);
		assert.notEqual(replayRoom.roomid, firstRoom.roomid);
		assert.equal(replayRoom.battle.format, firstRoom.battle.format);
		assert.equal(replayRoom.battle.p2.automation.modelID, 'model2');
		assert.equal(replayRoom.battle.p2.name, 'Model 2');

		const replayHumanTeam = Teams.pack(await replayRoom.battle.getPlayerTeam(replayRoom.battle.p1));
		const replayModelTeam = Teams.pack(await replayRoom.battle.getPlayerTeam(replayRoom.battle.p2));
		assert.equal(replayHumanTeam, originalHumanTeam);
		assert.equal(replayModelTeam, originalModelTeam);
	});
});
