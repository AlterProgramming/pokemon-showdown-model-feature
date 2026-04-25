// ==UserScript==
// @name         Pokemon Showdown browser-model-bridge
// @namespace    https://github.com/smogon/pokemon-showdown
// @version      0.3.1
// @description  Forward your active Pokemon Showdown battle request and battle-log deltas to a local bridge that normalizes them before replaying the chosen move in the official browser tab.
// @match        https://play.pokemonshowdown.com/*
// @match        https://pokemonshowdown.com/*
// @match        http://localhost:8000/*
// @match        http://127.0.0.1:8000/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function (root, factory) {
	'use strict';

	const api = factory();
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	if (typeof window !== 'undefined' && typeof document !== 'undefined') {
		api.bootBrowserModelBridge();
	}
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const BRIDGE_VERSION = '0.3.1';
	const SCRIPT_VERSION = BRIDGE_VERSION;
	const SCRIPT_BUILD = '2026-04-02';
	const RUNTIME_SENTINEL = '__psBrowserModelBridgeRuntime__';
	const SUBMISSION_RETRY_DELAY_MS = 2500;
	const IN_FLIGHT_WATCHDOG_GRACE_MS = 1000;
	const REQUEST_SOURCES = [
		'battle.request',
		'room.request',
		'room.curRequest',
		'room.requestData',
		'room.choice.request',
		'room.pendingRequest',
		'battle.curRequest',
		'battle.requestData',
		'battle.pendingRequest',
	];
	const REQUEST_SOURCE_PRIORITY = {
		'battle.request': 90,
		'room.request': 80,
		'battle.curRequest': 70,
		'room.curRequest': 60,
		'battle.requestData': 50,
		'room.requestData': 40,
		'battle.pendingRequest': 30,
		'room.pendingRequest': 20,
		'room.choice.request': 10,
	};
	const BATTLE_HISTORY_SOURCES = [
		'battle.log',
		'battle.stepQueue',
		'battle.activityQueue',
		'room.log',
		'room.logs',
	];
	const CONFIG = {
		endpoint: 'http://127.0.0.1:5051/predict',
		debugEndpoint: 'http://127.0.0.1:5051/debug',
		pollIntervalMs: 100,
		requestTimeoutMs: 15000,
		autoStart: true,
	};

	function clone(value) {
		if (value === undefined || value === null) return value;
		if (typeof structuredClone === 'function') {
			try {
				return structuredClone(value);
			} catch {}
		}
		return JSON.parse(JSON.stringify(value));
	}

	function isObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function toPositiveInteger(value) {
		if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
		if (typeof value === 'string' && value.trim()) {
			const numeric = Number(value);
			if (Number.isInteger(numeric) && numeric > 0) return numeric;
		}
		return null;
	}

	function valuesOf(collection) {
		if (!collection) return [];
		if (collection instanceof Map) return [...collection.values()];
		if (Array.isArray(collection)) return collection;
		if (typeof collection === 'object') return Object.values(collection);
		return [];
	}

	function toFiniteNumber(value) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim()) {
			const numeric = Number(value);
			if (Number.isFinite(numeric)) return numeric;
		}
		return null;
	}

	function looksLikeRoom(value) {
		return !!value && typeof value === 'object' && (
			typeof value.roomid === 'string' ||
			typeof value.id === 'string' ||
			!!value.battle
		);
	}

	function looksLikeBattleRequest(value) {
		if (!isObject(value)) return false;
		return (
			'rqid' in value ||
			'side' in value ||
			'active' in value ||
			'forceSwitch' in value ||
			'teamPreview' in value ||
			'wait' in value
		);
	}

	function getPageWindow(explicitPageWindow) {
		if (explicitPageWindow) return explicitPageWindow;
		if (typeof unsafeWindow !== 'undefined') return unsafeWindow;
		return typeof window !== 'undefined' ? window : undefined;
	}

	function getRoomIdFromLocation(locationLike) {
		const location = locationLike || (typeof window !== 'undefined' ? window.location : null);
		if (!location) return '';
		const pathname = String(location.pathname || '').replace(/^\/+/, '');
		if (pathname) return decodeURIComponent(pathname.split('?')[0].split('#')[0]);
		const hash = String(location.hash || '').replace(/^#/, '');
		if (hash) return decodeURIComponent(hash.split('?')[0].split('#')[0]);
		return '';
	}

	function extractRoomId(room, fallbackRoomId) {
		return String(room?.roomid || room?.id || room?.roomId || fallbackRoomId || '');
	}

	function getRoomsApi(pageWindow) {
		return pageWindow?.Rooms || pageWindow?.app?.rooms || pageWindow?.PSRooms || null;
	}

	function collectRoomCollections(roomsApi, pageWindow) {
		const collections = [
			{name: 'roomsApi.rooms', value: roomsApi?.rooms},
			{name: 'roomsApi.roomList', value: roomsApi?.roomList},
			{name: 'roomsApi.roomlist', value: roomsApi?.roomlist},
			{name: 'roomsApi._rooms', value: roomsApi?._rooms},
			{name: 'roomsApi._roomList', value: roomsApi?._roomList},
			{name: 'pageWindow.app.rooms', value: pageWindow?.app?.rooms},
			{name: 'pageWindow.app.roomList', value: pageWindow?.app?.roomList},
			{name: 'pageWindow.app.roomlist', value: pageWindow?.app?.roomlist},
			{name: 'pageWindow.app._rooms', value: pageWindow?.app?._rooms},
			{name: 'pageWindow.app._roomList', value: pageWindow?.app?._roomList},
			{name: 'pageWindow.Rooms.rooms', value: pageWindow?.Rooms?.rooms},
			{name: 'pageWindow.Rooms.roomList', value: pageWindow?.Rooms?.roomList},
			{name: 'pageWindow.PSRooms.rooms', value: pageWindow?.PSRooms?.rooms},
		];
		const seen = new Set();
		return collections.filter(entry => {
			if (!entry.value) return false;
			if (seen.has(entry.value)) return false;
			seen.add(entry.value);
			return true;
		});
	}

	function getRoomById(roomId, pageWindow) {
		if (!roomId) return {room: null, source: 'missing-roomid'};
		const roomsApi = getRoomsApi(pageWindow);
		if (!roomsApi) return {room: null, source: 'no-room-api'};

		if (typeof roomsApi.get === 'function') {
			try {
				const room = roomsApi.get(roomId);
				if (looksLikeRoom(room)) return {room, source: 'roomsApi.get'};
			} catch {}
		}

		for (const collection of collectRoomCollections(roomsApi, pageWindow)) {
			for (const room of valuesOf(collection.value)) {
				if (!looksLikeRoom(room)) continue;
				if (extractRoomId(room) === roomId) {
					return {room, source: collection.name};
				}
			}
		}

		return {room: null, source: `roomid-not-found:${roomId}`};
	}

	function collectCurrentRoomCandidates(pageWindow) {
		const roomsApi = getRoomsApi(pageWindow);
		return [
			{name: 'pageWindow.app.curRoom', value: pageWindow?.app?.curRoom},
			{name: 'pageWindow.app.currentRoom', value: pageWindow?.app?.currentRoom},
			{name: 'pageWindow.app.focusedRoom', value: pageWindow?.app?.focusedRoom},
			{name: 'pageWindow.app.room', value: pageWindow?.app?.room},
			{name: 'roomsApi.curRoom', value: roomsApi?.curRoom},
			{name: 'roomsApi.currentRoom', value: roomsApi?.currentRoom},
			{name: 'roomsApi.focusedRoom', value: roomsApi?.focusedRoom},
		].filter(entry => looksLikeRoom(entry.value));
	}

	function resolveBattleRoom(pageWindow, preferredRoomId, lastRoomId) {
		if (preferredRoomId) {
			const resolved = getRoomById(preferredRoomId, pageWindow);
			if (resolved.room?.battle) return resolved;
			return {room: null, source: resolved.source};
		}

		for (const roomId of [lastRoomId]) {
			if (!roomId) continue;
			const resolved = getRoomById(roomId, pageWindow);
			if (resolved.room?.battle) return resolved;
		}

		for (const candidate of collectCurrentRoomCandidates(pageWindow)) {
			if (candidate.value?.battle) return {room: candidate.value, source: candidate.name};
		}

		const battleRooms = [];
		for (const collection of collectRoomCollections(getRoomsApi(pageWindow), pageWindow)) {
			for (const room of valuesOf(collection.value)) {
				if (!looksLikeRoom(room) || !room.battle) continue;
				const roomId = extractRoomId(room);
				if (preferredRoomId && roomId === preferredRoomId) {
					return {room, source: collection.name};
				}
				if (lastRoomId && roomId === lastRoomId) {
					return {room, source: collection.name};
				}
				battleRooms.push({room, source: collection.name});
			}
		}

		if (battleRooms.length === 1) return battleRooms[0];
		if (battleRooms.length > 1) return {room: null, source: 'ambiguous-battle-room'};
		return {room: null, source: 'no-battle-room'};
	}

	function toComparableRqid(value) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim()) {
			const numeric = Number(value);
			if (Number.isFinite(numeric)) return numeric;
		}
		return null;
	}

	function compareRequestCandidates(a, b) {
		const aRqid = toComparableRqid(a?.value?.rqid);
		const bRqid = toComparableRqid(b?.value?.rqid);
		if (aRqid !== null || bRqid !== null) {
			if (aRqid === null) return 1;
			if (bRqid === null) return -1;
			if (aRqid !== bRqid) return bRqid - aRqid;
		}
		return (REQUEST_SOURCE_PRIORITY[b.source] || 0) - (REQUEST_SOURCE_PRIORITY[a.source] || 0);
	}

	function extractBattleRequest(room, options) {
		const roomId = options?.roomId || '';
		const lastSeenRequestIdByRoom = options?.lastSeenRequestIdByRoom;
		const lastSeenRequestId = roomId && lastSeenRequestIdByRoom ? lastSeenRequestIdByRoom.get(roomId) || '' : '';
		const lastSeenRqid = lastSeenRequestId.includes(':rqid:') ? toComparableRqid(lastSeenRequestId.split(':rqid:').pop()) : null;
		const candidates = REQUEST_SOURCES.map(source => {
			switch (source) {
			case 'battle.request':
				return {source, value: room?.battle?.request};
			case 'room.request':
				return {source, value: room?.request};
			case 'room.curRequest':
				return {source, value: room?.curRequest};
			case 'room.requestData':
				return {source, value: room?.requestData};
			case 'room.choice.request':
				return {source, value: room?.choice?.request};
			case 'room.pendingRequest':
				return {source, value: room?.pendingRequest};
			case 'battle.curRequest':
				return {source, value: room?.battle?.curRequest};
			case 'battle.requestData':
				return {source, value: room?.battle?.requestData};
			case 'battle.pendingRequest':
				return {source, value: room?.battle?.pendingRequest};
			default:
				return {source, value: null};
			}
		}).filter(candidate => looksLikeBattleRequest(candidate.value));
		const freshCandidates = candidates.filter(candidate => {
			const rqid = toComparableRqid(candidate.value?.rqid);
			if (lastSeenRqid === null || rqid === null) return true;
			return rqid >= lastSeenRqid;
		}).sort(compareRequestCandidates);
		const bestCandidate = freshCandidates[0] || candidates.sort(compareRequestCandidates)[0];
		if (bestCandidate) return {request: bestCandidate.value, source: bestCandidate.source};
		return {request: null, source: 'none'};
	}

	function looksLikeProtocolLogLine(line) {
		if (typeof line !== 'string') return false;
		const trimmed = line.trim();
		return trimmed.startsWith('|') || trimmed.startsWith('>');
	}

	function normalizeProtocolLogValue(value) {
		if (!value) return [];
		if (typeof value === 'string') {
			return value.split('\n').map(line => line.trimEnd()).filter(looksLikeProtocolLogLine);
		}
		if (Array.isArray(value)) {
			return value.flatMap(entry => normalizeProtocolLogValue(entry));
		}
		if (isObject(value)) {
			for (const key of ['lines', 'entries', 'log', 'queue']) {
				if (key in value) {
					const nested = normalizeProtocolLogValue(value[key]);
					if (nested.length) return nested;
				}
			}
		}
		return [];
	}

	function getBattleHistorySourceValue(room, source) {
		switch (source) {
		case 'battle.log':
			return room?.battle?.log;
		case 'battle.stepQueue':
			return room?.battle?.stepQueue;
		case 'battle.activityQueue':
			return room?.battle?.activityQueue;
		case 'room.log':
			return room?.log;
		case 'room.logs':
			return room?.logs;
		default:
			return null;
		}
	}

	function collectBattleHistory(room) {
		const candidates = BATTLE_HISTORY_SOURCES.map(source => {
			const lines = normalizeProtocolLogValue(getBattleHistorySourceValue(room, source));
			return {source, lines};
		}).filter(candidate => candidate.lines.length);
		if (!candidates.length) return {source: 'none', lines: []};
		candidates.sort((a, b) => {
			if (b.lines.length !== a.lines.length) return b.lines.length - a.lines.length;
			return BATTLE_HISTORY_SOURCES.indexOf(a.source) - BATTLE_HISTORY_SOURCES.indexOf(b.source);
		});
		return candidates[0];
	}

	function collectBattleUpdates(room, roomId, state) {
		const history = collectBattleHistory(room);
		if (!history.lines.length) return {updates: [], logLength: null, source: history.source};
		const previousSource = state?.lastBattleLogSourceByRoom?.get(roomId) || '';
		const previousLength = previousSource === history.source ? (state?.lastBattleLogLengthByRoom?.get(roomId) || 0) : 0;
		const startIndex = Math.min(previousLength, history.lines.length);
		return {
			updates: history.lines.slice(startIndex).filter(line => typeof line === 'string' && line.length > 0),
			logLength: history.lines.length,
			source: history.source,
		};
	}

	function requestKey(request) {
		const active = request?.active?.[0] || null;
		const moves = Array.isArray(active?.moves) ? active.moves.map(move => [
			move?.id || '',
			move?.move || '',
			!!move?.disabled,
		]) : [];
		const team = Array.isArray(request?.side?.pokemon) ? request.side.pokemon.map(pokemon => [
			pokemon?.ident || '',
			pokemon?.condition || '',
			!!pokemon?.active,
			!!pokemon?.reviving,
		]) : [];
		return JSON.stringify([
			request?.rqid ?? null,
			!!request?.wait,
			!!request?.forceSwitch,
			!!request?.teamPreview,
			request?.side?.id || '',
			moves,
			team,
		]);
	}

	function buildTrackedRequestKey(roomId, request) {
		return `${roomId}:${requestKey(request)}`;
	}

	function buildRequestIdentity(roomId, request) {
		if (request?.rqid !== undefined && request?.rqid !== null && request?.rqid !== '') {
			return `${roomId}:rqid:${request.rqid}`;
		}
		return buildTrackedRequestKey(roomId, request);
	}

	function buildBridgeRequestId(controlEpoch, roomId, requestOrRequestIdentity) {
		const requestIdentity = typeof requestOrRequestIdentity === 'string' ?
			requestOrRequestIdentity :
			buildRequestIdentity(roomId, requestOrRequestIdentity);
		return `${controlEpoch}:${roomId}:${requestIdentity}`;
	}

	function shouldHandleRequest(lastHandledRequestId, inFlightRequestIdOrRoomId, roomIdOrRequest, maybeRequest, currentRequestId) {
		if (arguments.length >= 4) {
			const inFlightRequestId = inFlightRequestIdOrRoomId;
			const roomId = roomIdOrRequest;
			const request = maybeRequest;
			const requestId = currentRequestId || buildRequestIdentity(roomId, request);
			if (requestId === lastHandledRequestId) {
				return {shouldHandle: false, requestId, reason: 'already-handled'};
			}
			if (requestId === inFlightRequestId) {
				return {shouldHandle: false, requestId, reason: 'in-flight'};
			}
			return {shouldHandle: true, requestId, reason: 'new-request'};
		}
		const lastRequestKey = lastHandledRequestId;
		const roomId = inFlightRequestIdOrRoomId;
		const request = roomIdOrRequest;
		const key = buildTrackedRequestKey(roomId, request);
		return {
			key,
			shouldHandle: key !== lastRequestKey,
		};
	}

	function buildBridgeRequestContext(controlEpoch, room, request, locationLike) {
		const roomId = extractRoomId(room, getRoomIdFromLocation(locationLike));
		const requestIdentity = buildRequestIdentity(roomId, request);
		return {
			roomId,
			requestIdentity,
			bridgeRequestId: buildBridgeRequestId(controlEpoch, roomId, requestIdentity),
			controlEpoch,
		};
	}

	function normalizeStatusToken(value) {
		const status = String(value || '').trim().toLowerCase();
		return status || undefined;
	}

	function normalizeBoostMap(boosts) {
		const normalized = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0};
		if (!isObject(boosts)) return normalized;
		for (const key of Object.keys(normalized)) {
			const numeric = toFiniteNumber(boosts[key]);
			if (numeric !== null) normalized[key] = numeric;
		}
		return normalized;
	}

	function normalizeObservedMoves(pokemon) {
		const moveTrack = Array.isArray(pokemon?.moveTrack) ? pokemon.moveTrack : [];
		const trackedMoves = moveTrack.map(entry => Array.isArray(entry) ? entry[0] : entry).filter(Boolean);
		const explicitMoves = Array.isArray(pokemon?.moves) ? pokemon.moves : [];
		return [...new Set([...trackedMoves, ...explicitMoves].map(move => String(move || '')).filter(Boolean))];
	}

	function normalizeSideConditions(side) {
		const source = side?.sideConditions || side?.sideconditions || {};
		if (!source) return {};
		if (Array.isArray(source)) {
			return Object.fromEntries(source.map(condition => [String(condition || ''), 1]).filter(([condition]) => condition));
		}
		if (!isObject(source)) return {};
		return Object.fromEntries(
			Object.entries(source)
				.map(([key, value]) => [String(key), toFiniteNumber(value)])
				.filter(([, value]) => value !== null)
		);
	}

	function normalizeBattlePokemonObservation(pokemon, player, slotIndex) {
		if (!pokemon || typeof pokemon !== 'object') return null;
		const uid = `${player}:slot${slotIndex}`;
		const maxHp = toFiniteNumber(pokemon.maxhp ?? pokemon.maxHP ?? pokemon.maxHealth);
		const hp = toFiniteNumber(pokemon.hp ?? pokemon.curhp ?? pokemon.currentHP);
		const species = String(pokemon.speciesForme || pokemon.species || pokemon.name || pokemon.ident || '').trim();
		const boosts = isObject(pokemon.boosts) ? normalizeBoostMap(pokemon.boosts) : undefined;
		return {
			uid,
			player,
			species: species || undefined,
			...(hp !== null ? {hp} : {}),
			...(maxHp !== null ? {max_hp: maxHp} : {}),
			...((hp !== null && maxHp && maxHp > 0) ? {hp_frac: Math.max(0, Math.min(1, hp / maxHp))} : {}),
			...(normalizeStatusToken(pokemon.status) ? {status: normalizeStatusToken(pokemon.status)} : {}),
			...(pokemon.ability || pokemon.baseAbility ? {ability: String(pokemon.ability || pokemon.baseAbility)} : {}),
			...(pokemon.item ? {item: String(pokemon.item)} : {}),
			...(pokemon.teraType ? {tera_type: String(pokemon.teraType)} : {}),
			terastallized: !!(pokemon.terastallized || pokemon.terastallizedType),
			public_revealed: !!species,
			fainted: !!pokemon.fainted || (hp !== null && hp <= 0),
			...(boosts ? {boosts} : {}),
			observed_moves: normalizeObservedMoves(pokemon),
		};
	}

	function normalizeBattleSideObservation(side, player) {
		const pokemon = Array.isArray(side?.pokemon) ? side.pokemon : [];
		const slots = new Array(6).fill(null);
		const mons = {};
		let activeUid = undefined;
		pokemon.slice(0, 6).forEach((entry, index) => {
			const normalized = normalizeBattlePokemonObservation(entry, player, index + 1);
			if (!normalized) return;
			if (normalized.public_revealed || normalized.hp !== undefined || normalized.fainted) {
				slots[index] = normalized.uid;
				mons[normalized.uid] = normalized;
			}
			if (entry?.active) activeUid = normalized.uid;
		});
		if (!activeUid && Array.isArray(side?.active)) {
			const activeIndex = pokemon.findIndex(entry => !!entry?.active);
			if (activeIndex >= 0) activeUid = `${player}:slot${activeIndex + 1}`;
		}
		return {
			active_uid: activeUid,
			slots,
			side_conditions: normalizeSideConditions(side),
			mons,
		};
	}

	function getBattleSideCandidates(battle) {
		const explicitSides = Array.isArray(battle?.sides) ? battle.sides : [];
		return [
			{name: 'battle.mySide', value: battle?.mySide},
			{name: 'battle.yourSide', value: battle?.yourSide},
			{name: 'battle.nearSide', value: battle?.nearSide},
			{name: 'battle.farSide', value: battle?.farSide},
			...explicitSides.map((side, index) => ({name: `battle.sides[${index}]`, value: side})),
		].filter(entry => entry.value && typeof entry.value === 'object');
	}

	function pickBattleSideById(candidates, sideId) {
		if (!sideId) return null;
		return candidates.find(candidate => String(candidate.value?.id || candidate.value?.sideid || '').toLowerCase() === String(sideId).toLowerCase()) || null;
	}

	function extractBattleObservations(room, request) {
		const battle = room?.battle;
		if (!battle || typeof battle !== 'object') return null;
		const requestSideId = String(request?.side?.id || '').toLowerCase();
		const otherSideId = requestSideId === 'p1' ? 'p2' : 'p1';
		const sideCandidates = getBattleSideCandidates(battle);
		let ownCandidate = pickBattleSideById(sideCandidates, requestSideId);
		let oppCandidate = pickBattleSideById(sideCandidates, otherSideId);
		if (!ownCandidate && battle.mySide) ownCandidate = {name: 'battle.mySide', value: battle.mySide};
		if (!oppCandidate && battle.yourSide) oppCandidate = {name: 'battle.yourSide', value: battle.yourSide};
		if (!ownCandidate && battle.nearSide) ownCandidate = {name: 'battle.nearSide', value: battle.nearSide};
		if (!oppCandidate && battle.farSide) oppCandidate = {name: 'battle.farSide', value: battle.farSide};
		const ownSide = normalizeBattleSideObservation(ownCandidate?.value, requestSideId === 'p1' ? 'p1' : 'p2');
		const oppSide = normalizeBattleSideObservation(oppCandidate?.value, otherSideId === 'p1' ? 'p1' : 'p2');
		const turnIndex = toPositiveInteger(battle.turn ?? battle.turnCount ?? battle.turncount) || 0;
		const weather = String(
			battle.weather || battle.weatherState?.id || battle.field?.weather || ''
		).trim();
		const globalConditions = [
			battle.pseudoWeather ? Object.keys(battle.pseudoWeather) : [],
			Array.isArray(battle.globalConditions) ? battle.globalConditions : [],
		].flat().map(condition => String(condition || '')).filter(Boolean);
		return {
			turn_index: turnIndex,
			field: {
				...(weather ? {weather} : {}),
				global_conditions: [...new Set(globalConditions)].sort(),
			},
			p1: requestSideId === 'p1' ? {
				active_uid: ownSide.active_uid,
				slots: ownSide.slots,
				side_conditions: ownSide.side_conditions,
			} : {
				active_uid: oppSide.active_uid,
				slots: oppSide.slots,
				side_conditions: oppSide.side_conditions,
			},
			p2: requestSideId === 'p2' ? {
				active_uid: ownSide.active_uid,
				slots: ownSide.slots,
				side_conditions: ownSide.side_conditions,
			} : {
				active_uid: oppSide.active_uid,
				slots: oppSide.slots,
				side_conditions: oppSide.side_conditions,
			},
			mons: {
				...((requestSideId === 'p1' ? ownSide.mons : oppSide.mons) || {}),
				...((requestSideId === 'p2' ? ownSide.mons : oppSide.mons) || {}),
			},
			source_summary: {
				own_side_source: ownCandidate?.name || 'none',
				opponent_side_source: oppCandidate?.name || 'none',
			},
		};
	}

	function buildRequestPayload(optionsOrRoom, requestInput, requestSourceInput) {
		const options = (
			isObject(optionsOrRoom) &&
			('room' in optionsOrRoom || 'roomLookupSource' in optionsOrRoom || 'requestSource' in optionsOrRoom ||
				'locationLike' in optionsOrRoom || 'pageWindow' in optionsOrRoom || 'state' in optionsOrRoom)
		) ? optionsOrRoom : {
			room: optionsOrRoom,
			request: requestInput,
			requestSource: requestSourceInput,
		};
		const {
			room,
			request,
			roomLookupSource,
			requestSource,
			state,
			pageWindow,
			locationLike,
		} = options;
		const bridgeContext = buildBridgeRequestContext(state?.controlEpoch || 0, room, request, locationLike);
		const roomId = bridgeContext.roomId;
		const historySnapshot = options.historySnapshot || collectBattleUpdates(room, roomId, state);
		const observations = extractBattleObservations(room, request);
		return {
			roomid: roomId,
			request: clone(request),
			updates: historySnapshot.updates,
			logLength: historySnapshot.logLength,
			...(historySnapshot.source && historySnapshot.source !== 'none' ? {log_source: historySnapshot.source} : {}),
			...(observations ? {browser_observations: observations} : {}),
			browser_bridge_meta: {
				script_name: 'browser-model-bridge',
				script_version: SCRIPT_VERSION,
				script_build: SCRIPT_BUILD,
				bridge_request_id: bridgeContext.bridgeRequestId,
				request_identity: bridgeContext.requestIdentity,
				control_epoch: bridgeContext.controlEpoch,
				log_next_successful_predict: !!state?.logNextSuccessfulPredict,
				page_url: pageWindow?.location?.href || '',
				room_lookup_source: roomLookupSource || 'unknown',
				request_source: requestSource || 'unknown',
				request_sources_checked: REQUEST_SOURCES,
				log_source: historySnapshot.source || 'none',
				history_sources_checked: BATTLE_HISTORY_SOURCES,
				request_summary: {
					rqid: request?.rqid ?? null,
					side_id: request?.side?.id ?? null,
					wait: !!request?.wait,
					forceSwitch: !!request?.forceSwitch,
					teamPreview: !!request?.teamPreview,
					reviving: !!request?.reviving,
					active_count: Array.isArray(request?.active) ? request.active.length : 0,
					pokemon_count: Array.isArray(request?.side?.pokemon) ? request.side.pokemon.length : 0,
				},
			},
		};
	}

	function responseToChoice(response) {
		if (!response || typeof response !== 'object') return null;
		if (typeof response.choice === 'string' && response.choice.trim()) {
			return response.choice.trim();
		}
		if (typeof response.action === 'string' && response.action.trim()) {
			return response.action.trim();
		}
		if (typeof response.result === 'string' && response.result.trim()) {
			return response.result.trim();
		}

		const type = String(response.type || response.decision || '').toLowerCase();
		const moveSlot = response?.best_move?.slot ?? response?.best_move?.request_slot ?? response?.slot;
		const switchSlot = response?.best_switch?.request_slot ?? response?.best_switch?.slot ??
			response?.best_revive?.request_slot ?? response?.best_revive?.slot ??
			response?.switch_slot ?? response?.revive_slot;

		if (type === 'move' && moveSlot) return `move ${moveSlot}`;
		if ((type === 'switch' || type === 'revive') && switchSlot) return `switch ${switchSlot}`;
		if (type === 'team' || type === 'teampreview') {
			if (typeof response.team === 'string' && response.team.trim()) return `team ${response.team.trim()}`;
		}
		if (type === 'pass') return 'pass';
		if (type === 'default') return 'default';

		if (moveSlot) return `move ${moveSlot}`;
		if (switchSlot) return `switch ${switchSlot}`;
		const actionTokenChoice = responseToActionTokenChoice(response);
		if (actionTokenChoice) return actionTokenChoice;
		return null;
	}

	function responseToActionTokenChoice(response) {
		if (typeof response?.action_token !== 'string' || !response.action_token.trim()) return null;
		const token = response.action_token.trim();
		const tokenMatch = /^(move|switch|revive|team|pass)\s*(?::|\s)\s*(.+)$/i.exec(token);
		if (tokenMatch) {
			const kind = tokenMatch[1].toLowerCase();
			const value = String(tokenMatch[2] || '').trim();
			if (kind === 'pass') return 'pass';
			if (value) return `${kind} ${value}`;
		}
		if (/^(pass)$/i.test(token)) return 'pass';
		return null;
	}

	function buildRequestTeamEntries(request) {
		if (!Array.isArray(request?.side?.pokemon)) return [];
		return request.side.pokemon.map((pokemon, index) => {
			const condition = String(pokemon?.condition || '');
			return {
				request_slot: index + 1,
				slot: index + 1,
				ident: String(pokemon?.ident || ''),
				details: String(pokemon?.details || ''),
				condition,
				active: !!pokemon?.active,
				fainted: condition.endsWith(' fnt'),
				reviving: !!pokemon?.reviving,
			};
		});
	}

	function normalizeChoiceTargetEntries(request, rawEntries, targetType) {
		const wantRevive = targetType === 'revive';
		const teamEntries = buildRequestTeamEntries(request);
		const requestSlotMap = new Map(teamEntries.map(entry => [entry.request_slot, entry]));
		const identMap = new Map(teamEntries.filter(entry => entry.ident).map(entry => [entry.ident, entry]));
		const detailsMap = new Map(teamEntries.filter(entry => entry.details).map(entry => [entry.details, entry]));
		const normalized = [];
		const seenRequestSlots = new Set();

		for (const rawEntry of Array.isArray(rawEntries) ? rawEntries : []) {
			if (!isObject(rawEntry)) continue;
			let match = null;
			const requestSlot = toPositiveInteger(rawEntry.request_slot ?? rawEntry.requestSlot);
			if (requestSlot) match = requestSlotMap.get(requestSlot) || null;
			if (!match && rawEntry.ident) match = identMap.get(String(rawEntry.ident)) || null;
			if (!match && rawEntry.details) match = detailsMap.get(String(rawEntry.details)) || null;

			const condition = String(rawEntry.condition || match?.condition || '');
			const merged = {
				request_slot: requestSlot ?? match?.request_slot ?? toPositiveInteger(rawEntry.slot),
				slot: toPositiveInteger(rawEntry.slot) ?? match?.slot ?? requestSlot ?? null,
				ident: String(rawEntry.ident || match?.ident || ''),
				details: String(rawEntry.details || match?.details || ''),
				condition,
				active: rawEntry.active !== undefined ? !!rawEntry.active : !!match?.active,
				fainted: rawEntry.fainted !== undefined ? !!rawEntry.fainted : condition.endsWith(' fnt') || !!match?.fainted,
				reviving: rawEntry.reviving !== undefined ? !!rawEntry.reviving : !!match?.reviving,
			};
			if (!toPositiveInteger(merged.request_slot) || !toPositiveInteger(merged.slot)) continue;
			if (wantRevive ? !merged.fainted : (merged.active || merged.fainted)) continue;
			if (seenRequestSlots.has(merged.request_slot)) continue;
			seenRequestSlots.add(merged.request_slot);
			normalized.push(merged);
		}

		if (normalized.length) return normalized;
		return teamEntries.filter(entry => wantRevive ? entry.fainted : (!entry.active && !entry.fainted));
	}

	function resolveSwitchRequestSlot(request, response, targetType) {
		const wantRevive = targetType === 'revive';
		const rawEntries = wantRevive ?
			(request?.legal_revives || request?.legalRevives) :
			(request?.legal_switches || request?.legalSwitches);
		const legalTargets = normalizeChoiceTargetEntries(request, rawEntries, wantRevive ? 'revive' : 'switch');
		if (!legalTargets.length) return null;
		const requestSlotMap = new Map(legalTargets.map(entry => [entry.request_slot, entry]));
		const slotMap = new Map(legalTargets.map(entry => [entry.slot, entry]));
		const identMap = new Map(legalTargets.filter(entry => entry.ident).map(entry => [entry.ident, entry]));
		const detailsMap = new Map(legalTargets.filter(entry => entry.details).map(entry => [entry.details, entry]));
		const payload = wantRevive ? (response?.best_revive || {}) : (response?.best_switch || {});
		const candidateRequestSlots = [
			toPositiveInteger(payload?.request_slot),
			toPositiveInteger(payload?.requestSlot),
			toPositiveInteger(response?.switch_request_slot),
			toPositiveInteger(response?.revive_request_slot),
		];
		for (const candidate of candidateRequestSlots) {
			if (candidate && requestSlotMap.has(candidate)) return candidate;
		}
		const candidateSlots = [
			toPositiveInteger(payload?.slot),
			toPositiveInteger(response?.switch_slot),
			toPositiveInteger(response?.revive_slot),
			((response?.type === 'switch' || response?.type === 'revive') ? toPositiveInteger(response?.slot) : null),
		];
		for (const candidate of candidateSlots) {
			if (candidate && slotMap.has(candidate)) return slotMap.get(candidate).request_slot;
		}
		if (payload?.ident && identMap.has(String(payload.ident))) return identMap.get(String(payload.ident)).request_slot;
		if (payload?.details && detailsMap.has(String(payload.details))) return detailsMap.get(String(payload.details)).request_slot;
		if (legalTargets.length === 1) return legalTargets[0].request_slot;
		return null;
	}

	function resolveMoveChoice(request, response) {
		const active = Array.isArray(request?.active) ? request.active[0] : null;
		const moves = Array.isArray(active?.moves) ? active.moves : [];
		const legalMoves = moves
			.map((move, index) => ({
				slot: index + 1,
				id: String(move?.id || ''),
				move: String(move?.move || ''),
				disabled: !!move?.disabled,
			}))
			.filter(move => !move.disabled);
		if (!legalMoves.length) return null;
		const directMoveSlot = toPositiveInteger(response?.best_move?.slot ?? response?.slot);
		if (directMoveSlot && legalMoves.some(move => move.slot === directMoveSlot)) return `move ${directMoveSlot}`;
		const moveId = String(response?.best_move?.id || '').toLowerCase();
		const moveName = String(response?.best_move?.move || '').toLowerCase();
		const matchedMove = legalMoves.find(move => move.id.toLowerCase() === moveId || move.move.toLowerCase() === moveName);
		if (matchedMove) return `move ${matchedMove.slot}`;
		return null;
	}

	function responseToChoiceForRequest(request, response) {
		if (!response || typeof response !== 'object') return null;
		const directChoice = responseToChoice(response);
		if (directChoice) {
			const moveMatch = /^move\s+(\d+)$/i.exec(directChoice);
			if (moveMatch) return resolveMoveChoice(request, {best_move: {slot: moveMatch[1]}});
			const switchMatch = /^switch\s+(\d+)$/i.exec(directChoice);
			if (switchMatch) {
				const switchSlot = resolveSwitchRequestSlot(request, {best_switch: {request_slot: switchMatch[1]}}, 'switch') ||
					resolveSwitchRequestSlot(request, {best_revive: {request_slot: switchMatch[1]}}, 'revive');
				return switchSlot ? `switch ${switchSlot}` : null;
			}
			return directChoice;
		}

		const type = String(response?.type || response?.decision || '').toLowerCase();
		if (type === 'move') return resolveMoveChoice(request, response);
		if (type === 'switch' || type === 'revive') {
			const switchSlot = resolveSwitchRequestSlot(request, response, type);
			return switchSlot ? `switch ${switchSlot}` : null;
		}

		const moveChoice = resolveMoveChoice(request, response);
		if (moveChoice) return moveChoice;
		const switchSlot = resolveSwitchRequestSlot(request, response, 'switch') ||
			resolveSwitchRequestSlot(request, response, 'revive');
		if (switchSlot) return `switch ${switchSlot}`;
		const actionTokenChoice = responseToActionTokenChoice(response);
		if (actionTokenChoice) return actionTokenChoice;
		return null;
	}

	function formatChooseCommand(choice, rqid) {
		return `/choose ${choice}${rqid !== null && rqid !== undefined ? `|${rqid}` : ''}`;
	}

	function deriveDirectChoiceFromRequest(request) {
		if (!looksLikeBattleRequest(request) || request.wait) return null;
		if (request.teamPreview) return 'default';
		return null;
	}

	function createDefaultEnv(customEnv) {
		return {
			window: customEnv?.window || (typeof window !== 'undefined' ? window : undefined),
			document: customEnv?.document || (typeof document !== 'undefined' ? document : undefined),
			pageWindow: getPageWindow(customEnv?.pageWindow),
			GM_xmlhttpRequest: customEnv?.GM_xmlhttpRequest ||
				(typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null),
			setInterval: customEnv?.setInterval || (typeof window !== 'undefined' ? window.setInterval.bind(window) : null),
			clearInterval: customEnv?.clearInterval || (typeof window !== 'undefined' ? window.clearInterval.bind(window) : null),
			setTimeout: customEnv?.setTimeout || (typeof window !== 'undefined' ? window.setTimeout.bind(window) : null),
			clearTimeout: customEnv?.clearTimeout || (typeof window !== 'undefined' ? window.clearTimeout.bind(window) : null),
			console: customEnv?.console || console,
		};
	}

	function createBridgeRuntime(customEnv) {
		const env = createDefaultEnv(customEnv);
		const state = {
			enabled: CONFIG.autoStart,
			controlEpoch: 0,
			lastRoomId: '',
			lastRequestKey: '',
			inFlightToken: 0,
			intervalId: null,
			inFlightRequestIdByRoom: new Map(),
			inFlightStartedAtByRoom: new Map(),
			lastSeenRequestIdByRoom: new Map(),
			lastHandledRequestIdByRoom: new Map(),
			submittedRequestIdByRoom: new Map(),
			pendingSubmissionByRoom: new Map(),
			lastBattleLogLengthByRoom: new Map(),
			lastBattleLogSourceByRoom: new Map(),
			printNextBattleState: false,
			logNextSuccessfulPredict: false,
			lastStatus: 'idle',
			lastStatusPhase: 'idle',
			ui: null,
			dotNode: null,
			statusNode: null,
			contextNode: null,
			buttonNode: null,
			printButtonNode: null,
			successLogButtonNode: null,
		};

		function clearInFlight(roomId, requestId) {
			if (!roomId) return;
			const current = state.inFlightRequestIdByRoom.get(roomId);
			if (!requestId || current === requestId) {
				state.inFlightRequestIdByRoom.delete(roomId);
				state.inFlightStartedAtByRoom.delete(roomId);
			}
		}

		function clearPendingSubmission(roomId, requestId) {
			if (!roomId) return;
			const pending = state.pendingSubmissionByRoom.get(roomId);
			if (!pending) return;
			if (!requestId || pending.bridgeRequestId === requestId) {
				state.pendingSubmissionByRoom.delete(roomId);
			}
		}

		function resetTransientRoomState(roomId) {
			clearInFlight(roomId);
			clearPendingSubmission(roomId);
		}

		function classifyOverlayStatus(text) {
			const value = String(text || '').trim().toLowerCase();
			if (!value) return 'idle';
			if (value === 'enabled' || value === 'paused' || value === 'idle') return value;
			if (value.startsWith('waiting for a battle room') || value.startsWith('waiting for a single active battle room')) return 'waiting';
			if (value.startsWith('waiting for a request')) return 'waiting';
			if (value.startsWith('request in flight')) return 'dispatching';
			if (value.startsWith('sending rqid')) return 'dispatching';
			if (value.startsWith('pending bridge result')) return 'bridge-pending';
			if (value.startsWith('unknown upstream outcome')) return 'bridge-unknown';
			if (value.startsWith('bridge error')) return 'bridge-error';
			if (value.startsWith('model returned no choice')) return 'bridge-error';
			if (value.startsWith('could not submit')) return 'submit-error';
			if (value.startsWith('stale in-flight request cleared')) return 'stale-in-flight';
			if (value.startsWith('submitted ')) return 'awaiting-acceptance';
			if (value.startsWith('awaiting acceptance')) return 'awaiting-acceptance';
			if (value.startsWith('retrying ')) return 'retrying';
			if (value.startsWith('confirmed ')) return 'confirmed';
			if (value.startsWith('armed to ')) return 'armed';
			if (value.startsWith('discarded stale bridge response')) return 'discarded';
			if (value.startsWith('request already handled')) return 'handled';
			return 'other';
		}

		function phaseColor(phase) {
			const map = {
				idle: '#475569',
				enabled: '#34d399',
				paused: '#94a3b8',
				waiting: '#fbbf24',
				dispatching: '#60a5fa',
				'bridge-pending': '#818cf8',
				'bridge-unknown': '#f97316',
				'bridge-error': '#f87171',
				'submit-error': '#f87171',
				'stale-in-flight': '#fb923c',
				'awaiting-acceptance': '#22d3ee',
				retrying: '#fb923c',
				confirmed: '#4ade80',
				armed: '#e879f9',
				discarded: '#64748b',
				handled: '#64748b',
				other: '#94a3b8',
			};
			return map[phase] || '#94a3b8';
		}

		function setStatus(text) {
			const phase = classifyOverlayStatus(text);
			if (state.lastStatus === text || state.lastStatusPhase === phase) return;
			state.lastStatus = text;
			state.lastStatusPhase = phase;
			if (state.statusNode) state.statusNode.textContent = text;
			if (state.dotNode) {
				state.dotNode.style.background = phaseColor(phase);
				state.dotNode.setAttribute('data-phase', phase);
			}
		}

		function setContext(text) {
			if (state.contextNode?.textContent === text) return;
			if (state.contextNode) state.contextNode.textContent = text;
		}

		function setEnabled(enabled) {
			state.enabled = enabled;
			if (!enabled) {
				// Treat pause as a cancellation point for any outstanding model/submission work,
				// but keep historical tracking so resume stays anchored to the same battle state.
				state.controlEpoch++;
				state.inFlightToken++;
				state.inFlightRequestIdByRoom.clear();
				state.inFlightStartedAtByRoom.clear();
				state.pendingSubmissionByRoom.clear();
			}
			if (state.buttonNode) {
				state.buttonNode.textContent = enabled ? 'Pause model control' : 'Resume model control';
			}
			setStatus(enabled ? 'enabled' : 'paused');
		}

		function noteRequestSeen(roomId, request) {
			if (!roomId || !request) return;
			state.lastSeenRequestIdByRoom.set(roomId, buildRequestIdentity(roomId, request));
		}

		function markRequestHandled(roomId, bridgeRequestId, logLength, logSource) {
			if (!roomId || !bridgeRequestId) return;
			if (typeof logLength === 'number') {
				state.lastBattleLogLengthByRoom.set(roomId, logLength);
			}
			if (logSource) {
				state.lastBattleLogSourceByRoom.set(roomId, logSource);
			}
			state.lastHandledRequestIdByRoom.set(roomId, bridgeRequestId);
			resetTransientRoomState(roomId);
		}

		function reconcilePendingSubmission(roomId, request, logLength, logSource) {
			const pending = state.pendingSubmissionByRoom.get(roomId);
			if (!pending) return {blocked: false};
			const currentBridgeRequestId = request ?
				buildBridgeRequestId(state.controlEpoch, roomId, request) :
				'';
			if (!request || request.wait || (currentBridgeRequestId && currentBridgeRequestId !== pending.bridgeRequestId)) {
				markRequestHandled(roomId, pending.bridgeRequestId, logLength, logSource || pending.logSource);
				setStatus(`confirmed ${pending.choice} via ${pending.method}`);
				return {blocked: false, confirmed: true};
			}
			setStatus(`awaiting acceptance (${request?.rqid ?? 'n/a'})`);
			return {blocked: true, reason: 'pending-submission'};
		}

		function reconcileInFlightRequest(roomId, bridgeRequestId) {
			const current = state.inFlightRequestIdByRoom.get(roomId);
			if (!current || current !== bridgeRequestId) return false;
			const startedAt = state.inFlightStartedAtByRoom.get(roomId) || 0;
			if (!startedAt) return false;
			if (Date.now() - startedAt < CONFIG.requestTimeoutMs + IN_FLIGHT_WATCHDOG_GRACE_MS) return false;
			clearInFlight(roomId, current);
			setStatus(`stale in-flight request cleared (${bridgeRequestId})`);
			return true;
		}

		function updatePrintButton() {
			if (state.printButtonNode) {
				state.printButtonNode.textContent = state.printNextBattleState ?
					'Cancel battle-state print' :
					'Print next state';
			}
		}

		function updateSuccessLogButton() {
			if (state.successLogButtonNode) {
				state.successLogButtonNode.textContent = state.logNextSuccessfulPredict ?
					'Cancel next success log' :
					'Log next successful predict';
			}
		}

		function setPrintNextBattleState(armed) {
			state.printNextBattleState = armed;
			updatePrintButton();
			setStatus(armed ? 'armed to print next battle state' : (state.enabled ? 'enabled' : 'paused'));
		}

		function setLogNextSuccessfulPredict(armed) {
			state.logNextSuccessfulPredict = armed;
			updateSuccessLogButton();
			setStatus(armed ? 'armed to log next successful predict' : (state.enabled ? 'enabled' : 'paused'));
		}

		function logBattleStateSnapshot(roomId, payload) {
			const snapshot = clone(payload);
			const rqid = snapshot?.request?.rqid ?? 'n/a';
			env.console.groupCollapsed(`[PS bridge] battle-state snapshot room=${roomId} rqid=${rqid}`);
			env.console.log(snapshot);
			env.console.groupEnd();
		}

		function ensureUi() {
			if (state.ui || !env.document?.body) return;

			// Inject panel styles + PS page-trim rules (Chrome/Safari compatible via :has())
			if (!env.document.getElementById('__psbmb-style')) {
				const styleEl = env.document.createElement('style');
				styleEl.id = '__psbmb-style';
				styleEl.textContent = [
					'html body .__psbmb-panel{',
					'  color:#e2e8f0;',
					'  font:11px/1.45 "JetBrains Mono","Cascadia Code","Fira Code",ui-monospace,"Courier New",monospace;',
					'  border:1px solid rgba(56,189,248,0.22);',
					'  border-radius:10px;',
					'  overflow:hidden;',
					'}',
					'html body .__psbmb-header{',
					'  display:flex;align-items:center;gap:6px;',
					'  padding:9px 10px 7px;',
					'  border-bottom:1px solid rgba(255,255,255,0.07);',
					'  cursor:default;',
					'}',
					'html body .__psbmb-dot{',
					'  width:8px;height:8px;border-radius:50%;',
					'  flex-shrink:0;transition:background 0.2s ease;',
					'}',
					'html body .__psbmb-dot[data-phase="dispatching"],',
					'html body .__psbmb-dot[data-phase="bridge-pending"]{',
					'  animation:__psbmb-pulse 1.1s ease-in-out infinite;',
					'}',
					'@keyframes __psbmb-pulse{0%,100%{opacity:1}50%{opacity:0.3}}',
					'html body .__psbmb-title{',
					'  font-weight:700;font-size:10px;letter-spacing:0.04em;',
					'  text-transform:uppercase;color:#64748b;',
					'  flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
					'}',
					'html body .__psbmb-toggle{',
					'  background:none;border:none;color:#475569;cursor:pointer;',
					'  padding:0 2px;font-size:15px;line-height:1;flex-shrink:0;',
					'  transition:color 0.15s;',
					'}',
					'html body .__psbmb-toggle:hover{color:#94a3b8;}',
					'html body .__psbmb-body{padding:8px 10px 10px;}',
					'html body .__psbmb-meta{',
					'  font-size:10px;color:#475569;margin-bottom:4px;',
					'  word-break:break-all;line-height:1.4;',
					'}',
					'html body .__psbmb-status{',
					'  font-size:11px;font-weight:600;color:#94a3b8;',
					'  margin-bottom:8px;margin-top:2px;min-height:16px;',
					'}',
					'html body .__psbmb-btn{',
					'  cursor:pointer;padding:5px 10px;',
					'  border:1px solid rgba(255,255,255,0.1);border-radius:7px;',
					'  font:inherit;font-weight:700;font-size:10px;letter-spacing:0.03em;',
					'  display:block;width:100%;margin-bottom:5px;',
					'  transition:opacity 0.15s,transform 0.1s;',
					'}',
					'html body .__psbmb-btn:last-child{margin-bottom:0;}',
					'html body .__psbmb-btn:hover{opacity:0.82;}',
					'html body .__psbmb-btn:active{transform:scale(0.98);}',
					'html body .__psbmb-btn-primary{background:#1d4ed8;color:#fff;border-color:#3b82f6;}',
					'html body .__psbmb-btn-secondary{background:#0f766e;color:#fff;border-color:#14b8a6;}',
					'html body .__psbmb-btn-tertiary{background:#581c87;color:#fff;border-color:#7c3aed;}',
					/* PS page-trim rules — gated on .mainmenuwrapper so they only fire on PS pages */
					'html:has(.mainmenuwrapper) .topbar .userbar button[name="login"],',
					'html:has(.mainmenuwrapper) .topbar .userbar button[name="register"]{display:none!important;}',
					'html:has(.mainmenuwrapper) .mainmenu button[value="ladder"],',
					'html:has(.mainmenuwrapper) .mainmenu a[href$="/ladder"]{display:none!important;}',
					'html:has(.mainmenuwrapper) .mainmenu button[value="battles"]{display:none!important;}',
					'html:has(.mainmenuwrapper) .mainmenu button[name="finduser"]{display:none!important;}',
					'html:has(.mainmenuwrapper) .rightmenu .newsentry,',
					'html:has(.mainmenuwrapper) .rightmenu .readmore{display:none!important;}',
					'html:has(.mainmenuwrapper) .mainmenufooter{display:none!important;}',
					'html:has(.mainmenuwrapper) .roomcounters button[value="battles"]{display:none!important;}',
					'html:has(.mainmenuwrapper) a[href*="replay.pokemonshowdown.com"],',
					'html:has(.mainmenuwrapper) button[name="openReplay"]{display:none!important;}',
				].join('\n');
				(env.document.head || env.document.documentElement).appendChild(styleEl);
			}

			// Root — position/z-index/shadow kept inline so they always win specificity
			const root = env.document.createElement('div');
			root.className = '__psbmb-panel';
			root.style.cssText = [
				'position:fixed',
				'right:12px',
				'bottom:12px',
				'z-index:2147483647',
				'background:rgba(8,12,20,0.93)',
				'box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04) inset',
				'min-width:256px',
				'max-width:320px',
			].join(';');

			// Header
			const header = env.document.createElement('div');
			header.className = '__psbmb-header';

			const dot = env.document.createElement('span');
			dot.className = '__psbmb-dot';
			const initPhase = classifyOverlayStatus(state.lastStatus);
			dot.style.background = phaseColor(initPhase);
			dot.setAttribute('data-phase', initPhase);

			const titleEl = env.document.createElement('span');
			titleEl.className = '__psbmb-title';
			titleEl.textContent = `bridge v${BRIDGE_VERSION}`;

			const toggleBtn = env.document.createElement('button');
			toggleBtn.className = '__psbmb-toggle';
			toggleBtn.type = 'button';
			toggleBtn.textContent = '−'; // minus sign
			toggleBtn.title = 'Collapse panel';

			header.append(dot, titleEl, toggleBtn);

			// Body
			const body = env.document.createElement('div');
			body.className = '__psbmb-body';

			const meta = env.document.createElement('div');
			meta.className = '__psbmb-meta';
			meta.textContent = `build ${SCRIPT_BUILD} · ${CONFIG.endpoint}`;

			const context = env.document.createElement('div');
			context.className = '__psbmb-meta';
			context.textContent = 'room: waiting';

			const status = env.document.createElement('div');
			status.className = '__psbmb-status';
			status.textContent = state.lastStatus;

			const button = env.document.createElement('button');
			button.type = 'button';
			button.className = '__psbmb-btn __psbmb-btn-primary';
			button.textContent = state.enabled ? 'Pause model control' : 'Resume model control';
			button.addEventListener('click', () => setEnabled(!state.enabled));

			const printButton = env.document.createElement('button');
			printButton.type = 'button';
			printButton.className = '__psbmb-btn __psbmb-btn-secondary';
			printButton.textContent = state.printNextBattleState ? 'Cancel battle-state print' : 'Print next state';
			printButton.addEventListener('click', () => setPrintNextBattleState(!state.printNextBattleState));

			const successLogButton = env.document.createElement('button');
			successLogButton.type = 'button';
			successLogButton.className = '__psbmb-btn __psbmb-btn-tertiary';
			successLogButton.textContent = state.logNextSuccessfulPredict ?
				'Cancel next success log' :
				'Log next successful predict';
			successLogButton.addEventListener('click', () => {
				setLogNextSuccessfulPredict(!state.logNextSuccessfulPredict);
			});

			body.append(meta, context, status, button, printButton, successLogButton);
			root.append(header, body);
			env.document.body.appendChild(root);

			// Collapse toggle
			let collapsed = false;
			toggleBtn.addEventListener('click', () => {
				collapsed = !collapsed;
				body.style.display = collapsed ? 'none' : '';
				toggleBtn.textContent = collapsed ? '+' : '−';
				toggleBtn.title = collapsed ? 'Expand panel' : 'Collapse panel';
			});

			state.ui = root;
			state.dotNode = dot;
			state.statusNode = status;
			state.contextNode = context;
			state.buttonNode = button;
			state.printButtonNode = printButton;
			state.successLogButtonNode = successLogButton;
		}

		function requestJson(url, payload, options) {
			const json = JSON.stringify(payload);
			const acceptAnyStatus = !!options?.acceptAnyStatus;
			const buildRequestError = (status, responseText) => {
				const snippet = String(responseText || '').trim();
				if (!snippet) return `Model request failed with ${status}.`;
				return `Model request failed with ${status}: ${snippet.slice(0, 180)}`;
			};
			return new Promise((resolve, reject) => {
				if (typeof env.GM_xmlhttpRequest === 'function') {
					const timer = env.setTimeout(() => {
						reject(new Error('Model request timed out.'));
					}, CONFIG.requestTimeoutMs);
					env.GM_xmlhttpRequest({
						method: 'POST',
						url,
						data: json,
						headers: {'Content-Type': 'application/json'},
						onload: response => {
							env.clearTimeout(timer);
							if (!acceptAnyStatus && (response.status < 200 || response.status >= 300)) {
								reject(new Error(buildRequestError(response.status, response.responseText)));
								return;
							}
							resolve({
								status: response.status,
								text: response.responseText || '',
							});
						},
						onerror: () => {
							env.clearTimeout(timer);
							reject(new Error('Model request failed.'));
						},
						ontimeout: () => {
							env.clearTimeout(timer);
							reject(new Error('Model request timed out.'));
						},
						timeout: CONFIG.requestTimeoutMs,
					});
					return;
				}

				const controller = new AbortController();
				const timer = env.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
				fetch(url, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: json,
					signal: controller.signal,
				}).then(async response => {
					env.clearTimeout(timer);
					const text = await response.text();
					if (!acceptAnyStatus && !response.ok) {
						throw new Error(buildRequestError(response.status, text));
					}
					resolve({
						status: response.status,
						text,
					});
				}).catch(error => {
					env.clearTimeout(timer);
					reject(error);
				});
			});
		}

		function parseModelResponse(text) {
			if (!text) return null;
			try {
				return JSON.parse(text);
			} catch (error) {
				throw new Error(`Model response was not valid JSON: ${error.message}`);
			}
		}

		function getCurrentBridgeContext(room, roomId) {
			const liveRequestInfo = extractBattleRequest(room, {
				roomId,
				lastSeenRequestIdByRoom: state.lastSeenRequestIdByRoom,
			});
			if (!liveRequestInfo.request) {
				return {
					requestInfo: liveRequestInfo,
					bridgeContext: null,
				};
			}
			return {
				requestInfo: liveRequestInfo,
				bridgeContext: buildBridgeRequestContext(
					state.controlEpoch,
					room,
					liveRequestInfo.request,
					env.window?.location
				),
			};
		}

		function canSubmitBridgeResponse(room, roomId, bridgeRequestId) {
			if (!bridgeRequestId || state.submittedRequestIdByRoom.get(roomId) === bridgeRequestId) {
				return {ok: false, reason: 'already-submitted'};
			}
			const {bridgeContext} = getCurrentBridgeContext(room, roomId);
			if (!bridgeContext || bridgeContext.bridgeRequestId !== bridgeRequestId) {
				return {ok: false, reason: 'stale-bridge-request'};
			}
			return {ok: true, bridgeContext};
		}

		function submitChoice(room, choice, rqid) {
			if (!room || !choice) return null;
			const command = formatChooseCommand(choice, rqid);
			if (typeof room.send === 'function') {
				try {
					room.send(command);
					return {method: 'room.send', command};
				} catch (error) {
					env.console.warn('[PS bridge] room.send failed; falling back to room.battle.choose:', error);
				}
			}
			if (rqid !== undefined && rqid !== null) return null;
			if (room.battle && typeof room.battle.choose === 'function') {
				try {
					room.battle.choose(choice);
					return {method: 'battle.choose', command};
				} catch (error) {
					env.console.warn('[PS bridge] room.battle.choose failed:', error);
				}
			}
			return null;
		}

		async function handleRequest(room, requestInfo, roomLookup, historySnapshot, requestId, requestToken) {
			const payload = buildRequestPayload({
				room,
				request: requestInfo.request,
				roomLookupSource: roomLookup.source,
				requestSource: requestInfo.source,
				historySnapshot,
				state,
				pageWindow: env.pageWindow,
				locationLike: env.window?.location,
			});
			const roomId = payload.roomid;
			const logLength = payload.logLength;
			const bridgeMeta = payload.browser_bridge_meta || {};
			const bridgeRequestId = bridgeMeta.bridge_request_id || requestId;
			setContext(`room: ${roomId || 'unknown'}; rqid: ${requestInfo.request?.rqid ?? 'n/a'}`);

			if (state.printNextBattleState) {
				logBattleStateSnapshot(roomId, payload);
				void requestJson(CONFIG.debugEndpoint, payload).catch(error => {
					env.console.warn('[PS bridge] debug snapshot upload failed:', error);
				});
				state.printNextBattleState = false;
				updatePrintButton();
			}

			const directChoice = deriveDirectChoiceFromRequest(requestInfo.request);
			if (directChoice) {
				const submitCheck = canSubmitBridgeResponse(room, roomId, bridgeRequestId);
				if (!submitCheck.ok) {
					clearInFlight(roomId, bridgeRequestId);
					setStatus(submitCheck.reason === 'already-submitted' ?
						'awaiting acceptance' :
						'discarded stale bridge response');
					return;
				}
				const submission = submitChoice(room, directChoice, requestInfo.request?.rqid);
				if (!submission) {
					setStatus('could not submit direct choice');
					clearInFlight(roomId, bridgeRequestId);
					return;
				}
				const existingPending = state.pendingSubmissionByRoom.get(roomId);
				const attempts = existingPending?.bridgeRequestId === bridgeRequestId ? existingPending.attempts + 1 : 1;
				state.submittedRequestIdByRoom.set(roomId, bridgeRequestId);
				state.pendingSubmissionByRoom.set(roomId, {
					bridgeRequestId,
					requestIdentity: bridgeMeta.request_identity || buildRequestIdentity(roomId, requestInfo.request),
					choice: directChoice,
					method: submission.method,
					logSource: payload.log_source || 'none',
					attempts,
					submittedAt: Date.now(),
					nextRetryAt: Date.now() + SUBMISSION_RETRY_DELAY_MS,
				});
				clearInFlight(roomId, bridgeRequestId);
				setStatus(`submitted ${directChoice} via ${submission.method}; awaiting acceptance`);
				return;
			}

			setStatus(`sending rqid ${payload.request?.rqid ?? 'n/a'}`);
			let bridgeResponseText;
			let bridgeResponseStatus;
			try {
				const response = await requestJson(CONFIG.endpoint, payload, {acceptAnyStatus: true});
				bridgeResponseStatus = response.status;
				bridgeResponseText = response.text;
			} catch (error) {
				if (requestToken !== state.inFlightToken || !state.enabled) {
					clearInFlight(roomId, bridgeRequestId);
					return;
				}
				env.console.error('[PS bridge] model request failed:', error);
				setStatus(`error: ${error.message || error}`);
				clearInFlight(roomId, bridgeRequestId);
				return;
			}

			if (requestToken !== state.inFlightToken || !state.enabled) {
				clearInFlight(roomId, bridgeRequestId);
				return;
			}
			let response;
			try {
				response = parseModelResponse(bridgeResponseText);
			} catch (error) {
				env.console.error('[PS bridge] invalid model response:', error);
				setStatus(`error: ${error.message || error}`);
				clearInFlight(roomId, bridgeRequestId);
				return;
			}
			if (!isObject(response)) response = {};
			const responseBridgeRequestId = response.bridge_request_id || bridgeRequestId;
			const bridgeStatus = response.bridge_status ||
				(bridgeResponseStatus >= 200 && bridgeResponseStatus < 300 ? 'completed' : 'failed');
			const dedupeSource = response.dedupe_source || 'fresh';

			if (bridgeStatus === 'pending') {
				setStatus('pending bridge result');
				return;
			}
			if (bridgeStatus === 'unknown_outcome') {
				markRequestHandled(roomId, bridgeRequestId, logLength, historySnapshot.source);
				setStatus('unknown upstream outcome; pause/resume to retry');
				return;
			}
			if (bridgeStatus === 'validation_error' || bridgeStatus === 'failed') {
				markRequestHandled(roomId, bridgeRequestId, logLength, historySnapshot.source);
				setStatus(`bridge error: ${response.error || bridgeStatus}`);
				return;
			}
			if (state.logNextSuccessfulPredict) {
				state.logNextSuccessfulPredict = false;
				updateSuccessLogButton();
			}
			const choice = responseToChoiceForRequest(requestInfo.request, response);
			if (!choice) {
				setStatus('model returned no choice');
				env.console.warn('[PS bridge] unable to derive a battle choice from response:', response);
				markRequestHandled(roomId, bridgeRequestId, logLength, historySnapshot.source);
				return;
			}
			const submitCheck = canSubmitBridgeResponse(room, roomId, responseBridgeRequestId);
			if (!submitCheck.ok) {
				clearInFlight(roomId, bridgeRequestId);
				setStatus(submitCheck.reason === 'already-submitted' ?
					'awaiting acceptance' :
					'discarded stale bridge response');
				return;
			}
			const submission = submitChoice(room, choice, payload.request?.rqid);
			if (!submission) {
				setStatus('could not submit choice');
				env.console.error('[PS bridge] room.send was not available; could not submit', choice);
				markRequestHandled(roomId, bridgeRequestId, logLength, historySnapshot.source);
				return;
			}

			const existingPending = state.pendingSubmissionByRoom.get(roomId);
			const attempts = existingPending?.bridgeRequestId === responseBridgeRequestId ? existingPending.attempts + 1 : 1;
			state.submittedRequestIdByRoom.set(roomId, responseBridgeRequestId);
			state.pendingSubmissionByRoom.set(roomId, {
				bridgeRequestId: responseBridgeRequestId,
				requestIdentity: bridgeMeta.request_identity || buildRequestIdentity(roomId, requestInfo.request),
				choice,
				method: submission.method,
				logSource: payload.log_source || 'none',
				attempts,
				submittedAt: Date.now(),
				nextRetryAt: Date.now() + SUBMISSION_RETRY_DELAY_MS,
			});
			clearInFlight(roomId, bridgeRequestId);
			setStatus(
				dedupeSource === 'cached' ?
					`submitted ${choice} via ${submission.method}; cached bridge result` :
					`submitted ${choice} via ${submission.method}; awaiting acceptance`
			);
		}

		function tick() {
			ensureUi();
			if (!state.enabled) return;

			const preferredRoomId = getRoomIdFromLocation(env.window?.location);
			const roomLookup = resolveBattleRoom(env.pageWindow, preferredRoomId, state.lastRoomId);
			const room = roomLookup.room;
			if (!room?.battle) {
				setContext(`room: waiting (${roomLookup.source})`);
				setStatus(roomLookup.source === 'ambiguous-battle-room' ?
					'waiting for a single active battle room' :
					'waiting for a battle room');
				return;
			}

			const roomId = extractRoomId(room, preferredRoomId);
			const requestInfo = extractBattleRequest(room, {
				roomId,
				lastSeenRequestIdByRoom: state.lastSeenRequestIdByRoom,
			});
			setContext(`room: ${roomId || 'unknown'}; rqid: ${requestInfo.request?.rqid ?? 'n/a'}`);
			const historySnapshot = collectBattleUpdates(room, roomId, state);
			const currentLogLength = historySnapshot.logLength ?? undefined;
			const pendingState = reconcilePendingSubmission(roomId, requestInfo.request, currentLogLength, historySnapshot.source);
			if (pendingState.blocked) return;
			if (!requestInfo.request || requestInfo.request.wait) {
				setStatus(`waiting for a request in ${roomId || 'unknown room'}`);
				return;
			}
			noteRequestSeen(roomId, requestInfo.request);
			const bridgeContext = buildBridgeRequestContext(
				state.controlEpoch,
				room,
				requestInfo.request,
				env.window?.location
			);

			const lastHandledRequestId = state.lastHandledRequestIdByRoom.get(roomId) || '';
			const inFlightRequestId = state.inFlightRequestIdByRoom.get(roomId) || '';
			const tracking = shouldHandleRequest(
				lastHandledRequestId,
				inFlightRequestId,
				roomId,
				requestInfo.request,
				bridgeContext.bridgeRequestId
			);
			if (tracking.reason === 'in-flight' && reconcileInFlightRequest(roomId, bridgeContext.bridgeRequestId)) {
				return;
			}
			if (!tracking.shouldHandle) {
				setStatus(tracking.reason === 'in-flight' ?
					`request in flight (${bridgeContext.bridgeRequestId})` :
					`request already handled (${bridgeContext.bridgeRequestId})`);
				return;
			}

			state.lastRoomId = roomId;
			state.lastRequestKey = tracking.requestId;
			state.inFlightRequestIdByRoom.set(roomId, tracking.requestId);
			state.inFlightStartedAtByRoom.set(roomId, Date.now());
			state.inFlightToken++;
			const token = state.inFlightToken;
			void handleRequest(room, requestInfo, roomLookup, historySnapshot, tracking.requestId, token);
		}

		function boot() {
			if (!env.window || !env.document) return;
			ensureUi();
			setEnabled(CONFIG.autoStart);
			state.intervalId = env.setInterval(tick, CONFIG.pollIntervalMs);
			tick();
		}

		function shutdown(reason) {
			if (state.intervalId && env.clearInterval) {
				env.clearInterval(state.intervalId);
			}
			state.intervalId = null;
			state.inFlightRequestIdByRoom.clear();
			state.inFlightStartedAtByRoom.clear();
			state.pendingSubmissionByRoom.clear();
			if (state.ui?.parentNode) state.ui.parentNode.removeChild(state.ui);
			state.ui = null;
			if (env.pageWindow?.[RUNTIME_SENTINEL] === api) {
				delete env.pageWindow[RUNTIME_SENTINEL];
			}
			if (reason) env.console.info(`[PS bridge] runtime stopped: ${reason}`);
		}
		const api = {
			env,
			state,
			tick,
			boot,
			shutdown,
			setEnabled,
			setPrintNextBattleState,
			setLogNextSuccessfulPredict,
			buildRequestPayload: options => buildRequestPayload({
				...options,
				state,
				pageWindow: options?.pageWindow || env.pageWindow,
				locationLike: options?.locationLike || env.window?.location,
			}),
			submitChoice,
		};
		return api;
	}

	function bootBrowserModelBridge(customEnv) {
		const pageWindow = getPageWindow(customEnv?.pageWindow);
		const existingRuntime = pageWindow?.[RUNTIME_SENTINEL];
		if (existingRuntime && typeof existingRuntime.shutdown === 'function') {
			existingRuntime.shutdown('replaced by a newer browser-model-bridge instance');
		}
		const runtime = createBridgeRuntime(customEnv);
		if (pageWindow) pageWindow[RUNTIME_SENTINEL] = runtime;
		runtime.boot();
		return runtime;
	}

	return {
		BRIDGE_VERSION,
		SCRIPT_VERSION,
		SCRIPT_BUILD,
		REQUEST_SOURCES,
		CONFIG,
		clone,
		valuesOf,
		looksLikeBattleRequest,
		getRoomIdFromLocation,
		extractRoomId,
		getRoomsApi,
		collectRoomCollections,
		getRoomById,
		findRoomById: (roomId, _roomsApi, pageWindow) => getRoomById(roomId, pageWindow).room,
		resolveBattleRoom,
		extractBattleRequest,
		getBattleRequestDetails: extractBattleRequest,
		requestKey,
		buildTrackedRequestKey,
		buildRequestIdentity,
		buildBridgeRequestId,
		buildBridgeRequestContext,
		shouldHandleRequest,
		buildRequestPayload,
		responseToChoice,
		responseToChoiceForRequest,
		normalizeChoiceTargetEntries,
		resolveSwitchRequestSlot,
		formatChooseCommand,
		buildChooseCommand: formatChooseCommand,
		deriveDirectChoiceFromRequest,
		createBridgeRuntime,
		bootBrowserModelBridge,
	};
});
