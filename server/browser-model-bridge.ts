import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import {load as loadConfig} from './config-loader';
import {ProtocolStateTracker} from '../sim/tools/protocol-state-tracker';
import type {ChoiceRequest} from '../sim/side';
import type {BattleSnapshot, SnapshotMon} from '../sim/tools/protocol-state-tracker';
import {
	buildLegalMoveOptions,
	buildLegalReviveTargets,
	buildLegalSwitchTargets,
	getPrimaryActivePokemon,
} from '../sim/tools/rl-action-helpers';
import {parseBooleanOption, resolveRLModelProfileConfig} from '../sim/tools/rl-model-profiles';

type BrowserBridgeRequest = AnyObject & {
	roomid?: string;
	roomId?: string;
	room_id?: string;
	client?: AnyObject;
	model_id?: string;
	modelId?: string;
	modelID?: string;
	state_vector?: number[];
	stateVector?: number[];
	battle_state?: AnyObject;
	battleState?: AnyObject;
	perspective_player?: 'p1' | 'p2';
	perspectivePlayer?: 'p1' | 'p2';
	request?: AnyObject;
	requestData?: AnyObject;
	battleRequest?: AnyObject;
	side?: AnyObject;
	active?: AnyObject[];
	legal_moves?: AnyObject[];
	legalMoves?: AnyObject[];
	legal_switches?: AnyObject[];
	legalSwitches?: AnyObject[];
	legal_revives?: AnyObject[];
	legalRevives?: AnyObject[];
	updates?: string[] | string;
	chunks?: string[] | string;
	battle_log?: string[] | string;
	battleLog?: string[] | string;
	logLength?: number;
	log_length?: number;
	log_source?: string;
	browser_bridge_meta?: AnyObject;
	browserBridgeMeta?: AnyObject;
	browser_observations?: AnyObject;
	browserObservations?: AnyObject;
};

type BrowserBridgeConfig = {
	host: string;
	port: number;
	modelEndpoint: string;
	modelID?: string;
	modelProfile?: string;
	allowVoluntarySwitches?: boolean;
	defaultPerspectivePlayer: 'p1' | 'p2';
	requestTimeoutMs: number;
	debugLogPath: string;
};

type BrowserBridgeRoute = '/health' | '/normalize' | '/predict' | '/debug';

type BrowserBridgeLogMetadata = {
	roomid: string;
	rqid?: number | string | null;
	route: BrowserBridgeRoute;
	requestSummary?: AnyObject;
	validationErrors?: string[];
	upstreamStatus?: number;
	upstreamBodySnippet?: string;
	error?: string;
};

type BrowserBridgeSession = {
	tracker: ProtocolStateTracker;
	lastAppliedLogLength: number;
	lastAppliedLogSource?: string;
};

type BridgeLedgerStatus = 'pending' | 'completed' | 'unknown' | 'failed';
type BridgeEnvelopeStatus = 'completed' | 'pending' | 'unknown_outcome' | 'validation_error' | 'failed';
type BridgeDedupeSource = 'fresh' | 'shared_pending' | 'cached';
type ModelServingKind = 'entity' | 'vector' | 'unknown';

type BridgeRequestMetadata = {
	bridgeRequestId: string;
	requestIdentity: string;
	controlEpoch: number;
};

type BridgeLedgerEntry = {
	bridgeRequestId: string;
	roomid: string;
	requestIdentity: string;
	status: BridgeLedgerStatus;
	createdAt: number;
	updatedAt: number;
	requestSummary: AnyObject;
	normalizedSummary: AnyObject;
	responseStatusCode?: number;
	responseBody?: AnyObject;
	error?: string;
	details?: string[];
	promise?: Promise<void>;
};

const REQUEST_LEDGER_TTL_MS = 120_000;
const MAX_REQUEST_LEDGER_ENTRIES = 256;

const REQUEST_FLAG_PASSTHROUGH_KEYS = [
	'wait',
	'teamPreview',
	'trapped',
	'maybeTrapped',
	'canSwitch',
	'switching_allowed',
	'switchAllowed',
] as const;

function pickFirst<T>(...values: Array<T | undefined | null>): T | undefined {
	for (const value of values) {
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

function clone<T>(value: T): T {
	if (value === undefined || value === null) return value;
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(value);
		} catch {}
	}
	return JSON.parse(JSON.stringify(value));
}

function isObject(value: unknown): value is Record<string, AnyObject> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequestRqid(value: unknown) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function deriveRequestSidePlayer(side: AnyObject | undefined): 'p1' | 'p2' | undefined {
	const rawSideId = side?.id as unknown;
	return rawSideId === 'p1' || rawSideId === 'p2' ? rawSideId : undefined;
}

function hasChoiceRequestShape(request: AnyObject | undefined): request is ChoiceRequest {
	return !!request && !!deriveRequestSidePlayer(request.side);
}

function toStringLines(value: string[] | string | undefined): string[] {
	if (!value) return [];
	if (typeof value === 'string') {
		return value.split('\n').filter(Boolean);
	}
	return value.filter(line => typeof line === 'string' && line.length > 0);
}

function joinUpdateLines(lines: string[]) {
	return lines.length ? lines.join('\n') : undefined;
}

function normalizeUpdateLines(payload: BrowserBridgeRequest): string[] {
	return toStringLines(payload.updates).length ? toStringLines(payload.updates) :
		toStringLines(payload.chunks).length ? toStringLines(payload.chunks) :
		toStringLines(payload.battle_log).length ? toStringLines(payload.battle_log) :
		toStringLines(payload.battleLog);
}

function normalizeLogLength(payload: BrowserBridgeRequest) {
	const rawValue = pickFirst(payload.logLength, payload.log_length);
	return typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : undefined;
}

function normalizeLogSource(payload: BrowserBridgeRequest) {
	const browserBridgeMeta = getBrowserBridgeMeta(payload);
	const rawValue = payload.log_source ??
		(typeof browserBridgeMeta?.log_source === 'string' ? browserBridgeMeta.log_source : undefined);
	if (typeof rawValue !== 'string') return undefined;
	const trimmed = rawValue.trim();
	return trimmed || undefined;
}

function derivePerspectivePlayer(payload: BrowserBridgeRequest, request: AnyObject | undefined, defaultPerspectivePlayer: 'p1' | 'p2') {
	const perspective = pickFirst(payload.perspective_player, payload.perspectivePlayer, request?.side?.id);
	return perspective === 'p1' ? 'p1' : perspective === 'p2' ? 'p2' : defaultPerspectivePlayer;
}

function shouldIncludeVoluntarySwitches(
	request: AnyObject | undefined,
	allowVoluntarySwitches: boolean | undefined,
) {
	if (request?.forceSwitch) return true;
	if (request?.teamPreview) return false;
	if (request?.active) return allowVoluntarySwitches ?? true;
	return true;
}

