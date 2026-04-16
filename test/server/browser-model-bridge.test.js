'use strict';

const assert = require('assert').strict;
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const userscript = require('../../tools/browser-model-battle-bridge.user.js');
const {
	BrowserModelBridgeServer,
	formatBrowserBridgeDebugSnapshot,
	normalizeBrowserModelRequest,
	validateNormalizedPredictRequest,
} = require('../../dist/server/browser-model-bridge');
const {ProtocolStateTracker} = require('../../dist/sim/tools/protocol-state-tracker');

function startServer(handler) {
	return new Promise((resolve, reject) => {
		const server = http.createServer(handler);
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve(server);
		});
	});
}

function stopServer(server) {
	return new Promise((resolve, reject) => {
		server.close(error => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function serverUrl(server, pathname = '/') {
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Server is not listening.');
	}
	return `http://127.0.0.1:${address.port}${pathname}`;
}

function postJson(urlString, payload) {
	const url = new URL(urlString);
	return new Promise((resolve, reject) => {
		const request = http.request({
			method: 'POST',
			hostname: url.hostname,
			port: url.port,
			path: `${url.pathname}${url.search}`,
			headers: {
				'Content-Type': 'application/json',
			},
		}, response => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => {
				body += chunk;
			});
			response.on('end', () => {
				resolve({
					status: response.statusCode || 0,
					body,
					headers: response.headers,
				});
			});
		});
		request.on('error', reject);
		request.write(JSON.stringify(payload));
		request.end();
	});
}

describe('browser model bridge', () => {
	describe('userscript helpers', () => {
		it('should resolve rooms from page-context collections only', () => {
			const room = {roomid: 'battle-gen9randombattle-99', battle: {}};
			const pageWindow = {
				app: {
					rooms: {
						roomList: [room],
					},
				},
			};
			const roomsApi = userscript.getRoomsApi(pageWindow);
			assert.equal(userscript.findRoomById('battle-gen9randombattle-99', roomsApi, pageWindow), room);
		});

		it('should extract requests from multiple live room shapes', () => {
			const request = {rqid: 12, side: {id: 'p2'}};
			const cases = [
				{room: {battle: {request}}, expectedSource: 'battle.request'},
				{room: {request}, expectedSource: 'room.request'},
				{room: {curRequest: request}, expectedSource: 'room.curRequest'},
				{room: {battle: {curRequest: request}}, expectedSource: 'battle.curRequest'},
				{room: {battle: {requestData: request}}, expectedSource: 'battle.requestData'},
				{room: {choice: {request}}, expectedSource: 'room.choice.request'},
			];

			for (const testCase of cases) {
				const details = userscript.getBattleRequestDetails(testCase.room);
				assert.equal(details.request, request);
				assert.equal(details.source, testCase.expectedSource);
			}
		});

		it('should prefer the freshest live request candidate', () => {
			const roomId = 'battle-gen9randombattle-102';
			const staleRequest = {rqid: 11, side: {id: 'p2'}};
			const freshRequest = {rqid: 12, side: {id: 'p2'}};
			const details = userscript.getBattleRequestDetails({
				battle: {request: freshRequest},
				choice: {request: staleRequest},
			}, {
				roomId,
				lastSeenRequestIdByRoom: new Map([[roomId, `${roomId}:rqid:11`]]),
			});
			assert.equal(details.request, freshRequest);
			assert.equal(details.source, 'battle.request');
		});

		it('should suppress duplicate rqid handling per room', () => {
			const roomId = 'battle-gen9randombattle-100';
			const request = {rqid: 4, side: {id: 'p2'}};
			const requestId = userscript.buildRequestIdentity(roomId, request);
			assert.equal(requestId, `${roomId}:rqid:4`);
			assert.deepEqual(
				userscript.shouldHandleRequest('', '', roomId, request),
				{shouldHandle: true, requestId, reason: 'new-request'}
			);
			assert.deepEqual(
				userscript.shouldHandleRequest(requestId, '', roomId, request),
				{shouldHandle: false, requestId, reason: 'already-handled'}
			);
			assert.deepEqual(
				userscript.shouldHandleRequest('', requestId, roomId, request),
				{shouldHandle: false, requestId, reason: 'in-flight'}
			);
		});

		it('should format /choose commands with rqid and include debug metadata', () => {
			assert.equal(userscript.buildChooseCommand('move 1', 14), '/choose move 1|14');
			assert.equal(
				userscript.responseToChoice({
					type: 'switch',
					best_switch: {slot: 4, request_slot: 2},
				}),
				'switch 2'
			);
			const payload = userscript.buildRequestPayload(
				{roomid: 'battle-gen9randombattle-101', battle: {log: []}},
				{rqid: 14, side: {id: 'p2', pokemon: []}},
				'room.request'
			);
			assert.equal(payload.browser_bridge_meta.script_version, userscript.SCRIPT_VERSION);
			assert.equal(payload.browser_bridge_meta.script_build, userscript.SCRIPT_BUILD);
			assert.equal(payload.browser_bridge_meta.request_source, 'room.request');
			assert.equal(payload.browser_bridge_meta.bridge_request_id, `0:battle-gen9randombattle-101:battle-gen9randombattle-101:rqid:14`);
			assert.equal(payload.browser_bridge_meta.request_identity, 'battle-gen9randombattle-101:rqid:14');
			assert.equal(payload.browser_bridge_meta.control_epoch, 0);
			assert.equal(payload.browser_bridge_meta.request_summary.rqid, 14);
		});

		it('should include browser-observable battle state in the outbound payload', () => {
			const payload = userscript.buildRequestPayload({
				room: {
					roomid: 'battle-gen9randombattle-observed-state',
					battle: {
						log: [],
						turn: 7,
						weather: 'sunnyday',
						globalConditions: ['trickroom'],
						mySide: {
							id: 'p2',
							sideConditions: {spikes: 1},
							pokemon: [
								{active: true, speciesForme: 'Hawlucha', hp: 200, maxhp: 240, moves: ['bravebird']},
							],
						},
						yourSide: {
							id: 'p1',
							pokemon: [
								{active: true, speciesForme: 'Gallade', hp: 240, maxhp: 240, moves: ['sacredsword']},
							],
						},
					},
				},
				request: {rqid: 17, side: {id: 'p2', pokemon: []}},
				requestSource: 'battle.request',
			});

			assert.equal(payload.browser_observations.turn_index, 7);
			assert.equal(payload.browser_observations.field.weather, 'sunnyday');
			assert.deepEqual(payload.browser_observations.field.global_conditions, ['trickroom']);
			assert.equal(payload.browser_observations.p1.active_uid, 'p1:slot1');
			assert.equal(payload.browser_observations.p1.slots[0], 'p1:slot1');
			assert.equal(payload.browser_observations.mons['p1:slot1'].species, 'Gallade');
		});

		it('should resolve switch responses against the live request and avoid active targets', () => {
			const request = {
				rqid: 31,
				side: {
					id: 'p2',
					pokemon: [
						{ident: 'p2: Hawlucha', details: 'Hawlucha, L80', condition: '120/256', active: true},
						{ident: 'p2: Iron Thorns', details: 'Iron Thorns, L83', condition: '302/302', active: false},
					],
				},
				legal_switches: [
					{slot: 1, request_slot: 1, ident: 'p2: Hawlucha', active: true},
					{slot: 2, request_slot: 2, ident: 'p2: Iron Thorns', active: false},
				],
			};
			assert.equal(
				userscript.responseToChoiceForRequest(request, {
					type: 'switch',
					best_switch: {slot: 1},
				}),
				'switch 2'
			);
			assert.equal(
				userscript.responseToChoiceForRequest(request, {
					type: 'switch',
					best_switch: {slot: 2},
				}),
				'switch 2'
			);
		});

		it('should resolve revive-target switch responses against legal revives when needed', () => {
			const request = {
				rqid: 32,
				forceSwitch: [true],
				side: {
					id: 'p1',
					pokemon: [
						{ident: 'p1: Whimsicott', details: 'Whimsicott, L84, F', condition: '0 fnt', active: true},
						{ident: 'p1: Kleavor', details: 'Kleavor, L78, M', condition: '237/237', active: false},
						{ident: 'p1: Spidops', details: 'Spidops, L96, M', condition: '232/271', active: false},
					],
				},
				legal_switches: [
					{slot: 2, request_slot: 2, ident: 'p1: Kleavor', active: false},
					{slot: 3, request_slot: 3, ident: 'p1: Spidops', active: false},
				],
				legal_revives: [
					{slot: 1, request_slot: 1, ident: 'p1: Whimsicott', active: true, fainted: true},
				],
			};
			assert.equal(
				userscript.responseToChoiceForRequest(request, {
					best_revive: {request_slot: 1},
				}),
				'switch 1'
			);
		});

		it('should honor action_token responses when the model omits explicit choice fields', () => {
			const request = {
				rqid: 33,
				forceSwitch: [true],
				side: {
					id: 'p1',
					pokemon: [
						{ident: 'p1: Whimsicott', details: 'Whimsicott, L84, F', condition: '0 fnt', active: true},
						{ident: 'p1: Kleavor', details: 'Kleavor, L78, M', condition: '237/237', active: false},
						{ident: 'p1: Spidops', details: 'Spidops, L96, M', condition: '232/271', active: false},
					],
				},
				legal_switches: [
					{slot: 2, request_slot: 2, ident: 'p1: Kleavor', active: false},
					{slot: 3, request_slot: 3, ident: 'p1: Spidops', active: false},
				],
				legal_revives: [
					{slot: 1, request_slot: 1, ident: 'p1: Whimsicott', active: true, fainted: true},
				],
			};
			assert.equal(
				userscript.responseToChoiceForRequest(request, {
					action_token: 'switch:3',
				}),
				'switch 3'
			);
		});

		it('should reuse the same bridge_request_id within an epoch and change it after pause/resume', () => {
			const runtime = userscript.createBridgeRuntime({
				window: {location: {pathname: '', hash: '#battle-gen9randombattle-epoch', href: ''}},
				document: {},
				pageWindow: {},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});
			const room = {roomid: 'battle-gen9randombattle-epoch', battle: {log: []}};
			const request = {rqid: 19, side: {id: 'p2', pokemon: []}};
			const first = runtime.buildRequestPayload({room, request, requestSource: 'battle.request'});
			const second = runtime.buildRequestPayload({room, request, requestSource: 'battle.request'});
			assert.equal(first.browser_bridge_meta.bridge_request_id, second.browser_bridge_meta.bridge_request_id);
			runtime.setEnabled(false);
			runtime.setEnabled(true);
			const third = runtime.buildRequestPayload({room, request, requestSource: 'battle.request'});
			assert.notEqual(third.browser_bridge_meta.bridge_request_id, first.browser_bridge_meta.bridge_request_id);
			assert.equal(third.browser_bridge_meta.control_epoch, 1);
		});

		it('should mark the next successful predict for bridge-side logging when armed', () => {
			const runtime = userscript.createBridgeRuntime({
				window: {location: {pathname: '', hash: '', href: ''}},
				document: {},
				pageWindow: {},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});
			runtime.setLogNextSuccessfulPredict(true);
			const payload = runtime.buildRequestPayload({
				room: {roomid: 'battle-gen9randombattle-armed', battle: {log: []}},
				request: {rqid: 18, side: {id: 'p2', pokemon: []}},
				requestSource: 'battle.request',
			});
			assert.equal(payload.browser_bridge_meta.log_next_successful_predict, true);
		});

		it('should clear a stale in-flight request before retrying the live turn', async () => {
			const roomId = 'battle-gen9randombattle-stale-inflight';
			const request = {
				rqid: 55,
				side: {
					id: 'p2',
					pokemon: [
						{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						{ident: 'p2: Eevee', condition: '100/100', active: false},
					],
				},
				active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
			};
			let requestCount = 0;
			const room = {roomid: roomId, battle: {request, log: []}};
			const location = {
				pathname: '',
				hash: `#${roomId}`,
				href: `https://play.pokemonshowdown.com/#${roomId}`,
			};
			const runtime = userscript.createBridgeRuntime({
				window: {location},
				document: {},
				pageWindow: {location, Rooms: {get: () => room}},
				GM_xmlhttpRequest(options) {
					requestCount++;
					options.onload({
						status: 200,
						responseText: JSON.stringify({choice: 'move 1'}),
					});
				},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});
			const staleBridgeRequestId = runtime.buildRequestPayload({
				room,
				request,
				requestSource: 'battle.request',
			}).browser_bridge_meta.bridge_request_id;
			runtime.state.inFlightRequestIdByRoom.set(roomId, staleBridgeRequestId);
			runtime.state.inFlightStartedAtByRoom.set(roomId, Date.now() - userscript.CONFIG.requestTimeoutMs - 2000);

			runtime.tick();
			assert.equal(runtime.state.inFlightRequestIdByRoom.has(roomId), false);
			assert.match(runtime.state.lastStatus, /stale in-flight request cleared/);

			runtime.tick();
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(requestCount, 1);
		});

		it('should mirror simulator team preview handling locally', () => {
			assert.equal(
				userscript.deriveDirectChoiceFromRequest({rqid: 15, teamPreview: true, side: {id: 'p2'}}),
				'default'
			);
			assert.equal(
				userscript.deriveDirectChoiceFromRequest({rqid: 16, side: {id: 'p2'}}),
				null
			);
		});

		it('should wait for request acceptance before marking a request handled', async () => {
			const roomId = 'battle-gen9randombattle-acceptance';
			const request = {
				rqid: 40,
				side: {
					id: 'p2',
					pokemon: [
						{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
					],
				},
				active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
			};
			const sentCommands = [];
			const room = {
				roomid: roomId,
				battle: {request, log: []},
				send(command) {
					sentCommands.push(command);
				},
			};
			const location = {
				pathname: '',
				hash: `#${roomId}`,
				href: `https://play.pokemonshowdown.com/#${roomId}`,
			};
			const runtime = userscript.createBridgeRuntime({
				window: {location},
				document: {},
				pageWindow: {location, Rooms: {get: () => room}},
				GM_xmlhttpRequest(options) {
					options.onload({
						status: 200,
						responseText: JSON.stringify({choice: 'move 1'}),
					});
				},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});

			runtime.tick();
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(sentCommands.length, 1);
			assert.equal(runtime.state.lastHandledRequestIdByRoom.has(roomId), false);
			assert.equal(runtime.state.pendingSubmissionByRoom.has(roomId), true);

			room.battle.request = {wait: true};
			runtime.tick();
			assert.equal(runtime.state.lastHandledRequestIdByRoom.get(roomId), `0:${roomId}:${roomId}:rqid:40`);
			assert.equal(runtime.state.pendingSubmissionByRoom.has(roomId), false);
		});

		it('should clear in-flight and pending state when paused', () => {
			const runtime = userscript.createBridgeRuntime({
				window: {location: {pathname: '', hash: '', href: ''}},
				document: {},
				pageWindow: {},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});
			runtime.state.inFlightRequestIdByRoom.set('battle-1', 'battle-1:rqid:1');
			runtime.state.lastSeenRequestIdByRoom.set('battle-1', 'battle-1:rqid:1');
			runtime.state.lastHandledRequestIdByRoom.set('battle-1', '0:battle-1:battle-1:rqid:1');
			runtime.state.pendingSubmissionByRoom.set('battle-1', {
				bridgeRequestId: 'battle-1:rqid:1',
				choice: 'move 1',
				method: 'room.send',
				attempts: 1,
				submittedAt: Date.now(),
				nextRetryAt: Date.now() + 1000,
			});
			runtime.state.lastBattleLogLengthByRoom.set('battle-1', 12);
			runtime.state.lastRoomId = 'battle-1';
			runtime.state.lastRequestKey = 'battle-1:rqid:1';
			runtime.setEnabled(false);
			assert.equal(runtime.state.controlEpoch, 1);
			assert.equal(runtime.state.inFlightRequestIdByRoom.size, 0);
			assert.equal(runtime.state.lastSeenRequestIdByRoom.get('battle-1'), 'battle-1:rqid:1');
			assert.equal(runtime.state.lastHandledRequestIdByRoom.get('battle-1'), '0:battle-1:battle-1:rqid:1');
			assert.equal(runtime.state.pendingSubmissionByRoom.size, 0);
			assert.equal(runtime.state.lastBattleLogLengthByRoom.get('battle-1'), 12);
			assert.equal(runtime.state.lastRoomId, 'battle-1');
			assert.equal(runtime.state.lastRequestKey, 'battle-1:rqid:1');
		});

		it('should discard late model responses after pausing and resuming control', async () => {
			const roomId = 'battle-gen9randombattle-cancel';
			const request = {
				rqid: 42,
				side: {
					id: 'p2',
					pokemon: [
						{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
					],
				},
				active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
			};
			const sentCommands = [];
			let pendingOnload = null;
			const room = {
				roomid: roomId,
				battle: {request, log: []},
				send(command) {
					sentCommands.push(command);
				},
			};
			const location = {
				pathname: '',
				hash: `#${roomId}`,
				href: `https://play.pokemonshowdown.com/#${roomId}`,
			};
			const runtime = userscript.createBridgeRuntime({
				window: {location},
				document: {},
				pageWindow: {location, Rooms: {get: () => room}},
				GM_xmlhttpRequest(options) {
					pendingOnload = options.onload;
				},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});

			runtime.tick();
			assert.equal(typeof pendingOnload, 'function');
			runtime.setEnabled(false);
			runtime.setEnabled(true);
			pendingOnload({
				status: 200,
				responseText: JSON.stringify({choice: 'move 1'}),
			});
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(sentCommands, []);
			assert.equal(runtime.state.pendingSubmissionByRoom.size, 0);
			assert.equal(runtime.state.inFlightRequestIdByRoom.size, 0);
		});

		it('should discard a completed bridge response if the room has already advanced to a new request', async () => {
			const roomId = 'battle-gen9randombattle-stale-response';
			const request = {
				rqid: 50,
				side: {
					id: 'p2',
					pokemon: [
						{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
					],
				},
				active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
			};
			const sentCommands = [];
			let pendingOnload = null;
			const room = {
				roomid: roomId,
				battle: {request, log: []},
				send(command) {
					sentCommands.push(command);
				},
			};
			const location = {
				pathname: '',
				hash: `#${roomId}`,
				href: `https://play.pokemonshowdown.com/#${roomId}`,
			};
			const runtime = userscript.createBridgeRuntime({
				window: {location},
				document: {},
				pageWindow: {location, Rooms: {get: () => room}},
				GM_xmlhttpRequest(options) {
					pendingOnload = options.onload;
				},
				setInterval() {
					return 1;
				},
				clearInterval() {},
				setTimeout() {
					return 1;
				},
				clearTimeout() {},
				console: {
					groupCollapsed() {},
					log() {},
					groupEnd() {},
					warn() {},
					error() {},
					info() {},
				},
			});

			runtime.tick();
			assert.equal(typeof pendingOnload, 'function');
			room.battle.request = {
				rqid: 51,
				side: request.side,
				active: request.active,
			};
			pendingOnload({
				status: 200,
				responseText: JSON.stringify({
					bridge_request_id: `0:${roomId}:${roomId}:rqid:50`,
					bridge_status: 'completed',
					dedupe_source: 'fresh',
					choice: 'move 1',
				}),
			});
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(sentCommands, []);
			assert.equal(runtime.state.pendingSubmissionByRoom.size, 0);
		});
	});

	describe('server normalization and diagnostics', function () {
		this.timeout(60000);
		it('should normalize a browser request into the simulator payload shape', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-1',
				perspectivePlayer: 'p2',
				requestData: {
					rqid: 7,
					side: {
						id: 'p2',
						name: 'Model Bot',
						pokemon: [
							{
								ident: 'p2: Pikachu',
								details: 'Pikachu, L100',
								condition: '100/100',
								active: true,
								moves: ['thunderbolt', 'quickattack'],
							},
							{
								ident: 'p2: Eevee',
								details: 'Eevee, L100',
								condition: '100/100',
								active: false,
							},
						],
					},
					active: [
						{
							moves: [
								{move: 'Thunderbolt', id: 'thunderbolt', disabled: false},
								{move: 'Quick Attack', id: 'quickattack', disabled: true},
							],
						},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.model_id, 'model-test');
			assert.equal(normalized.perspective_player, 'p2');
			assert.equal(normalized.roomid, undefined);
			assert.equal(normalized.request, undefined);
			assert.equal(normalized.legal_moves.length, 1);
			assert.equal(normalized.legal_moves[0].id, 'thunderbolt');
			assert.equal(normalized.legal_switches.length, 1);
			assert.equal(normalized.legal_switches[0].request_slot, 2);
			assert(normalized.state_vector.length > 0);
			assert(normalized.battle_state.p2.active_uid);
			assert.equal(normalized.battle_state.p1.active_uid, undefined);
			assert.equal(normalized.side.id, 'p2');
			assert.equal(normalized.active[0].moves[0].id, 'thunderbolt');
		});

		it('should apply battle updates before normalizing the request', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-2',
				updates: [
					'|switch|p1a: Pikachu|Pikachu, L100|100/100',
					'|switch|p2a: Eevee|Eevee, L100|100/100',
				],
				requestData: {
					rqid: 8,
					side: {
						id: 'p2',
						name: 'Model Bot',
						pokemon: [
							{
								ident: 'p2: Eevee',
								details: 'Eevee, L100',
								condition: '100/100',
								active: true,
								moves: ['tackle'],
							},
							{
								ident: 'p2: Jolteon',
								details: 'Jolteon, L100',
								condition: '100/100',
								active: false,
							},
						],
					},
					active: [
						{
							moves: [
								{move: 'Tackle', id: 'tackle', disabled: false},
							],
						},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.perspective_player, 'p2');
			assert(normalized.battle_state.p1.active_uid);
			assert(normalized.battle_state.p2.active_uid);
			assert.equal(normalized.legal_moves.length, 1);
			assert.equal(normalized.legal_moves[0].id, 'tackle');
			assert.equal(normalized.legal_switches.length, 1);
			assert.equal(normalized.legal_switches[0].request_slot, 2);
			assert(normalized.state_vector.length > 0);
		});

		it('should normalize provided legal_switches onto request slots and drop active entries', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-provided-switches',
				requestData: {
					rqid: 12,
					forceSwitch: [true],
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Hawlucha', details: 'Hawlucha, L80', condition: '0 fnt', active: true},
							{ident: 'p2: Iron Thorns', details: 'Iron Thorns, L83', condition: '302/302', active: false},
							{ident: 'p2: Veluza', details: 'Veluza, L85', condition: '292/292', active: false},
						],
					},
					legal_switches: [
						{slot: 1, request_slot: 1, ident: 'p2: Hawlucha', active: true},
						{slot: 2, ident: 'p2: Iron Thorns'},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.legal_switches.length, 1);
			assert.equal(normalized.legal_switches[0].request_slot, 2);
			assert.equal(normalized.legal_switches[0].ident, 'p2: Iron Thorns');
		});

		it('should preserve provided legality flags on normalized legal_switches', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-switch-flags',
				requestData: {
					rqid: 12,
					forceSwitch: [true],
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Hawlucha', details: 'Hawlucha, L80', condition: '0 fnt', active: true},
							{ident: 'p2: Iron Thorns', details: 'Iron Thorns, L83', condition: '302/302', active: false},
						],
					},
					legal_switches: [
						{slot: 2, ident: 'p2: Iron Thorns', canSwitch: false, trapped: true, disabled: true},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.legal_switches.length, 1);
			assert.equal(normalized.legal_switches[0].request_slot, 2);
			assert.equal(normalized.legal_switches[0].canSwitch, false);
			assert.equal(normalized.legal_switches[0].trapped, true);
			assert.equal(normalized.legal_switches[0].disabled, true);
		});

		it('should normalize provided legal_revives onto request slots and drop non-fainted entries', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-provided-revives',
				requestData: {
					rqid: 13,
					forceSwitch: [true],
					reviving: true,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Hawlucha', details: 'Hawlucha, L80', condition: '120/256', active: true, reviving: true},
							{ident: 'p2: Iron Thorns', details: 'Iron Thorns, L83', condition: '0 fnt', active: false},
							{ident: 'p2: Veluza', details: 'Veluza, L85', condition: '292/292', active: false},
						],
					},
					legal_revives: [
						{slot: 3, ident: 'p2: Veluza'},
						{slot: 2, ident: 'p2: Iron Thorns'},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.legal_revives.length, 1);
			assert.equal(normalized.legal_revives[0].request_slot, 2);
			assert.equal(normalized.legal_revives[0].ident, 'p2: Iron Thorns');
		});

		it('should fall back to request legal_switches for revive-target selection', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-revive-switch-fallback',
				requestData: {
					rqid: 13,
					forceSwitch: [true],
					reviving: true,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Hawlucha', details: 'Hawlucha, L80', condition: '120/256', active: true, reviving: true},
							{ident: 'p2: Iron Thorns', details: 'Iron Thorns, L83', condition: '0 fnt', active: false},
						],
					},
					legal_switches: [
						{slot: 2, ident: 'p2: Iron Thorns', canRevive: true, fainted: true},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.legal_switches.length, 0);
			assert.equal(normalized.legal_revives.length, 1);
			assert.equal(normalized.legal_revives[0].request_slot, 2);
			assert.equal(normalized.legal_revives[0].canRevive, true);
		});

		it('should hydrate own-side observables from request data into battle_state', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-own-observables',
				requestData: {
					rqid: 19,
					side: {
						id: 'p2',
						name: 'Model Bot',
						pokemon: [
							{
								ident: 'p2: Pikachu',
								details: 'Pikachu, L100',
								condition: '50/100 par',
								active: true,
								moves: ['thunderbolt', 'volttackle'],
								baseAbility: 'static',
								ability: 'lightningrod',
								item: 'leftovers',
								pokeball: 'pokeball',
								teraType: 'Electric',
							},
							{
								ident: 'p2: Eevee',
								details: 'Eevee, L100',
								condition: '75/100 brn',
								active: false,
								moves: ['tackle'],
								baseAbility: 'runaway',
								ability: 'adaptability',
								item: 'eviolite',
								pokeball: 'pokeball',
								teraType: 'Normal',
							},
						],
					},
					active: [
						{
							moves: [
								{move: 'Thunderbolt', id: 'thunderbolt', disabled: false},
								{move: 'Volt Tackle', id: 'volttackle', disabled: false},
							],
							canTerastallize: 'Electric',
						},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});
			const activeUid = normalized.battle_state.p2.active_uid;
			const benchUid = normalized.battle_state.p2.slots[1];
			const activeMon = normalized.battle_state.mons[activeUid];
			const benchMon = normalized.battle_state.mons[benchUid];

			assert.equal(activeMon.hp, 50);
			assert.equal(activeMon.max_hp, 100);
			assert.equal(activeMon.status, 'par');
			assert.equal(activeMon.item, 'Leftovers');
			assert.equal(activeMon.ability, 'Lightning Rod');
			assert.equal(activeMon.tera_type, 'Electric');
			assert.deepEqual(activeMon.observed_moves.sort(), ['thunderbolt', 'volttackle']);
			assert.equal(benchMon.hp, 75);
			assert.equal(benchMon.max_hp, 100);
			assert.equal(benchMon.status, 'brn');
			assert.equal(benchMon.item, 'Eviolite');
			assert.equal(benchMon.ability, 'Adaptability');
			assert.equal(benchMon.tera_type, 'Normal');
			assert.deepEqual(benchMon.observed_moves, ['tackle']);
		});

		it('should cover move, force-switch, team-preview, and revive fixtures', () => {
			const fixtures = [
				{
					name: 'move',
					payload: {
						roomId: 'battle-gen9randombattle-fixture-move',
						requestData: {
							rqid: 20,
							side: {
								id: 'p2',
								pokemon: [
									{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
									{ident: 'p2: Eevee', condition: '100/100', active: false},
								],
							},
							active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
						},
					},
					check(normalized) {
						assert.equal(normalized.legal_moves.length, 1);
						assert.equal(normalized.legal_switches.length, 1);
					},
				},
				{
					name: 'force-switch',
					payload: {
						roomId: 'battle-gen9randombattle-fixture-switch',
						requestData: {
							rqid: 21,
							forceSwitch: [true],
							side: {
								id: 'p2',
								pokemon: [
									{ident: 'p2: Pikachu', condition: '0 fnt', active: true},
									{ident: 'p2: Eevee', condition: '100/100', active: false},
								],
							},
						},
					},
					check(normalized) {
						assert.deepEqual(normalized.forceSwitch, [true]);
						assert.equal(normalized.legal_switches.length, 1);
						assert.equal(normalized.legal_switches[0].request_slot, 2);
					},
				},
				{
					name: 'team-preview',
					payload: {
						roomId: 'battle-gen9randombattle-fixture-team',
						requestData: {
							rqid: 22,
							teamPreview: true,
							side: {
								id: 'p2',
								pokemon: [
									{ident: 'p2: Pikachu', condition: '100/100', active: false},
									{ident: 'p2: Eevee', condition: '100/100', active: false},
									{ident: 'p2: Jolteon', condition: '100/100', active: false},
								],
							},
						},
					},
					check(normalized) {
						assert.equal(normalized.perspective_player, 'p2');
						assert(normalized.state_vector.length > 0);
						assert.equal(normalized.side.pokemon.length, 3);
					},
				},
				{
					name: 'revive-selection',
					payload: {
						roomId: 'battle-gen9randombattle-fixture-revive',
						requestData: {
							rqid: 23,
							forceSwitch: [true],
							reviving: true,
							side: {
								id: 'p2',
								pokemon: [
									{ident: 'p2: Pikachu', condition: '100/100', active: true, reviving: true},
									{ident: 'p2: Eevee', condition: '0 fnt', active: false},
									{ident: 'p2: Jolteon', condition: '100/100', active: false},
								],
							},
						},
					},
					check(normalized) {
						assert.equal(normalized.reviving, true);
						assert.equal(normalized.legal_revives.length, 1);
						assert.equal(normalized.legal_revives[0].request_slot, 2);
					},
				},
			];

			for (const fixture of fixtures) {
				const normalized = normalizeBrowserModelRequest(fixture.payload, {
					defaultPerspectivePlayer: 'p2',
					modelID: 'model-test',
				});
				fixture.check(normalized);
			}
		});

		it('should match simulator voluntary-switch suppression when disabled', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-fixture-noswitch',
				requestData: {
					rqid: 24,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
							{ident: 'p2: Eevee', condition: '100/100', active: false},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
				allowVoluntarySwitches: false,
			});

			assert.equal(normalized.legal_moves.length, 1);
			assert.equal(normalized.legal_switches.length, 0);
		});

		it('should pass through request legality flags used by the model server', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-fixture-legality',
				requestData: {
					rqid: 25,
					canSwitch: false,
					trapped: true,
					maybeTrapped: false,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
							{ident: 'p2: Eevee', condition: '100/100', active: false},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
				allowVoluntarySwitches: true,
			});

			assert.equal(normalized.canSwitch, false);
			assert.equal(normalized.trapped, true);
			assert.equal(normalized.maybeTrapped, false);
			assert.equal(normalized.legal_switches.length, 1);
		});

		it('should suppress legal switches for revive-selection requests and preserve forceSwitch shape', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-fixture-revive-shape',
				requestData: {
					rqid: 26,
					forceSwitch: [true],
					reviving: true,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, reviving: true},
							{ident: 'p2: Eevee', condition: '0 fnt', active: false},
							{ident: 'p2: Jolteon', condition: '100/100', active: false},
						],
					},
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
				allowVoluntarySwitches: true,
			});

			assert.deepEqual(normalized.forceSwitch, [true]);
			assert.equal(normalized.legal_switches.length, 0);
			assert.equal(normalized.legal_revives.length, 1);
			assert.equal(normalized.legal_revives[0].request_slot, 2);
		});

		it('should merge browser observations into the normalized battle_state', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-browser-observations',
				requestData: {
					rqid: 28,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
				browser_observations: {
					turn_index: 7,
					field: {
						weather: 'sunnyday',
						global_conditions: ['trickroom'],
					},
					p1: {
						active_uid: 'p1:slot1',
						slots: ['p1:slot1', null, null, null, null, null],
						side_conditions: {spikes: 1},
					},
					mons: {
						'p1:slot1': {
							uid: 'p1:slot1',
							player: 'p1',
							species: 'Pikachu',
							hp: 240,
							max_hp: 240,
							public_revealed: true,
							fainted: false,
							observed_moves: ['thunderbolt'],
						},
					},
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.equal(normalized.battle_state.turn_index, 7);
			assert.equal(normalized.battle_state.field.weather, 'sunnyday');
			assert.deepEqual(normalized.battle_state.field.global_conditions, ['trickroom']);
			assert.equal(normalized.battle_state.p1.active_uid, 'p1:slot1');
			assert.equal(normalized.battle_state.p1.slots[0], 'p1:slot1');
			assert.equal(normalized.battle_state.p1.side_conditions.spikes, 1);
			assert.equal(normalized.battle_state.mons['p1:slot1'].species, 'Pikachu');
			assert.deepEqual(normalized.battle_state.mons['p1:slot1'].observed_moves, ['thunderbolt']);
		});

		it('should prefer the browser-observed turn index over a tracker that ran ahead', () => {
			const tracker = new ProtocolStateTracker();
			tracker.applyChunk('|turn|12\n');
			const payload = {
				roomId: 'battle-gen9randombattle-turn-override',
				requestData: {
					rqid: 30,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
				browser_observations: {
					turn_index: 11,
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			}, tracker);

			assert.equal(normalized.battle_state.turn_index, 11);
		});

		it('should canonicalize browser-observed move names before encoding the entity state', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-move-normalization',
				requestData: {
					rqid: 31,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
				browser_observations: {
					mons: {
						'p1:slot1': {
							uid: 'p1:slot1',
							player: 'p1',
							species: 'Pikachu',
							observed_moves: ['Earth Power', 'U-turn'],
						},
					},
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});

			assert.deepEqual(normalized.battle_state.mons['p1:slot1'].observed_moves, ['earthpower', 'u-turn']);
		});

		it('should prefer browser-visible mon fields over stale tracker values', () => {
			const tracker = new ProtocolStateTracker();
			tracker.applyRequest({
				side: {
					id: 'p2',
					pokemon: [
						{
							ident: 'p2: Pikachu',
							details: 'Pikachu, L83, M',
							condition: '200/240',
							item: 'choicescarf',
							baseAbility: 'steadfast',
							ability: 'steadfast',
							teraType: 'Fighting',
							active: true,
						},
					],
				},
				active: [{moves: [{move: 'Sacred Sword', id: 'sacredsword', disabled: false}], canTerastallize: 'Psychic'}],
			});
			const trackerSnapshot = tracker.getSnapshot();
			const trackedUid = trackerSnapshot.p2.active_uid;
			assert.ok(trackedUid);

			const payload = {
				roomId: 'battle-gen9randombattle-browser-observations-override',
				requestData: {
					rqid: 29,
					side: {
						id: 'p2',
						pokemon: [
							{
							ident: 'p2: Pikachu',
							details: 'Pikachu, L83, M',
								condition: '200/240',
								item: 'choicescarf',
								ability: 'steadfast',
								teraType: 'Fighting',
								active: true,
							},
						],
					},
					active: [{moves: [{move: 'Sacred Sword', id: 'sacredsword', disabled: false}], canTerastallize: 'Psychic'}],
				},
				browser_observations: {
					mons: {
						[trackedUid]: {
							uid: trackedUid,
							player: 'p2',
							species: 'Pikachu',
							ability: 'Sharpness',
							item: 'Life Orb',
							tera_type: 'Psychic',
							hp: 200,
							max_hp: 240,
							public_revealed: true,
							fainted: false,
						},
					},
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			}, tracker);

			assert.equal(normalized.battle_state.mons[trackedUid].species, 'Pikachu');
			assert.equal(normalized.battle_state.mons[trackedUid].ability, 'Sharpness');
			assert.equal(normalized.battle_state.mons[trackedUid].item, 'Life Orb');
			assert.equal(normalized.battle_state.mons[trackedUid].tera_type, 'Psychic');
		});

		it('should ignore caller-supplied battle_state and state_vector when rebuilding model state', () => {
			const payload = {
				roomId: 'battle-gen9randombattle-fixture-derived-state',
				state_vector: [999, 1000],
				battle_state: {
					p1: {active_uid: 'bad'},
					p2: {active_uid: 'worse'},
				},
				requestData: {
					rqid: 27,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
			};

			const normalized = normalizeBrowserModelRequest(payload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
				allowVoluntarySwitches: false,
			});

			assert.notDeepEqual(normalized.state_vector, [999, 1000]);
			assert.notEqual(normalized.battle_state.p1.active_uid, 'bad');
			assert.notEqual(normalized.battle_state.p2.active_uid, 'worse');
			assert(normalized.state_vector.length > 0);
		});

		it('should validate missing battle_state and perspective_player', () => {
			assert.deepEqual(
				validateNormalizedPredictRequest({}, {rqid: 1, side: {id: 'p2'}}),
				[
					'Missing normalized battle_state with p1 and p2 data.',
					'Missing normalized perspective_player.',
				]
			);
		});

		it('should reject predict requests that still lack required metadata after normalization', async () => {
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: 'http://127.0.0.1:9/predict',
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath: '',
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});

			try {
				const result = await postJson(serverUrl(bridgeServer, '/predict'), {
					roomId: 'battle-gen9randombattle-invalid',
				});
				assert.equal(result.status, 400);
				const body = JSON.parse(result.body);
				assert.equal(body.bridge_status, 'validation_error');
				assert.equal(body.dedupe_source, 'fresh');
				assert.equal(body.error, 'Browser bridge request validation failed.');
				assert(body.details.includes('Missing request.rqid.'));
				assert(body.details.includes('Missing request.side.id.'));
			} finally {
				await stopServer(bridgeServer);
			}
		});

		it('should proxy fixture payloads through /predict and preserve the local model contract', async () => {
			const receivedPayloads = [];
			const modelServer = await startServer((request, response) => {
				if (request.method === 'GET' && request.url === '/health') {
					response.statusCode = 200;
					response.setHeader('Content-Type', 'application/json; charset=utf-8');
					response.end(JSON.stringify({
						status: 'ok',
						default_model_id: 'model1',
						default_entity_model_id: 'entity_action_bc_v1_20260327_run2',
						runtime_health: {
							entity_action_bc_v1_20260327_run2: {
								kind: 'entity',
								model_id: 'entity_action_bc_v1_20260327_run2',
								alive: true,
							},
						},
					}));
					return;
				}
				let body = '';
				request.setEncoding('utf8');
				request.on('data', chunk => {
					body += chunk;
				});
				request.on('end', () => {
					receivedPayloads.push(JSON.parse(body));
					response.statusCode = 200;
					response.setHeader('Content-Type', 'application/json; charset=utf-8');
					response.end(JSON.stringify({choice: 'move 1'}));
				});
			});
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: serverUrl(modelServer, '/predict'),
				modelID: 'entity_action_bc_v1_20260327_run2',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath: '',
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});
			const fixtures = [
				{
					roomId: 'battle-gen9randombattle-proxy-1',
					logLength: 2,
					updates: [
						'|switch|p1a: Pikachu|Pikachu, L100|100/100',
						'|switch|p2a: Eevee|Eevee, L100|100/100',
					],
					request: {
						rqid: 30,
						side: {
							id: 'p2',
							pokemon: [
								{ident: 'p2: Eevee', condition: '100/100', active: true, moves: ['tackle']},
								{ident: 'p2: Jolteon', condition: '100/100', active: false},
							],
						},
						active: [{moves: [{move: 'Tackle', id: 'tackle', disabled: false}]}],
					},
					browser_bridge_meta: {
						script_version: '0.2.0',
						script_build: '2026-04-02',
						request_source: 'battle.request',
					},
				},
				{
					roomId: 'battle-gen9randombattle-proxy-2',
					request: {
						rqid: 31,
						forceSwitch: [true],
						side: {
							id: 'p2',
							pokemon: [
								{ident: 'p2: Pikachu', condition: '0 fnt', active: true},
								{ident: 'p2: Eevee', condition: '100/100', active: false},
							],
						},
					},
					browser_bridge_meta: {
						script_version: '0.2.0',
						script_build: '2026-04-02',
						request_source: 'room.request',
					},
				},
			];

			try {
				for (const fixture of fixtures) {
					const result = await postJson(serverUrl(bridgeServer, '/predict'), fixture);
					assert.equal(result.status, 200);
					const body = JSON.parse(result.body);
					assert.equal(body.bridge_status, 'completed');
					assert.equal(body.dedupe_source, 'fresh');
					assert.equal(body.choice, 'move 1');
				}

				assert.equal(receivedPayloads.length, fixtures.length);
				assert.equal(receivedPayloads[0].model_id, 'entity_action_bc_v1_20260327_run2');
				assert.equal(receivedPayloads[0].perspective_player, 'p2');
				assert.equal(receivedPayloads[0].state_vector, undefined);
				assert(receivedPayloads[0].battle_state.p1);
				assert(receivedPayloads[0].battle_state.p2);
				assert.equal(receivedPayloads[0].legal_moves[0].id, 'tackle');
				assert.deepEqual(receivedPayloads[1].forceSwitch, [true]);
				assert.equal(receivedPayloads[1].legal_switches[0].request_slot, 2);
			} finally {
				await stopServer(bridgeServer);
				await stopServer(modelServer);
			}
		});

		it('should treat a changed browser log source as a fresh transcript stream', async () => {
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: 'http://127.0.0.1:9/predict',
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath: '',
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});
			const baseRequest = {
				rqid: 40,
				side: {
					id: 'p2',
					pokemon: [
						{ident: 'p2: Eevee', condition: '100/100', active: true, moves: ['tackle']},
					],
				},
				active: [{moves: [{move: 'Tackle', id: 'tackle', disabled: false}]}],
			};

			try {
				const first = await postJson(serverUrl(bridgeServer, '/normalize'), {
					roomId: 'battle-gen9randombattle-log-source-reset',
					log_source: 'battle.log',
					logLength: 2,
					updates: ['|player|p1|Alice', '|player|p2|Bob'],
					request: baseRequest,
				});
				assert.equal(first.status, 200);
				const firstBody = JSON.parse(first.body);
				assert.equal(firstBody.battle_state.p1.active_uid, undefined);

				const second = await postJson(serverUrl(bridgeServer, '/normalize'), {
					roomId: 'battle-gen9randombattle-log-source-reset',
					log_source: 'room.log',
					logLength: 2,
					updates: [
						'|switch|p1a: Pikachu|Pikachu, L100|100/100',
						'|switch|p2a: Eevee|Eevee, L100|100/100',
					],
					request: baseRequest,
				});
				assert.equal(second.status, 200);
				const secondBody = JSON.parse(second.body);
				assert(secondBody.battle_state.p1.active_uid);
				assert.equal(secondBody.battle_state.p1.slots[0], secondBody.battle_state.p1.active_uid);
			} finally {
				await stopServer(bridgeServer);
			}
		});

		it('should return pending for duplicate browser requests while one upstream inference is running', async () => {
			let upstreamCalls = 0;
			let notifyStarted;
			const upstreamStarted = new Promise(resolve => {
				notifyStarted = resolve;
			});
			let releaseResponse;
			const responseReleased = new Promise(resolve => {
				releaseResponse = resolve;
			});
			const modelServer = await startServer((request, response) => {
				let body = '';
				request.setEncoding('utf8');
				request.on('data', chunk => {
					body += chunk;
				});
				request.on('end', async () => {
					upstreamCalls++;
					notifyStarted();
					await responseReleased;
					response.statusCode = 200;
					response.setHeader('Content-Type', 'application/json; charset=utf-8');
					response.end(JSON.stringify({choice: 'move 1'}));
				});
			});
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: serverUrl(modelServer, '/predict'),
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath: '',
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});
			const payload = {
				roomId: 'battle-gen9randombattle-dedupe-pending',
				request: {
					rqid: 61,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
				browser_bridge_meta: {
					bridge_request_id: '0:battle-gen9randombattle-dedupe-pending:battle-gen9randombattle-dedupe-pending:rqid:61',
					request_identity: 'battle-gen9randombattle-dedupe-pending:rqid:61',
					control_epoch: 0,
				},
			};

			try {
				const firstResponsePromise = postJson(serverUrl(bridgeServer, '/predict'), payload);
				await upstreamStarted;
				const secondResponse = await postJson(serverUrl(bridgeServer, '/predict'), payload);
				assert.equal(secondResponse.status, 202);
				assert.deepEqual(JSON.parse(secondResponse.body), {
					bridge_request_id: payload.browser_bridge_meta.bridge_request_id,
					bridge_status: 'pending',
					dedupe_source: 'shared_pending',
				});
				releaseResponse();
				const firstResponse = await firstResponsePromise;
				assert.equal(firstResponse.status, 200);
				assert.equal(JSON.parse(firstResponse.body).bridge_status, 'completed');
				assert.equal(upstreamCalls, 1);
			} finally {
				await stopServer(bridgeServer);
				await stopServer(modelServer);
			}
		});

		it('should return cached completion for duplicate browser requests after the first one finishes', async () => {
			let upstreamCalls = 0;
			const modelServer = await startServer((request, response) => {
				request.resume();
				request.on('end', () => {
					upstreamCalls++;
					response.statusCode = 200;
					response.setHeader('Content-Type', 'application/json; charset=utf-8');
					response.end(JSON.stringify({choice: 'move 1'}));
				});
			});
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: serverUrl(modelServer, '/predict'),
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath: '',
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});
			const payload = {
				roomId: 'battle-gen9randombattle-dedupe-complete',
				request: {
					rqid: 62,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
				browser_bridge_meta: {
					bridge_request_id: '0:battle-gen9randombattle-dedupe-complete:battle-gen9randombattle-dedupe-complete:rqid:62',
					request_identity: 'battle-gen9randombattle-dedupe-complete:rqid:62',
					control_epoch: 0,
				},
			};

			try {
				const first = await postJson(serverUrl(bridgeServer, '/predict'), payload);
				const second = await postJson(serverUrl(bridgeServer, '/predict'), payload);
				assert.equal(first.status, 200);
				assert.equal(second.status, 200);
				assert.equal(JSON.parse(first.body).dedupe_source, 'fresh');
				assert.equal(JSON.parse(second.body).dedupe_source, 'cached');
				assert.equal(JSON.parse(second.body).bridge_status, 'completed');
				assert.equal(upstreamCalls, 1);
			} finally {
				await stopServer(bridgeServer);
				await stopServer(modelServer);
			}
		});

		it('should keep unknown-outcome requests from being re-dispatched upstream', async () => {
			let upstreamCalls = 0;
			const modelServer = await startServer((request, _response) => {
				request.resume();
				request.on('end', () => {
					upstreamCalls++;
					request.socket.destroy();
				});
			});
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: serverUrl(modelServer, '/predict'),
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 100,
				debugLogPath: '',
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});
			const payload = {
				roomId: 'battle-gen9randombattle-unknown',
				request: {
					rqid: 63,
					side: {
						id: 'p2',
						pokemon: [
							{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
						],
					},
					active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
				},
				browser_bridge_meta: {
					bridge_request_id: '0:battle-gen9randombattle-unknown:battle-gen9randombattle-unknown:rqid:63',
					request_identity: 'battle-gen9randombattle-unknown:rqid:63',
					control_epoch: 0,
				},
			};

			try {
				const first = await postJson(serverUrl(bridgeServer, '/predict'), payload);
				const second = await postJson(serverUrl(bridgeServer, '/predict'), payload);
				assert.equal(first.status, 409);
				assert.equal(second.status, 409);
				assert.equal(JSON.parse(first.body).bridge_status, 'unknown_outcome');
				assert.equal(JSON.parse(second.body).dedupe_source, 'cached');
				assert.equal(upstreamCalls, 1);
			} finally {
				await stopServer(bridgeServer);
				await stopServer(modelServer);
			}
		});

		it('should prune old terminal ledger entries while preserving active ones', () => {
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: 'http://127.0.0.1:9/predict',
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath: '',
			});
			const now = Date.now();
			bridge.requestLedger.set('pending-entry', {
				bridgeRequestId: 'pending-entry',
				roomid: 'battle-live',
				requestIdentity: 'battle-live:rqid:1',
				status: 'pending',
				createdAt: now,
				updatedAt: now,
				requestSummary: {},
				normalizedSummary: {},
			});
			for (let i = 0; i < 260; i++) {
				bridge.requestLedger.set(`old-${i}`, {
					bridgeRequestId: `old-${i}`,
					roomid: `battle-${i}`,
					requestIdentity: `battle-${i}:rqid:${i}`,
					status: 'completed',
					createdAt: now - 200_000,
					updatedAt: now - 200_000,
					requestSummary: {},
					normalizedSummary: {},
					responseStatusCode: 200,
					responseBody: {choice: 'move 1'},
				});
			}
			bridge.pruneRequestLedger(now);
			assert.equal(bridge.requestLedger.has('pending-entry'), true);
			assert.equal(bridge.requestLedger.size, 1);
		});

		it('should log a successful /predict payload when requested by the browser', async () => {
			const debugDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-browser-bridge-'));
			const debugLogPath = path.join(debugDir, 'success.log');
			const modelServer = await startServer((request, response) => {
				response.statusCode = 200;
				response.setHeader('Content-Type', 'application/json; charset=utf-8');
				response.end(JSON.stringify({choice: 'move 1'}));
			});
			const bridge = new BrowserModelBridgeServer({
				host: '127.0.0.1',
				port: 0,
				modelEndpoint: serverUrl(modelServer, '/predict'),
				modelID: 'model-test',
				defaultPerspectivePlayer: 'p2',
				requestTimeoutMs: 1000,
				debugLogPath,
			});
			const bridgeServer = await startServer((request, response) => {
				void bridge.handleHttpRequest(request, response);
			});

			try {
				const result = await postJson(serverUrl(bridgeServer, '/predict'), {
					roomId: 'battle-gen9randombattle-success-log',
					browser_bridge_meta: {
						log_next_successful_predict: true,
						script_version: '0.2.2',
					},
					request: {
						rqid: 41,
						side: {
							id: 'p2',
							pokemon: [
								{ident: 'p2: Pikachu', condition: '100/100', active: true, moves: ['thunderbolt']},
							],
						},
						active: [{moves: [{move: 'Thunderbolt', id: 'thunderbolt', disabled: false}]}],
					},
				});
				assert.equal(result.status, 200);
				assert.equal(JSON.parse(result.body).bridge_status, 'completed');
				const logText = await fs.readFile(debugLogPath, 'utf8');
				assert(logText.includes('route=/predict'));
				assert(logText.includes('"upstreamStatus": 200'));
				assert(logText.includes('"log_next_successful_predict": true'));
			} finally {
				await stopServer(bridgeServer);
				await stopServer(modelServer);
				await fs.rm(debugDir, {recursive: true, force: true});
			}
		});

		it('should format a debug snapshot for the log file with diagnostic metadata', () => {
			const rawPayload = {
				roomId: 'battle-gen9randombattle-3',
				updates: ['|move|p1a: Pikachu|Thunderbolt|p2a: Eevee'],
				browser_bridge_meta: {
					script_version: '0.2.0',
					script_build: '2026-04-02',
					request_source: 'battle.request',
				},
				requestData: {
					rqid: 4,
					side: {
						id: 'p2',
						name: 'Model Bot',
						pokemon: [
							{
								ident: 'p2: Pikachu',
								details: 'Pikachu, L100',
								condition: '100/100',
								active: true,
								moves: ['thunderbolt'],
							},
						],
					},
					active: [
						{
							moves: [
								{move: 'Thunderbolt', id: 'thunderbolt', disabled: false},
							],
						},
					],
				},
			};

			const normalized = normalizeBrowserModelRequest(rawPayload, {
				defaultPerspectivePlayer: 'p2',
				modelID: 'model-test',
			});
			const snapshot = formatBrowserBridgeDebugSnapshot(rawPayload, normalized, {
				roomid: 'battle-gen9randombattle-3',
				rqid: 4,
				route: '/debug',
				requestSummary: {
					request_source: 'battle.request',
					script_version: '0.2.0',
				},
				upstreamStatus: 400,
				upstreamBodySnippet: 'bad request',
			});

			assert(snapshot.includes('route=/debug'));
			assert(snapshot.includes('roomid=battle-gen9randombattle-3'));
			assert(snapshot.includes('rqid=4'));
			assert(snapshot.includes('metadata:'));
			assert(snapshot.includes('raw:'));
			assert(snapshot.includes('normalized:'));
			assert(snapshot.includes('"requestSummary"'));
			assert(snapshot.includes('"script_version": "0.2.0"'));
			assert(snapshot.includes('"upstreamStatus": 400'));
		});
	});
});
