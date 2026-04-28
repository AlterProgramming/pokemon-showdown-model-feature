/**
 * Human-vs-model league matchmaking.
 *
 * Parallel to the daemon's model-vs-model ratings. Reads the same league
 * config (active models, matchmakingWindow, initialElo) but persists
 * human-match ratings to a dedicated file so the daemon and the chat
 * server never write to the same state file.
 *
 * State file: databases/model-league/human-matches.json
 */

import { FS } from "../../lib";
import { applyRatingMatch, createRatingEntry } from "./ratings";
import { loadModelLeagueConfig, resolveModelLeagueConfigPath } from "./config";
import type {
	ModelLeagueConfig,
	ModelLeagueModelConfig,
	ModelLeagueRatingEntry,
} from "./types";

export const HUMAN_LOCAL_ID = "human:local";
export const HUMAN_LOCAL_NAME = "Human";

export interface HumanBattleReplayRecord {
	version: 1;
	timestamp: string;
	roomId: string;
	modelId: string | null;
	modelName: string;
	modelEndpoint: string | null;
	winner: "human" | "model" | "tie";
	humanDisplayName: string;
	turns: number | null;
	battleLog: string[];
}

export interface HumanMatchRecord {
	id: string;
	timestamp: string;
	roomId: string;
	modelId: string;
	modelName: string;
	modelEndpoint: string | null;
	winner: "human" | "model" | "tie";
	humanEloBefore: number;
	humanEloAfter: number;
	modelEloBefore: number;
	modelEloAfter: number;
	humanDisplayName: string;
	turns: number | null;
}

export interface HumanLeagueState {
	version: 1;
	updatedAt: string | null;
	humanRating: ModelLeagueRatingEntry;
	modelRatings: ModelLeagueRatingEntry[];
	matches: HumanMatchRecord[];
}

export function getHumanLeagueStatePath(config: ModelLeagueConfig): string {
	return `${config.stateRoot}/human-matches.json`;
}

export function loadHumanLeagueState(config: ModelLeagueConfig): HumanLeagueState {
	const raw = FS(getHumanLeagueStatePath(config)).readIfExistsSync();
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as HumanLeagueState;
			if (parsed.version === 1 && parsed.humanRating && Array.isArray(parsed.modelRatings)) {
				if (!Array.isArray(parsed.matches)) parsed.matches = [];
				return parsed;
			}
		} catch {}
	}
	return {
		version: 1,
		updatedAt: null,
		humanRating: createRatingEntry(HUMAN_LOCAL_ID, HUMAN_LOCAL_NAME, config.ratings.initialElo),
		modelRatings: [],
		matches: [],
	};
}

export function saveHumanLeagueState(config: ModelLeagueConfig, state: HumanLeagueState): void {
	state.updatedAt = new Date().toISOString();
	const path = getHumanLeagueStatePath(config);
	FS(path).parentDir().mkdirpSync();
	// FS(...).writeUpdate uses atomic-rename semantics via a tmp file.
	FS(path).writeUpdate(() => JSON.stringify(state, null, 2));
}

export function getOrCreateModelEntry(
	state: HumanLeagueState,
	modelId: string,
	modelName: string,
	initialElo: number,
): ModelLeagueRatingEntry {
	let entry = state.modelRatings.find(e => e.id === modelId);
	if (!entry) {
		entry = createRatingEntry(modelId, modelName, initialElo);
		state.modelRatings.push(entry);
	}
	return entry;
}

export interface HumanLeagueContext {
	config: ModelLeagueConfig;
	configPath: string;
	state: HumanLeagueState;
}

function loadDaemonModelRatings(config: ModelLeagueConfig): Map<string, number> {
	const raw = FS(`${config.stateRoot}/state.json`).readIfExistsSync();
	if (!raw) return new Map();
	try {
		const parsed = JSON.parse(raw);
		const ratings: Array<{ id?: string; elo?: number }> = parsed?.modelRatings || [];
		return new Map(
			ratings
				.filter(r => typeof r?.id === "string" && typeof r?.elo === "number")
				.map(r => [r.id as string, r.elo as number]),
		);
	} catch {
		return new Map();
	}
}