function deriveLegalMoves(request: AnyObject | undefined, active: AnyObject | undefined) {
	if (Array.isArray(request?.legal_moves) && request.legal_moves.length) return clone(request.legal_moves);
	if (Array.isArray(request?.legalMoves) && request.legalMoves.length) return clone(request.legalMoves);
	if (Array.isArray(active?.moves) && active.moves.length) return buildLegalMoveOptions(active);
	return [];
}

function toPositiveInteger(value: unknown) {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value :
		typeof value === 'string' && value.trim() && Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) :
		null;
}

function buildChoiceTargetEntries(
	player: 'p1' | 'p2',
	pokemon: AnyObject[],
	tracker: ProtocolStateTracker,
) {
	return pokemon.map((entry, index) => {
		const condition = String(entry?.condition || '');
		return {
			slot: tracker.getOwnStableSlot(player, entry?.ident, entry?.details) || index + 1,
			request_slot: index + 1,
			ident: String(entry?.ident || ''),
			details: String(entry?.details || ''),
			condition,
			active: !!entry?.active,
			fainted: condition.endsWith(' fnt'),
			reviving: !!entry?.reviving,
		};
	});
}

function preserveChoiceTargetFlag(
	rawEntry: AnyObject,
	match: AnyObject | null,
	keys: readonly string[],
) {
	for (const key of keys) {
		if (rawEntry[key] !== undefined) return rawEntry[key];
		if (match?.[key] !== undefined) return match[key];
	}
	return undefined;
}

function normalizeProvidedChoiceTargets(
	rawEntries: AnyObject[] | undefined,
	teamEntries: AnyObject[],
	targetType: 'switch' | 'revive',
) {
	const wantRevive = targetType === 'revive';
	const requestSlotMap = new Map(teamEntries.map(entry => [entry.request_slot, entry]));
	const stableSlotMap = new Map(teamEntries.map(entry => [entry.slot, entry]));
	const identMap = new Map(teamEntries.filter(entry => entry.ident).map(entry => [entry.ident, entry]));
	const detailsMap = new Map(teamEntries.filter(entry => entry.details).map(entry => [entry.details, entry]));
	const normalized: AnyObject[] = [];
	const seenRequestSlots = new Set<number>();

	for (const rawEntry of Array.isArray(rawEntries) ? rawEntries : []) {
		if (!isObject(rawEntry)) continue;
		let match = null;
		const requestSlot = toPositiveInteger(rawEntry.request_slot ?? rawEntry.requestSlot);
		if (requestSlot) match = requestSlotMap.get(requestSlot) || null;
		if (!match) {
			const stableSlot = toPositiveInteger(rawEntry.slot);
			if (stableSlot) match = stableSlotMap.get(stableSlot) || null;
		}
		if (!match && rawEntry.ident) match = identMap.get(String(rawEntry.ident)) || null;
		if (!match && rawEntry.details) match = detailsMap.get(String(rawEntry.details)) || null;

		const condition = String(rawEntry.condition || match?.condition || '');
		const disabled = preserveChoiceTargetFlag(rawEntry, match, ['disabled']);
		const trapped = preserveChoiceTargetFlag(rawEntry, match, ['trapped']);
		const maybeTrapped = preserveChoiceTargetFlag(rawEntry, match, ['maybeTrapped']);
		const canSwitch = preserveChoiceTargetFlag(rawEntry, match, ['canSwitch']);
		const canRevive = preserveChoiceTargetFlag(rawEntry, match, ['canRevive']);
		const normalizedEntry = {
			slot: toPositiveInteger(rawEntry.slot) ?? match?.slot ?? requestSlot ?? null,
			request_slot: requestSlot ?? match?.request_slot ?? toPositiveInteger(rawEntry.slot),
			ident: String(rawEntry.ident || match?.ident || ''),
			details: String(rawEntry.details || match?.details || ''),
			condition,
			active: rawEntry.active !== undefined ? !!rawEntry.active : !!match?.active,
			fainted: rawEntry.fainted !== undefined ? !!rawEntry.fainted : condition.endsWith(' fnt') || !!match?.fainted,
			reviving: rawEntry.reviving !== undefined ? !!rawEntry.reviving : !!match?.reviving,
			...(disabled !== undefined ? {disabled} : {}),
			...(trapped !== undefined ? {trapped} : {}),
			...(maybeTrapped !== undefined ? {maybeTrapped} : {}),
			...(canSwitch !== undefined ? {canSwitch} : {}),
			...(canRevive !== undefined ? {canRevive} : {}),
		};
		if (!toPositiveInteger(normalizedEntry.slot) || !toPositiveInteger(normalizedEntry.request_slot)) continue;
		if (wantRevive ? !normalizedEntry.fainted : (normalizedEntry.active || normalizedEntry.fainted)) continue;
		if (seenRequestSlots.has(normalizedEntry.request_slot)) continue;
		seenRequestSlots.add(normalizedEntry.request_slot);
		normalized.push(normalizedEntry);
	}

	return normalized;
}

function deriveLegalSwitches(
	request: AnyObject | undefined,
	side: AnyObject | undefined,
	tracker: ProtocolStateTracker,
	allowVoluntarySwitches: boolean | undefined,
) {
	const hasReviveSelection = !!request?.reviving ||
		(Array.isArray(side?.pokemon) && side.pokemon.some((pokemon: AnyObject) => pokemon?.reviving));
	if (hasReviveSelection) return [];
	if (!shouldIncludeVoluntarySwitches(request, allowVoluntarySwitches)) return [];
	const pokemon = side?.pokemon;
	if (!Array.isArray(pokemon) || !pokemon.length) return [];
	const player = deriveRequestSidePlayer(side);
	if (!player) return [];
	const teamEntries = buildChoiceTargetEntries(player, pokemon, tracker);
	const normalizedProvidedTargets = normalizeProvidedChoiceTargets(
		Array.isArray(request?.legal_switches) && request.legal_switches.length ? request.legal_switches :
			Array.isArray(request?.legalSwitches) && request.legalSwitches.length ? request.legalSwitches :
			undefined,
		teamEntries,
		'switch'
	);
	if (normalizedProvidedTargets.length) return normalizedProvidedTargets;
	return buildLegalSwitchTargets(player, pokemon, tracker.getOwnStableSlot.bind(tracker));
}

function deriveLegalRevives(request: AnyObject | undefined, side: AnyObject | undefined, tracker: ProtocolStateTracker) {
	const pokemon = side?.pokemon;
	if (!Array.isArray(pokemon) || !pokemon.length) return [];
	const player = deriveRequestSidePlayer(side);
	if (!player) return [];
	const teamEntries = buildChoiceTargetEntries(player, pokemon, tracker);
	const normalizedProvidedTargets = normalizeProvidedChoiceTargets(
		Array.isArray(request?.legal_revives) && request.legal_revives.length ? request.legal_revives :
			Array.isArray(request?.legalRevives) && request.legalRevives.length ? request.legalRevives :
			Array.isArray(request?.legal_switches) && request.legal_switches.length ? request.legal_switches :
			Array.isArray(request?.legalSwitches) && request.legalSwitches.length ? request.legalSwitches :
			undefined,
		teamEntries,
		'revive'
	);
	if (normalizedProvidedTargets.length) return normalizedProvidedTargets;
	return buildLegalReviveTargets(player, pokemon, tracker.getOwnStableSlot.bind(tracker));
}

function extractRequest(payload: BrowserBridgeRequest) {
	const rawRequest = pickFirst(payload.request, payload.requestData, payload.battleRequest) || payload;
	return clone(rawRequest);
}

function getBrowserBridgeMeta(payload: BrowserBridgeRequest) {
	const meta = pickFirst(payload.browser_bridge_meta, payload.browserBridgeMeta, payload.client);
	return isObject(meta) ? clone(meta) : undefined;
}

function normalizeControlEpoch(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value :
		typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) :
		0;
}

function buildFallbackRequestIdentity(roomid: string, request: AnyObject | undefined) {
	const rqid = normalizeRequestRqid(request?.rqid);
	if (rqid !== undefined) {
		return `${roomid}:rqid:${rqid}`;
	}
	const active = Array.isArray(request?.active) ? request.active[0] : null;
	const moves = Array.isArray(active?.moves) ? active.moves.map((move: AnyObject) => [
		move?.id || '',
		move?.move || '',
		!!move?.disabled,
	]) : [];
	const team = Array.isArray(request?.side?.pokemon) ? request.side.pokemon.map((pokemon: AnyObject) => [
		pokemon?.ident || '',
		pokemon?.condition || '',
		!!pokemon?.active,
		!!pokemon?.reviving,
	]) : [];
	return `${roomid}:${JSON.stringify([
		request?.rqid ?? null,
		!!request?.wait,
		!!request?.forceSwitch,
		!!request?.teamPreview,
		request?.side?.id || '',
		moves,
		team,
	])}`;
}

function buildBridgeRequestId(controlEpoch: number, roomid: string, requestIdentity: string) {
	return `${controlEpoch}:${roomid}:${requestIdentity}`;
}

function extractBridgeRequestMetadata(payload: BrowserBridgeRequest, roomid: string, request: AnyObject | undefined): BridgeRequestMetadata {
	const browserBridgeMeta = getBrowserBridgeMeta(payload);
	const controlEpoch = normalizeControlEpoch(browserBridgeMeta?.control_epoch);
	const requestIdentity = typeof browserBridgeMeta?.request_identity === 'string' && browserBridgeMeta.request_identity ?
		browserBridgeMeta.request_identity :
		buildFallbackRequestIdentity(roomid, request);
	const bridgeRequestId = typeof browserBridgeMeta?.bridge_request_id === 'string' && browserBridgeMeta.bridge_request_id ?
		browserBridgeMeta.bridge_request_id :
		buildBridgeRequestId(controlEpoch, roomid, requestIdentity);
	return {
		bridgeRequestId,
		requestIdentity,
		controlEpoch,
	};
}