export function loadHumanLeagueContext(): HumanLeagueContext {
	const configPath = resolveModelLeagueConfigPath(null, { preferActive: true });
	const config = loadModelLeagueConfig(configPath);
	const state = loadHumanLeagueState(config);
	// Seed ratings for models that haven't played a human yet using the daemon's
	// model-vs-model ELO as a more informed prior than flat initialElo. Entries
	// with prior human matches are left untouched — their rating reflects human
	// games, not daemon games. The seed is in-memory; it persists on first
	// recorded match via saveHumanLeagueState.
	const daemonRatings = loadDaemonModelRatings(config);
	for (const model of config.models) {
		if (model.archived) continue;
		if (state.modelRatings.find(e => e.id === model.id)) continue;
		const seedElo = daemonRatings.get(model.id) ?? config.ratings.initialElo;
		state.modelRatings.push(createRatingEntry(model.id, model.name, seedElo));
	}
	return { config, configPath, state };
}

/**
 * Probe a model endpoint with a short timeout. Returns true if the endpoint
 * answers any HTTP response at all within the timeout — we treat any reply
 * as proof-of-life (actual request routing is handled by room-battle).
 */
export async function probeModelEndpoint(endpoint: string, timeoutMs = 2000): Promise<boolean> {
	try {
		const healthUrl = endpoint.replace(/\/predict\/?$/, "/health");
		const probeUrl = healthUrl === endpoint ? endpoint : healthUrl;
		const res = await fetch(probeUrl, {
			method: "GET",
			signal: AbortSignal.timeout(timeoutMs),
		});
		// Any HTTP answer means the server is alive.
		return res.status < 500;
	} catch {
		return false;
	}
}

function weightedPick<T extends { sampleWeight?: number }>(items: T[]): T | null {
	if (!items.length) return null;
	const weights = items.map(item => Math.max(0, item.sampleWeight ?? 1));
	const total = weights.reduce((acc, w) => acc + w, 0);
	if (total <= 0) return items[Math.floor(Math.random() * items.length)];
	let roll = Math.random() * total;
	for (let i = 0; i < items.length; i++) {
		roll -= weights[i];
		if (roll <= 0) return items[i];
	}
	return items[items.length - 1];
}

/**
 * Pick a model opponent within an ELO window of the human player.
 * Expands the window in multiples until at least one candidate fits or we
 * exhaust all active models (in which case a weighted pick from all of them
 * is returned — ratings still track divergence from band).
 *
 * Runs probes in parallel and filters out unreachable endpoints before
 * the band search.
 */
export async function pickHumanOpponent(
	humanElo: number,
	config: ModelLeagueConfig,
	state: HumanLeagueState,
): Promise<ModelLeagueModelConfig | null> {
	const active = config.models.filter(m => m.active && !m.archived);
	if (!active.length) return null;

	const probeResults = await Promise.all(
		active.map(async m => ({ model: m, alive: await probeModelEndpoint(m.endpoint) })),
	);
	const alive = probeResults.filter(r => r.alive).map(r => r.model);
	if (!alive.length) return null;

	const initialElo = config.ratings.initialElo;
	const window = config.scheduler.matchmakingWindow || 125;
	const modelElo = (id: string, fallbackName: string) =>
		state.modelRatings.find(e => e.id === id)?.elo ??
		getOrCreateModelEntry(state, id, fallbackName, initialElo).elo;

	// Expand band up to ~8x the window before giving up.
	for (let expand = 1; expand <= 8; expand++) {
		const radius = window * expand;
		const band = alive.filter(m => Math.abs(modelElo(m.id, m.name) - humanElo) <= radius);
		if (band.length) return weightedPick(band);
	}
	return weightedPick(alive);
}

/**
 * Apply a match result to the human-league state and persist. Returns the
 * record that was appended (for UI echo / logging).
 */