function truncateForLog(value: string | undefined, maxLength = 400) {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength - 3)}...`;
}

function summarizeBridgeRequest(
	payload: BrowserBridgeRequest,
	request: AnyObject | undefined,
	normalized: AnyObject,
	roomid: string,
	appliedUpdateLines: string[],
) {
	const browserBridgeMeta = getBrowserBridgeMeta(payload);
	const bridgeRequestMeta = extractBridgeRequestMetadata(payload, roomid, request);
	const browserObservations = pickFirst(payload.browser_observations, payload.browserObservations);
	return {
		roomid,
		rqid: request?.rqid ?? null,
		side_id: request?.side?.id ?? normalized?.side?.id ?? null,
		wait: !!request?.wait,
		forceSwitch: !!request?.forceSwitch,
		teamPreview: !!request?.teamPreview,
		reviving: !!request?.reviving,
		update_count: normalizeUpdateLines(payload).length,
		applied_update_count: appliedUpdateLines.length,
		log_length: normalizeLogLength(payload) ?? null,
		log_source: normalizeLogSource(payload) ?? null,
		request_source: browserBridgeMeta?.request_source ?? null,
		room_lookup_source: browserBridgeMeta?.room_lookup_source ?? null,
		bridge_request_id: bridgeRequestMeta.bridgeRequestId,
		request_identity: bridgeRequestMeta.requestIdentity,
		control_epoch: bridgeRequestMeta.controlEpoch,
		script_version: browserBridgeMeta?.script_version ?? null,
		script_build: browserBridgeMeta?.script_build ?? null,
		log_next_successful_predict: !!browserBridgeMeta?.log_next_successful_predict,
		page_url: browserBridgeMeta?.page_url ?? null,
		browser_observations_present: isObject(browserObservations),
		browser_observation_turn_index: isObject(browserObservations) ? pickFirst(browserObservations.turn_index, browserObservations.turnIndex, null) : null,
		browser_own_side_source: isObject(browserObservations?.source_summary) ? browserObservations.source_summary.own_side_source ?? null : null,
		browser_opponent_side_source: isObject(browserObservations?.source_summary) ? browserObservations.source_summary.opponent_side_source ?? null : null,
		legal_moves: Array.isArray(normalized?.legal_moves) ? normalized.legal_moves.length : 0,
		legal_switches: Array.isArray(normalized?.legal_switches) ? normalized.legal_switches.length : 0,
		legal_revives: Array.isArray(normalized?.legal_revives) ? normalized.legal_revives.length : 0,
	};
}

function shouldLogSuccessfulPredict(payload: BrowserBridgeRequest) {
	const browserBridgeMeta = getBrowserBridgeMeta(payload);
	return !!browserBridgeMeta?.log_next_successful_predict;
}

function toNormalizedStringArray(value: unknown) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(entry => typeof entry === 'string' ? entry.trim() : '').filter(Boolean))].sort();
}

function ensureBattleSnapshotSide(state: AnyObject, sideID: 'p1' | 'p2') {
	if (!isObject(state[sideID])) {
		state[sideID] = {slots: [null, null, null, null, null, null], side_conditions: {}};
	}
	const side = state[sideID];
	if (!Array.isArray(side.slots)) {
		side.slots = [null, null, null, null, null, null];
	} else if (side.slots.length < 6) {
		side.slots = [...side.slots, ...Array(Math.max(0, 6 - side.slots.length)).fill(null)].slice(0, 6);
	}
	if (!isObject(side.side_conditions)) {
		side.side_conditions = {};
	}
	return side;
}

function ensureBattleSnapshotMon(state: AnyObject, uid: string, player: 'p1' | 'p2') {
	if (!isObject(state.mons)) {
		state.mons = {};
	}
	if (!isObject(state.mons[uid])) {
		state.mons[uid] = {
			uid,
			player,
			public_revealed: true,
			fainted: false,
			boosts: {},
			observed_moves: [],
		};
	}
	return state.mons[uid];
}

function mergeObservedMoves(existing: unknown, incoming: unknown) {
	return toNormalizedStringArray([
		...(Array.isArray(existing) ? existing : []).map(entry => normalizeObservedMoveName(entry)),
		...(Array.isArray(incoming) ? incoming : []).map(entry => normalizeObservedMoveName(entry)),
	]);
}

function normalizeObservedMoveName(value: unknown) {
	if (typeof value !== 'string') return '';
	return value.trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeSnapshotStatus(value: unknown): SnapshotMon['status'] {
	return value === 'brn' || value === 'par' || value === 'psn' || value === 'tox' || value === 'slp' || value === 'frz' ?
		value :
		undefined;
}

function mergeBoosts(existing: unknown, incoming: unknown) {
	const merged: Record<string, number> = {};
	for (const source of [existing, incoming]) {
		if (!isObject(source)) continue;
		for (const [key, value] of Object.entries(source)) {
			if (typeof value === 'number' && Number.isFinite(value)) {
				merged[key] = value;
			}
		}
	}
	return merged;
}

function mergeBrowserMonObservation(existing: SnapshotMon | undefined, incoming: AnyObject, player: 'p1' | 'p2', fallbackUid: string): SnapshotMon {
	const merged: SnapshotMon = {
		uid: typeof incoming.uid === 'string' && incoming.uid ? incoming.uid : existing?.uid ?? fallbackUid,
		player: incoming.player === 'p1' || incoming.player === 'p2' ? incoming.player : existing?.player ?? player,
		terastallized: Boolean(existing?.terastallized || incoming.terastallized),
		public_revealed: Boolean(existing?.public_revealed || incoming.public_revealed),
		fainted: incoming.fainted !== undefined ? !!incoming.fainted : !!existing?.fainted,
		boosts: mergeBoosts(existing?.boosts, incoming.boosts),
		observed_moves: mergeObservedMoves(existing?.observed_moves, incoming.observed_moves),
	};
	for (const key of ['species', 'ability', 'item', 'tera_type'] as const) {
		const incomingValue = incoming[key];
		const existingValue = existing?.[key];
		merged[key] = typeof incomingValue === 'string' && incomingValue ? incomingValue :
			typeof existingValue === 'string' && existingValue ? existingValue :
			existingValue ?? incomingValue;
	}
	for (const key of ['hp', 'max_hp', 'hp_frac'] as const) {
		const incomingValue = incoming[key];
		merged[key] = typeof incomingValue === 'number' && Number.isFinite(incomingValue) ? incomingValue : existing?.[key];
	}
	merged.status = normalizeSnapshotStatus(incoming.status) ?? existing?.status;
	if (merged.hp_frac === undefined && typeof merged.hp === 'number' && typeof merged.max_hp === 'number' && merged.max_hp > 0) {
		merged.hp_frac = Math.max(0, Math.min(1, merged.hp / merged.max_hp));
	}
	return merged;
}

function mergeBrowserSideObservation(
	state: AnyObject,
	sideID: 'p1' | 'p2',
	incoming: AnyObject | undefined,
) {
	if (!isObject(incoming)) return;
	const side = ensureBattleSnapshotSide(state, sideID);
	if (typeof incoming.active_uid === 'string' && incoming.active_uid) {
		side.active_uid = incoming.active_uid;
	}
	if (Array.isArray(incoming.slots)) {
		for (let i = 0; i < Math.min(incoming.slots.length, 6); i++) {
			const uid = typeof incoming.slots[i] === 'string' && incoming.slots[i] ? incoming.slots[i] : null;
			if (uid) {
				side.slots[i] = uid;
				ensureBattleSnapshotMon(state, uid, sideID);
			}
		}
	}
	if (isObject(incoming.side_conditions)) {
		for (const [key, value] of Object.entries(incoming.side_conditions)) {
			if (typeof value === 'number' && Number.isFinite(value)) {
				side.side_conditions[key] = value;
			}
		}
	}
	if (typeof side.active_uid === 'string' && side.active_uid) {
		ensureBattleSnapshotMon(state, side.active_uid, sideID);
	}
}

function extractBrowserObservations(payload: BrowserBridgeRequest) {
	const observations = pickFirst(payload.browser_observations, payload.browserObservations);
	return isObject(observations) ? clone(observations) : undefined;
}

function mergeBrowserObservationsIntoBattleState(
	stateInput: BattleSnapshot,
	payload: BrowserBridgeRequest,
) {
	const browserObservations = extractBrowserObservations(payload);
	if (!browserObservations) return clone(stateInput);

	const state = clone(stateInput) as BattleSnapshot;
	const observedTurnIndex = pickFirst(browserObservations.turn_index, browserObservations.turnIndex);
	if (typeof observedTurnIndex === 'number' && Number.isFinite(observedTurnIndex)) {
		state.turn_index = observedTurnIndex;
	}

	const observedField = isObject(browserObservations.field) ? browserObservations.field : undefined;
	if (typeof observedField?.weather === 'string' && observedField.weather) {
		state.field.weather = observedField.weather;
	}
	state.field.global_conditions = toNormalizedStringArray([
		...(Array.isArray(state.field.global_conditions) ? state.field.global_conditions : []),
		...(Array.isArray(observedField?.global_conditions) ? observedField.global_conditions : []),
	]);

	mergeBrowserSideObservation(state, 'p1', isObject(browserObservations.p1) ? browserObservations.p1 : undefined);
	mergeBrowserSideObservation(state, 'p2', isObject(browserObservations.p2) ? browserObservations.p2 : undefined);

	const observedMons = isObject(browserObservations.mons) ? browserObservations.mons : {};
	for (const [uid, incoming] of Object.entries(observedMons)) {
		if (!isObject(incoming) || !uid) continue;
		const rawPlayer = incoming.player as unknown;
		const player = rawPlayer === 'p1' || rawPlayer === 'p2' ? rawPlayer : (
			uid.startsWith('p1:') ? 'p1' : 'p2'
		);
		const existing = state.mons[uid];
		state.mons[uid] = mergeBrowserMonObservation(existing, incoming, player, uid);
	}

	return state;
}

export function formatBrowserBridgeDebugSnapshot(
	payload: BrowserBridgeRequest,
	normalized: AnyObject,
	metadata: BrowserBridgeLogMetadata,
) {
	const timestamp = new Date().toISOString();
	const header = [
		`=== ${timestamp}`,
		`route=${metadata.route}`,
		`roomid=${metadata.roomid}`,
		metadata.rqid === undefined || metadata.rqid === null ? '' : `rqid=${metadata.rqid}`,
		'===',
	].filter(Boolean).join(' ');
	const summary = {
		route: metadata.route,
		roomid: metadata.roomid,
		rqid: metadata.rqid ?? null,
		requestSummary: metadata.requestSummary || null,
		validationErrors: metadata.validationErrors || [],
		upstreamStatus: metadata.upstreamStatus ?? null,
		upstreamBodySnippet: metadata.upstreamBodySnippet ?? null,
		error: metadata.error ?? null,
	};
	return [
		header,
		'metadata:',
		JSON.stringify(summary, null, 2),
		'',
		'raw:',
		JSON.stringify(payload, null, 2),
		'',
		'normalized:',
		JSON.stringify(normalized, null, 2),
		'',
	].join('\n');
}

function getRoomId(payload: BrowserBridgeRequest, request: AnyObject | undefined) {
	return String(
		pickFirst(payload.roomid, payload.roomId, payload.room_id, request?.roomid, request?.roomId, request?.side?.roomid) ||
		'browser'
	);
}

function normalizeModelServingKind(value: unknown): ModelServingKind {
	if (value === 'entity' || value === 'vector') return value;
	return 'unknown';
}

export function normalizeBrowserModelRequest(
	payload: BrowserBridgeRequest,
	config: Pick<BrowserBridgeConfig, 'defaultPerspectivePlayer' | 'modelID' | 'allowVoluntarySwitches'> & {modelKind?: ModelServingKind},
	trackerInput?: ProtocolStateTracker,
	updateLinesOverride?: string[],
) {
	const request = extractRequest(payload);
	const settledRequest = hasChoiceRequestShape(request) ? request : null;
	const tracker = trackerInput || new ProtocolStateTracker();
	const updates = joinUpdateLines(updateLinesOverride ?? normalizeUpdateLines(payload));
	if (updates) tracker.applyChunk(updates);
	if (settledRequest) tracker.applyRequest(settledRequest);

	const inferredBattleState = tracker.getSnapshot();
	const battleState = mergeBrowserObservationsIntoBattleState(inferredBattleState, payload);
	const perspectivePlayer = derivePerspectivePlayer(payload, request, config.defaultPerspectivePlayer);
	const modelID = payload.model_id || payload.modelId || payload.modelID || config.modelID;
	const includeStateVector = config.modelKind !== 'entity';
	const stateVector = includeStateVector ? tracker.encodeState(battleState, perspectivePlayer) : undefined;
	const side = payload.side && isObject(payload.side) ? clone(payload.side) : clone(request?.side || null);
	const requestActive = settledRequest && 'active' in settledRequest && Array.isArray(settledRequest.active) ? settledRequest.active : [];
	const active = Array.isArray(payload.active) && payload.active.length ? clone(payload.active) : clone(requestActive);
	const activeForMoves = active.length ? active : requestActive;
	const legalMoves = deriveLegalMoves(request, activeForMoves[0]);
	const legalSwitches = deriveLegalSwitches(request, side, tracker, config.allowVoluntarySwitches);
	const legalRevives = deriveLegalRevives(request, side, tracker);
	const requestFlags = Object.fromEntries(
		REQUEST_FLAG_PASSTHROUGH_KEYS
			.map(key => [key, pickFirst(payload[key], request?.[key])])
			.filter(([, value]) => value !== undefined)
	) as AnyObject;

	return {
		...(modelID ? {
			model_id: modelID,
		} : {}),
		perspective_player: perspectivePlayer,
		...(stateVector ? {state_vector: stateVector} : {}),
		battle_state: battleState,
		legal_moves: legalMoves,
		legal_switches: legalSwitches,
		...(legalRevives.length ? {legal_revives: legalRevives} : {}),
		...(side ? {side} : {}),
		...(active.length ? {active} : {}),
		...((payload.forceSwitch ?? request?.forceSwitch) !== undefined ? {forceSwitch: payload.forceSwitch ?? request?.forceSwitch} : {}),
		...((payload.reviving ?? (isObject(request) ? request.reviving : undefined)) ? {reviving: true} : {}),
		...requestFlags,
	};
}

export function validateNormalizedPredictRequest(normalized: AnyObject, request: AnyObject | undefined) {
	const errors: string[] = [];
	if (!isObject(normalized.battle_state) || !isObject(normalized.battle_state.p1) || !isObject(normalized.battle_state.p2)) {
		errors.push('Missing normalized battle_state with p1 and p2 data.');
	}
	if (normalized.perspective_player !== 'p1' && normalized.perspective_player !== 'p2') {
		errors.push('Missing normalized perspective_player.');
	}
	if (!isObject(request)) {
		errors.push('Missing current request metadata.');
		return errors;
	}
	if (normalizeRequestRqid(request.rqid) === undefined) {
		errors.push('Missing request.rqid.');
	}
	const requestSide = deriveRequestSidePlayer(request.side) ?? deriveRequestSidePlayer(normalized.side);
	if (requestSide !== 'p1' && requestSide !== 'p2') {
		errors.push('Missing request.side.id.');
	}
	return errors;
}

function readBody(request: http.IncomingMessage, maxBodyBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		request.on('data', chunk => {
			total += chunk.length;
			if (total > maxBodyBytes) {
				reject(new Error('Request body too large.'));
				request.destroy();
				return;
			}
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function writeJson(response: http.ServerResponse, statusCode: number, body: AnyObject) {
	response.statusCode = statusCode;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.end(JSON.stringify(body));
}

async function proxyToModelEndpoint(modelEndpoint: string, payload: AnyObject, requestTimeoutMs: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		const response = await fetch(modelEndpoint, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			body: text,
		};
	} finally {
		clearTimeout(timer);
	}
}

export class BrowserModelBridgeServer {
	private readonly sessionByRoom = new Map<string, BrowserBridgeSession>();
	private readonly requestLedger = new Map<string, BridgeLedgerEntry>();
	private readonly modelServingKindById = new Map<string, ModelServingKind>();
	private modelHealthProbe: Promise<void> | null = null;
	private debugLogChain: Promise<void> = Promise.resolve();

	constructor(private readonly config: BrowserBridgeConfig) {}

	private getSession(roomid: string) {
		let session = this.sessionByRoom.get(roomid);
		if (!session) {
			session = {
				tracker: new ProtocolStateTracker(),
				lastAppliedLogLength: 0,
			};
			this.sessionByRoom.set(roomid, session);
		}
		return session;
	}

	private appendDebugLog(entry: string) {
		if (!this.config.debugLogPath) return Promise.resolve();
		const logPath = this.config.debugLogPath;
		const write = async () => {
			await fs.mkdir(path.dirname(logPath), {recursive: true});
			await fs.appendFile(logPath, entry, 'utf8');
		};
		const next = this.debugLogChain.catch(() => {}).then(write);
		this.debugLogChain = next.then(() => undefined, () => undefined);
		return next;
	}

	private getModelHealthUrl() {
		return new URL('health', this.config.modelEndpoint).toString();
	}

	private rememberModelServingKind(modelID: string | undefined, kind: unknown) {
		if (!modelID) return;
		const normalizedKind = normalizeModelServingKind(kind);
		if (normalizedKind === 'unknown') return;
		this.modelServingKindById.set(modelID, normalizedKind);
	}

	private recordModelServingKindsFromHealth(health: AnyObject) {
		const runtimeHealth = isObject(health.runtime_health) ? health.runtime_health : undefined;
		if (runtimeHealth) {
			for (const [modelID, entry] of Object.entries(runtimeHealth)) {
				this.rememberModelServingKind(modelID, isObject(entry) ? entry.kind : undefined);
			}
		}

		const workerHealth = isObject(health.worker_health) ? health.worker_health : undefined;
		if (workerHealth) {
			for (const [modelID, entry] of Object.entries(workerHealth)) {
				this.rememberModelServingKind(modelID, isObject(entry) ? entry.kind : undefined);
			}
		}

		this.rememberModelServingKind(
			typeof health.model_id === 'string' ? health.model_id : undefined,
			health.kind,
		);
	}

	private async refreshModelServingKinds() {
		try {
			const response = await fetch(this.getModelHealthUrl(), {
				method: 'GET',
				headers: {Accept: 'application/json'},
			});
			if (!response.ok) return;
			const health = await response.json();
			if (isObject(health)) {
				this.recordModelServingKindsFromHealth(health);
			}
		} catch {}
	}

	private resolveModelServingKind(modelID: string | undefined) {
		const lookupModelID = modelID || this.config.modelID;
		if (lookupModelID) {
			if (lookupModelID.startsWith('entity_')) return 'entity';
			const cached = this.modelServingKindById.get(lookupModelID);
			if (cached) return cached;
		}
		return 'unknown';
	}

	private pruneRequestLedger(now = Date.now()) {
		for (const [key, entry] of this.requestLedger) {
			if (entry.status === 'pending') continue;
			if (now - entry.updatedAt > REQUEST_LEDGER_TTL_MS) {
				this.requestLedger.delete(key);
			}
		}
		if (this.requestLedger.size <= MAX_REQUEST_LEDGER_ENTRIES) return;
		const terminalEntries = [...this.requestLedger.values()]
			.filter(entry => entry.status !== 'pending')
			.sort((a, b) => a.updatedAt - b.updatedAt);
		for (const entry of terminalEntries) {
			if (this.requestLedger.size <= MAX_REQUEST_LEDGER_ENTRIES) break;
			this.requestLedger.delete(entry.bridgeRequestId);
		}
	}

	private createBridgeEnvelope(
		entry: BridgeLedgerEntry,
		bridgeStatus: BridgeEnvelopeStatus,
		dedupeSource: BridgeDedupeSource,
		extraBody?: AnyObject,
	) {
		return {
			bridge_request_id: entry.bridgeRequestId,
			bridge_status: bridgeStatus,
			dedupe_source: dedupeSource,
			...extraBody,
		};
	}

	private writeLedgerResponse(response: http.ServerResponse, entry: BridgeLedgerEntry, dedupeSource: BridgeDedupeSource) {
		switch (entry.status) {
		case 'pending':
			writeJson(response, 202, this.createBridgeEnvelope(entry, 'pending', dedupeSource));
			return;
		case 'completed':
			writeJson(
				response,
				entry.responseStatusCode || 200,
				this.createBridgeEnvelope(entry, 'completed', dedupeSource, entry.responseBody)
			);
			return;
		case 'unknown':
			writeJson(response, 409, this.createBridgeEnvelope(entry, 'unknown_outcome', dedupeSource, {
				error: entry.error || 'Upstream model outcome is unknown.',
			}));
			return;
		case 'failed':
			writeJson(
				response,
				entry.responseStatusCode || 502,
				this.createBridgeEnvelope(entry, 'failed', dedupeSource, {
					error: entry.error || 'Bridge request failed.',
					...(entry.details?.length ? {details: entry.details} : {}),
				})
			);
			return;
		}
	}

	private updateLiveLedgerEntry(bridgeRequestId: string, mutator: (entry: BridgeLedgerEntry) => void) {
		const liveEntry = this.requestLedger.get(bridgeRequestId);
		if (!liveEntry) return null;
		mutator(liveEntry);
		liveEntry.updatedAt = Date.now();
		return liveEntry;
	}

	private async settleLedgerEntry(
		bridgeRequestId: string,
		payload: BrowserBridgeRequest,
		normalized: AnyObject,
		request: AnyObject | undefined,
	) {
		try {
			const proxied = await proxyToModelEndpoint(this.config.modelEndpoint, normalized, this.config.requestTimeoutMs);
			if (proxied.status < 200 || proxied.status >= 300) {
				this.updateLiveLedgerEntry(bridgeRequestId, entry => {
					entry.status = 'failed';
					entry.responseStatusCode = proxied.status;
					entry.error = `Upstream model endpoint returned ${proxied.status}.`;
					entry.details = truncateForLog(proxied.body) ? [truncateForLog(proxied.body)!] : undefined;
				});
				await this.appendDebugLog(formatBrowserBridgeDebugSnapshot(payload, normalized, {
					roomid: this.requestLedger.get(bridgeRequestId)?.roomid || getRoomId(payload, request),
					rqid: request?.rqid,
					route: '/predict',
					requestSummary: this.requestLedger.get(bridgeRequestId)?.requestSummary || {},
					upstreamStatus: proxied.status,
					upstreamBodySnippet: truncateForLog(proxied.body),
					error: `Upstream model endpoint returned ${proxied.status}.`,
				}));
				return;
			}
			let parsedBody: AnyObject;
			try {
				parsedBody = proxied.body ? JSON.parse(proxied.body) : {};
			} catch (error) {
				const settledError = error instanceof Error ? `Model response was not valid JSON: ${error.message}` : String(error);
				this.updateLiveLedgerEntry(bridgeRequestId, entry => {
					entry.status = 'failed';
					entry.responseStatusCode = 502;
					entry.error = settledError;
				});
				await this.appendDebugLog(formatBrowserBridgeDebugSnapshot(payload, normalized, {
					roomid: this.requestLedger.get(bridgeRequestId)?.roomid || getRoomId(payload, request),
					rqid: request?.rqid,
					route: '/predict',
					requestSummary: this.requestLedger.get(bridgeRequestId)?.requestSummary || {},
					upstreamStatus: proxied.status,
					upstreamBodySnippet: truncateForLog(proxied.body),
					error: settledError,
				}));
				return;
			}
			this.updateLiveLedgerEntry(bridgeRequestId, entry => {
				entry.status = 'completed';
				entry.responseStatusCode = 200;
				entry.responseBody = parsedBody;
			});
			if (shouldLogSuccessfulPredict(payload)) {
				const liveEntry = this.requestLedger.get(bridgeRequestId);
				await this.appendDebugLog(formatBrowserBridgeDebugSnapshot(payload, normalized, {
					roomid: liveEntry?.roomid || getRoomId(payload, request),
					rqid: request?.rqid,
					route: '/predict',
					requestSummary: {
						...(liveEntry?.requestSummary || {}),
						bridge_status: 'completed',
						dedupe_source: 'fresh',
					},
					upstreamStatus: proxied.status,
					upstreamBodySnippet: truncateForLog(proxied.body),
				}));
			}
		} catch (error) {
			const settledError = error instanceof Error ? error.message : String(error);
			this.updateLiveLedgerEntry(bridgeRequestId, entry => {
				entry.status = 'unknown';
				entry.responseStatusCode = 409;
				entry.error = settledError;
			});
			await this.appendDebugLog(formatBrowserBridgeDebugSnapshot(payload, normalized, {
				roomid: this.requestLedger.get(bridgeRequestId)?.roomid || getRoomId(payload, request),
				rqid: request?.rqid,
				route: '/predict',
				requestSummary: this.requestLedger.get(bridgeRequestId)?.requestSummary || {},
				error: settledError,
			}));
		} finally {
			const liveEntry = this.requestLedger.get(bridgeRequestId);
			if (liveEntry && liveEntry.promise) liveEntry.promise = undefined;
		}
	}

	private getAppliedUpdateLines(roomid: string, payload: BrowserBridgeRequest) {
		const session = this.getSession(roomid);
		const updateLines = normalizeUpdateLines(payload);
		const logSource = normalizeLogSource(payload);
		if (logSource && logSource !== session.lastAppliedLogSource) {
			session.lastAppliedLogLength = 0;
			session.lastAppliedLogSource = logSource;
		}
		if (!updateLines.length) return updateLines;

		const logLength = normalizeLogLength(payload);
		if (logLength === undefined) {
			if (logSource) session.lastAppliedLogSource = logSource;
			return updateLines;
		}

		if (logLength < session.lastAppliedLogLength) {
			session.lastAppliedLogLength = logLength;
			if (logSource) session.lastAppliedLogSource = logSource;
			return updateLines;
		}

		const unseenCount = Math.max(0, logLength - session.lastAppliedLogLength);
		session.lastAppliedLogLength = Math.max(session.lastAppliedLogLength, logLength);
		if (logSource) session.lastAppliedLogSource = logSource;
		if (!unseenCount) return [];
		if (unseenCount >= updateLines.length) return updateLines;
		return updateLines.slice(updateLines.length - unseenCount);
	}

	async handleRequest(route: BrowserBridgeRoute, payload: BrowserBridgeRequest, response: http.ServerResponse) {
		const request = extractRequest(payload);
		const roomid = getRoomId(payload, request);
		const bridgeRequestMeta = extractBridgeRequestMetadata(payload, roomid, request);
		const session = this.getSession(roomid);
		const appliedUpdateLines = this.getAppliedUpdateLines(roomid, payload);
		const requestedModelID = payload.model_id || payload.modelId || payload.modelID || this.config.modelID;
		const modelServingKind = this.resolveModelServingKind(requestedModelID);
		const normalized = normalizeBrowserModelRequest(payload, {
			defaultPerspectivePlayer: this.config.defaultPerspectivePlayer,
			modelID: requestedModelID,
			allowVoluntarySwitches: this.config.allowVoluntarySwitches,
			modelKind: modelServingKind,
		}, session.tracker, appliedUpdateLines);
		const requestSummary = summarizeBridgeRequest(payload, request, normalized, roomid, appliedUpdateLines);

		switch (route) {
		case '/health':
			writeJson(response, 200, {ok: true, service: 'browser-model-bridge'});
			return;
		case '/normalize':
			writeJson(response, 200, normalized);
			return;
		case '/debug': {
			try {
				const validationErrors = validateNormalizedPredictRequest(normalized, request);
				const entry = formatBrowserBridgeDebugSnapshot(payload, normalized, {
					roomid,
					rqid: request?.rqid,
					route,
					requestSummary,
					validationErrors,
				});
				await this.appendDebugLog(entry);
				writeJson(response, 200, {
					ok: true,
					logged: true,
					path: this.config.debugLogPath,
				});
			} catch (error) {
				writeJson(response, 500, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		case '/predict': {
			const validationErrors = validateNormalizedPredictRequest(normalized, request);
			if (validationErrors.length) {
				await this.appendDebugLog(formatBrowserBridgeDebugSnapshot(payload, normalized, {
					roomid,
					rqid: request?.rqid,
					route,
					requestSummary,
					validationErrors,
				}));
				writeJson(response, 400, {
					bridge_request_id: bridgeRequestMeta.bridgeRequestId,
					bridge_status: 'validation_error',
					dedupe_source: 'fresh',
					error: 'Browser bridge request validation failed.',
					details: validationErrors,
				});
				return;
			}
			this.pruneRequestLedger();
			let entry = this.requestLedger.get(bridgeRequestMeta.bridgeRequestId);
			if (entry) {
				const dedupeSource: BridgeDedupeSource = entry.status === 'pending' ? 'shared_pending' : 'cached';
				if (entry.status === 'completed' && shouldLogSuccessfulPredict(payload)) {
					await this.appendDebugLog(formatBrowserBridgeDebugSnapshot(payload, normalized, {
						roomid,
						rqid: request?.rqid,
						route,
						requestSummary: {
							...entry.requestSummary,
							bridge_status: 'completed',
							dedupe_source: dedupeSource,
						},
						upstreamStatus: entry.responseStatusCode || 200,
						upstreamBodySnippet: truncateForLog(JSON.stringify(entry.responseBody || {})),
					}));
				}
				this.writeLedgerResponse(response, entry, dedupeSource);
				return;
			}
			entry = {
				bridgeRequestId: bridgeRequestMeta.bridgeRequestId,
				roomid,
				requestIdentity: bridgeRequestMeta.requestIdentity,
				status: 'pending',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				requestSummary,
				normalizedSummary: {
					perspective_player: normalized.perspective_player,
					legal_moves: Array.isArray(normalized.legal_moves) ? normalized.legal_moves.length : 0,
					legal_switches: Array.isArray(normalized.legal_switches) ? normalized.legal_switches.length : 0,
					legal_revives: Array.isArray(normalized.legal_revives) ? normalized.legal_revives.length : 0,
				},
			};
			entry.promise = this.settleLedgerEntry(entry.bridgeRequestId, payload, normalized, request);
			this.requestLedger.set(entry.bridgeRequestId, entry);
			await entry.promise;
			const settledEntry = this.requestLedger.get(entry.bridgeRequestId) || entry;
			this.writeLedgerResponse(response, settledEntry, 'fresh');
			return;
		}
		default:
			writeJson(response, 404, {error: 'Not found'});
			return;
		}
	}

	async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
		const method = (request.method || 'GET').toUpperCase();
		const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
		const route = url.pathname as BrowserBridgeRoute;

		if (method === 'GET' && route === '/health') {
			writeJson(response, 200, {ok: true, service: 'browser-model-bridge'});
			return;
		}
		if (method !== 'POST') {
			writeJson(response, 405, {error: 'Use POST for model bridge requests.'});
			return;
		}

		let bodyText = '';
		try {
			bodyText = await readBody(request, 1_000_000);
		} catch (error) {
			writeJson(response, 413, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		let payload: BrowserBridgeRequest;
		try {
			payload = bodyText ? JSON.parse(bodyText) : {};
		} catch (error) {
			writeJson(response, 400, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		if (route !== '/normalize' && route !== '/predict' && route !== '/debug') {
			writeJson(response, 404, {error: 'Not found'});
			return;
		}

		await this.handleRequest(route, payload, response);
	}
}

function getDefaultDebugLogPath() {
	const repoRoot = path.basename(path.dirname(__dirname)) === 'dist' ?
		path.resolve(__dirname, '..', '..') :
		path.resolve(__dirname, '..');
	return path.join(repoRoot, 'logs', 'browser-model-bridge-debug.log');
}

function parseBridgeArgs(argv: string[]) {
	const args = [...argv];
	let host = process.env.PS_BROWSER_BRIDGE_HOST || '127.0.0.1';
	let port = Number(process.env.PS_BROWSER_BRIDGE_PORT || 5051);
	let modelEndpoint = process.env.PS_BROWSER_BRIDGE_MODEL_ENDPOINT || 'http://127.0.0.1:5000/predict';
	let modelID = process.env.PS_BROWSER_BRIDGE_MODEL_ID || '';
	let modelProfile = process.env.PS_BROWSER_BRIDGE_MODEL_PROFILE || '';
	let allowVoluntarySwitches = parseBooleanOption(process.env.PS_BROWSER_BRIDGE_ALLOW_VOLUNTARY_SWITCHES);
	let requestTimeoutMs = Number(process.env.PS_BROWSER_BRIDGE_TIMEOUT_MS || 15_000);
	let debugLogPath = process.env.PS_BROWSER_BRIDGE_DEBUG_LOG || getDefaultDebugLogPath();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === '--host' && next) {
			host = next;
			i++;
		} else if (arg === '--port' && next) {
			port = Number(next);
			i++;
		} else if (arg === '--model-endpoint' && next) {
			modelEndpoint = next;
			i++;
		} else if (arg === '--model-id' && next) {
			modelID = next;
			i++;
		} else if (arg === '--model-profile' && next) {
			modelProfile = next;
			i++;
		} else if (arg === '--allow-voluntary-switches') {
			if (next && !next.startsWith('--')) {
				const parsed = parseBooleanOption(next);
				if (parsed !== undefined) {
					allowVoluntarySwitches = parsed;
					i++;
				}
			} else {
				allowVoluntarySwitches = true;
			}
		} else if (arg === '--no-allow-voluntary-switches') {
			allowVoluntarySwitches = false;
		} else if (arg === '--timeout-ms' && next) {
			requestTimeoutMs = Number(next);
			i++;
		} else if ((arg === '--debug-log' || arg === '--debug-log-path') && next) {
			debugLogPath = next;
			i++;
		}
	}
	return {
		host,
		port,
		modelEndpoint,
		modelID: modelID || undefined,
		modelProfile: modelProfile || undefined,
		allowVoluntarySwitches: resolveAllowVoluntarySwitches(modelID || undefined, modelProfile || undefined, allowVoluntarySwitches),
		requestTimeoutMs,
		debugLogPath,
	};
}

function normalizeBridgeModelID(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function readConfiguredAllowVoluntarySwitches(modelID: string | undefined) {
	if (!modelID) return undefined;
	let loadedConfig;
	try {
		loadedConfig = global.Config || loadConfig();
	} catch (error) {
		console.warn(`[browser-model-bridge] Could not load config for model ID lookup: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const configEntries = Array.isArray(loadedConfig?.modelBattles) ? loadedConfig.modelBattles as AnyObject[] : [];
	const targetID = normalizeBridgeModelID(modelID);
	for (const entry of configEntries) {
		const candidateIDs = [entry.id, entry.modelID, entry.name]
			.map(value => typeof value === 'string' ? normalizeBridgeModelID(value) : '')
			.filter(Boolean);
		if (candidateIDs.includes(targetID) && typeof entry.allowVoluntarySwitches === 'boolean') {
			return entry.allowVoluntarySwitches;
		}
	}
	return undefined;
}

function resolveAllowVoluntarySwitches(
	modelID: string | undefined,
	modelProfile: string | undefined,
	explicitOverride: boolean | undefined,
) {
	if (explicitOverride !== undefined) return explicitOverride;
	if (modelProfile) {
		return resolveRLModelProfileConfig(modelProfile, explicitOverride).allowVoluntarySwitches;
	}
	return readConfiguredAllowVoluntarySwitches(modelID);
}

export async function runBrowserModelBridgeCLI(argv = process.argv.slice(2)) {
	const {host, port, modelEndpoint, modelID, modelProfile, allowVoluntarySwitches, requestTimeoutMs, debugLogPath} = parseBridgeArgs(argv);
	if (debugLogPath) {
		await fs.mkdir(path.dirname(debugLogPath), {recursive: true});
	}
	const server = new BrowserModelBridgeServer({
		host,
		port,
		modelEndpoint,
		modelID,
		modelProfile,
		allowVoluntarySwitches,
		defaultPerspectivePlayer: 'p2',
		requestTimeoutMs,
		debugLogPath,
	});
	const httpServer = http.createServer((request, response) => {
		void server.handleHttpRequest(request, response);
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(port, host, () => {
			httpServer.removeListener('error', reject);
			console.log(`Browser model bridge listening on http://${host}:${port}`);
			console.log(`Normalizing browser requests before forwarding to ${modelEndpoint}`);
			if (allowVoluntarySwitches !== undefined) {
				console.log(`Voluntary switches on move turns: ${allowVoluntarySwitches ? 'enabled' : 'disabled'}`);
			}
			if (modelProfile) {
				console.log(`Model profile: ${modelProfile}`);
			}
			if (debugLogPath) {
				console.log(`Writing debug snapshots to ${path.resolve(debugLogPath)}`);
			}
			console.log('Restart the bridge and refresh the userscript after editing either side of the workflow.');
			resolve();
		});
	});

	const stop = () => {
		void new Promise<void>(resolve => httpServer.close(() => resolve()));
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}

if (typeof require !== 'undefined' && require.main === module) {
	void runBrowserModelBridgeCLI().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