export function recordHumanMatch(options: {
	context: HumanLeagueContext;
	roomId: string;
	modelId: string;
	modelName: string;
	modelEndpoint: string | null;
	winner: "human" | "model" | "tie";
	humanDisplayName: string;
	turns: number | null;
}): HumanMatchRecord {
	const { context, roomId, modelId, modelName, modelEndpoint, winner, humanDisplayName, turns } = options;
	const { config, state } = context;
	const initialElo = config.ratings.initialElo;
	const modelEntry = getOrCreateModelEntry(state, modelId, modelName, initialElo);
	const humanEloBefore = state.humanRating.elo;
	const modelEloBefore = modelEntry.elo;
	const scoreA: 1 | 0.5 | 0 = winner === "human" ? 1 : winner === "tie" ? 0.5 : 0;

	applyRatingMatch({
		entries: [state.humanRating, modelEntry, ...state.modelRatings.filter(e => e.id !== modelId)],
		idA: HUMAN_LOCAL_ID,
		nameA: HUMAN_LOCAL_NAME,
		idB: modelId,
		nameB: modelName,
		scoreA,
		now: new Date().toISOString(),
		config,
	});
	// applyRatingMatch mutates entries in-place, so state.humanRating and
	// modelEntry are already updated. Re-find model entry to read the new
	// ELO (it's the same reference, but explicit for clarity).
	const record: HumanMatchRecord = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: new Date().toISOString(),
		roomId,
		modelId,
		modelName,
		modelEndpoint,
		winner,
		humanEloBefore,
		humanEloAfter: state.humanRating.elo,
		modelEloBefore,
		modelEloAfter: modelEntry.elo,
		humanDisplayName,
		turns,
	};
	state.matches.push(record);
	// Cap match history to the last 500 entries to keep the file bounded.
	if (state.matches.length > 500) state.matches.splice(0, state.matches.length - 500);
	saveHumanLeagueState(config, state);
	return record;
}

/**
 * Persist a full battle log alongside the rating record. Writes one file
 * per battle under logRoot/human-matches/YYYY-MM-DD/{roomId}.json.
 */
export function saveHumanMatchReplay(options: {
	config: ModelLeagueConfig;
	roomId: string;
	record: HumanMatchRecord;
	battleLog: string[];
}): string {
	const { config, roomId, record, battleLog } = options;
	const day = new Date().toISOString().slice(0, 10);
	const dir = `${config.logRoot}/human-matches/${day}`;
	const safeRoomId = roomId.replace(/[^a-z0-9_-]/gi, "_");
	const safeFilePath = `${dir}/${safeRoomId}.json`;
	const payload = {
		version: 1,
		...record,
		battleLog,
	};
	FS(safeFilePath).parentDir().mkdirpSync();
	FS(safeFilePath).writeUpdate(() => JSON.stringify(payload, null, 2));
	return safeFilePath;
}

/**
 * Persist every human-vs-model battle log, including non-league model battles.
 * Writes one file per battle under logRoot/human-battles/YYYY-MM-DD/{roomId}.json.
 */
export function saveHumanBattleReplay(options: {
	config: ModelLeagueConfig;
	roomId: string;
	modelId: string | null;
	modelName: string;
	modelEndpoint: string | null;
	winner: "human" | "model" | "tie";
	humanDisplayName: string;
	turns: number | null;
	battleLog: string[];
}): string {
	const day = new Date().toISOString().slice(0, 10);
	const dir = `${options.config.logRoot}/human-battles/${day}`;
	const safeRoomId = options.roomId.replace(/[^a-z0-9_-]/gi, "_");
	const safeFilePath = `${dir}/${safeRoomId}.json`;
	const payload: HumanBattleReplayRecord = {
		version: 1,
		timestamp: new Date().toISOString(),
		roomId: options.roomId,
		modelId: options.modelId,
		modelName: options.modelName,
		modelEndpoint: options.modelEndpoint,
		winner: options.winner,
		humanDisplayName: options.humanDisplayName,
		turns: options.turns,
		battleLog: options.battleLog,
	};
	FS(safeFilePath).parentDir().mkdirpSync();
	FS(safeFilePath).writeUpdate(() => JSON.stringify(payload, null, 2));
	return safeFilePath;
}
