import { FS } from "../../lib";
import { parseReplayCaptureMode } from "../../sim/tools/replay-export";
import { normalizeRLModelProfile, parseBooleanOption } from "../../sim/tools/rl-model-profiles";
import type {
	ModelLeagueBenchmarkConfig,
	ModelLeagueConfig,
	ModelLeagueModelConfig,
	ModelLeagueReplayConfig,
	ModelLeagueSchedulerConfig,
	ModelLeagueTeamConfig,
	ModelLeagueTrainingConfig,
	ModelLeagueWebhookConfig,
} from "./types";

const DEFAULT_CONFIG_PATH = "config/model-league.json";
const ACTIVE_CONFIG_POINTER_PATH = "databases/model-league/active-config.json";

function readJson(path: string): AnyObject {
	const raw = FS(path).readIfExistsSync();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch (error: any) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${path}: ${errorMessage}`);
	}
}

function toPositiveInteger(value: any, fallback: number, field: string) {
	const parsed = Number(value ?? fallback);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${field} must be a positive integer.`);
	}
	return parsed;
}

function toPositiveNumber(value: any, fallback: number, field: string) {
	const parsed = Number(value ?? fallback);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${field} must be a positive number.`);
	}
	return parsed;
}

function toNonNegativeInteger(value: any, fallback: number, field: string) {
	const parsed = Number(value ?? fallback);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${field} must be a non-negative integer.`);
	}
	return parsed;
}

function toBoolean(value: any, fallback: boolean) {
	if (typeof value === "boolean") return value;
	const parsed = parseBooleanOption(value !== undefined ? String(value) : undefined);
	return parsed ?? fallback;
}

function normalizeScheduler(raw: AnyObject): ModelLeagueSchedulerConfig {
	const liveWeight = toPositiveNumber(raw.liveMatchmakingWeight, 60, "scheduler.liveMatchmakingWeight");
	const archivedWeight = toPositiveNumber(raw.archivedMatchmakingWeight, 20, "scheduler.archivedMatchmakingWeight");
	const explorationWeight = toPositiveNumber(raw.explorationWeight, 20, "scheduler.explorationWeight");
	const totalWeight = liveWeight + archivedWeight + explorationWeight;
	if (!totalWeight) {
		throw new Error(`scheduler weights must add up to more than zero.`);
	}
	return {
		loopIntervalMs: toPositiveInteger(raw.loopIntervalMs, 5_000, "scheduler.loopIntervalMs"),
		benchmarkIntervalMs: toPositiveInteger(raw.benchmarkIntervalMs, 60 * 60 * 1000, "scheduler.benchmarkIntervalMs"),
		maxConcurrentTasks: toPositiveInteger(raw.maxConcurrentTasks, 1, "scheduler.maxConcurrentTasks"),
		liveMatchmakingWeight: liveWeight / totalWeight,
		archivedMatchmakingWeight: archivedWeight / totalWeight,
		explorationWeight: explorationWeight / totalWeight,
		liveRollouts: toPositiveInteger(raw.liveRollouts, 6, "scheduler.liveRollouts"),
		historicalRollouts: toPositiveInteger(raw.historicalRollouts, 4, "scheduler.historicalRollouts"),
		benchmarkRolloutsDefault: toPositiveInteger(raw.benchmarkRolloutsDefault, 10, "scheduler.benchmarkRolloutsDefault"),
		sideSwap: toBoolean(raw.sideSwap, true),
		matchmakingWindow: toPositiveNumber(raw.matchmakingWindow, 125, "scheduler.matchmakingWindow"),
		recentMatchLimit: toPositiveInteger(raw.recentMatchLimit, 30, "scheduler.recentMatchLimit"),
	};
}

function normalizeReplay(raw: AnyObject): ModelLeagueReplayConfig {
	return {
		captureMode: parseReplayCaptureMode(raw.captureMode),
		captureCount: toNonNegativeInteger(raw.captureCount, 8, "replay.captureCount"),
		outputDir: typeof raw.outputDir === "string" && raw.outputDir.trim() ? raw.outputDir : "logs/model-league/replays",
		grid: toBoolean(raw.grid, false),
		gridRefreshSeconds: toPositiveInteger(raw.gridRefreshSeconds, 2, "replay.gridRefreshSeconds"),
	};
}

function normalizeTraining(raw: AnyObject): ModelLeagueTrainingConfig {
	return {
		enabled: toBoolean(raw.enabled, true),
		minMatches: toPositiveInteger(raw.minMatches, 10, "training.minMatches"),
		minExamples: toPositiveInteger(raw.minExamples, 100, "training.minExamples"),
		cooldownMs: toPositiveInteger(raw.cooldownMs, 6 * 60 * 60 * 1000, "training.cooldownMs"),
		examplesDir: typeof raw.examplesDir === "string" && raw.examplesDir.trim() ?
			raw.examplesDir : "training/examples",
		bundleDir: typeof raw.bundleDir === "string" && raw.bundleDir.trim() ?
			raw.bundleDir : "training/bundles",
		pendingJobDir: typeof raw.pendingJobDir === "string" && raw.pendingJobDir.trim() ?
			raw.pendingJobDir : "training/pending",
		completedJobDir: typeof raw.completedJobDir === "string" && raw.completedJobDir.trim() ?
			raw.completedJobDir : "training/completed",
	};
}

function normalizeWebhooks(raw: AnyObject): ModelLeagueWebhookConfig {
	const outbound = raw.outboundTrainingRequested && typeof raw.outboundTrainingRequested.url === "string" ?
		{
			url: raw.outboundTrainingRequested.url,
			headers: raw.outboundTrainingRequested.headers || undefined,
			secret: raw.outboundTrainingRequested.secret || undefined,
			timeoutMs: raw.outboundTrainingRequested.timeoutMs ? toPositiveInteger(
				raw.outboundTrainingRequested.timeoutMs,
				10_000,
				"webhooks.outboundTrainingRequested.timeoutMs"
			) : undefined,
		} : null;
	const inbound = raw.inboundTrainingCompleted && typeof raw.inboundTrainingCompleted.path === "string" ?
		{
			host: raw.inboundTrainingCompleted.host || "127.0.0.1",
			port: toPositiveInteger(raw.inboundTrainingCompleted.port, 3410, "webhooks.inboundTrainingCompleted.port"),
			path: raw.inboundTrainingCompleted.path,
			secret: raw.inboundTrainingCompleted.secret || undefined,
		} : null;
	return {
		outboundTrainingRequested: outbound,
		inboundTrainingCompleted: inbound,
	};
}

function normalizeTeams(rawTeams: AnyObject[]): ModelLeagueTeamConfig[] {
	const teams = rawTeams.map((raw, index) => {
		if (!raw || typeof raw !== "object") {
			throw new Error(`teams[${index}] must be an object.`);
		}
		const id = String(raw.id || "").trim();
		if (!id) throw new Error(`teams[${index}].id is required.`);
		const isRandom = toBoolean(raw.random, false);
		const packedTeam = String(raw.packedTeam || "").trim();
		if (!isRandom && !packedTeam) throw new Error(`teams[${index}].packedTeam is required.`);
		return {
			id,
			name: String(raw.name || id),
			packedTeam,
			random: isRandom,
			active: toBoolean(raw.active, true),
			archived: toBoolean(raw.archived, false),
			sampleWeight: toPositiveNumber(raw.sampleWeight, 1, `teams[${index}].sampleWeight`),
			metadata: raw.metadata || undefined,
		};
	});
	const ids = new Set<string>();
	for (const team of teams) {
		if (ids.has(team.id)) throw new Error(`Duplicate team id '${team.id}'.`);
		ids.add(team.id);
	}
	return teams;
}

function normalizeModels(rawModels: AnyObject[], teams: ModelLeagueTeamConfig[]): ModelLeagueModelConfig[] {
	const teamIds = new Set(teams.map(team => team.id));
	const models = rawModels.map((raw, index) => {
		if (!raw || typeof raw !== "object") {
			throw new Error(`models[${index}] must be an object.`);
		}
		const profile = normalizeRLModelProfile(raw.modelProfile);
		if (!profile) throw new Error(`models[${index}].modelProfile is invalid.`);
		const id = String(raw.id || "").trim();
		if (!id) throw new Error(`models[${index}].id is required.`);
		const modelID = String(raw.modelID || "").trim();
		if (!modelID) throw new Error(`models[${index}].modelID is required.`);
		const endpoint = String(raw.endpoint || "").trim();
		if (!endpoint) throw new Error(`models[${index}].endpoint is required.`);
		const allowedTeamIds = Array.isArray(raw.allowedTeamIds) ? raw.allowedTeamIds.map(String) : undefined;
		if (allowedTeamIds) {
			for (const teamId of allowedTeamIds) {
				if (!teamIds.has(teamId)) {
					throw new Error(`models[${index}].allowedTeamIds references missing team '${teamId}'.`);
				}
			}
		}
		return {
			id,
			name: String(raw.name || id),
			modelID,
			endpoint,
			modelProfile: profile,
			allowVoluntarySwitches: toBoolean(raw.allowVoluntarySwitches, profile !== "move-only"),
			active: toBoolean(raw.active, true),
			archived: toBoolean(raw.archived, false),
			parentCheckpointId: raw.parentCheckpointId ? String(raw.parentCheckpointId) : null,
			lineageId: raw.lineageId ? String(raw.lineageId) : id,
			sampleWeight: toPositiveNumber(raw.sampleWeight, 1, `models[${index}].sampleWeight`),
			allowedTeamIds,
			metadata: raw.metadata || undefined,
		};
	});
	const ids = new Set<string>();
	for (const model of models) {
		if (ids.has(model.id)) throw new Error(`Duplicate model id '${model.id}'.`);
		ids.add(model.id);
	}
	for (const model of models) {
		if (model.parentCheckpointId && !ids.has(model.parentCheckpointId)) {
			throw new Error(`Model '${model.id}' references missing parentCheckpointId '${model.parentCheckpointId}'.`);
		}
	}
	return models;
}

function normalizeBenchmarks(
	rawBenchmarks: AnyObject[],
	models: ModelLeagueModelConfig[],
	teams: ModelLeagueTeamConfig[],
): ModelLeagueBenchmarkConfig[] {
	const modelIds = new Set(models.map(model => model.id));
	const teamIds = new Set(teams.map(team => team.id));
	const seenIds = new Set<string>();
	const seenLevels = new Set<number>();
	return rawBenchmarks.map((raw, index) => {
		if (!raw || typeof raw !== "object") {
			throw new Error(`benchmarks[${index}] must be an object.`);
		}
		const id = String(raw.id || "").trim();
		if (!id) throw new Error(`benchmarks[${index}].id is required.`);
		if (seenIds.has(id)) throw new Error(`Duplicate benchmark id '${id}'.`);
		seenIds.add(id);
		const level = toPositiveInteger(raw.level, index + 1, `benchmarks[${index}].level`);
		if (seenLevels.has(level)) throw new Error(`Duplicate benchmark level '${level}'.`);
		seenLevels.add(level);
		const opponentModelId = String(raw.opponentModelId || "").trim();
		const opponentTeamId = String(raw.opponentTeamId || "").trim();
		if (!modelIds.has(opponentModelId)) {
			throw new Error(`benchmarks[${index}] references missing opponentModelId '${opponentModelId}'.`);
		}
		if (!teamIds.has(opponentTeamId)) {
			throw new Error(`benchmarks[${index}] references missing opponentTeamId '${opponentTeamId}'.`);
		}
		return {
			id,
			name: String(raw.name || id),
			level,
			opponentModelId,
			opponentTeamId,
			requiredWinRate: raw.requiredWinRate === undefined ? 0.6 :
			toPositiveNumber(raw.requiredWinRate, 0.6, `benchmarks[${index}].requiredWinRate`),
			rollouts: raw.rollouts === undefined ? undefined :
			toPositiveInteger(raw.rollouts, 1, `benchmarks[${index}].rollouts`),
			description: raw.description ? String(raw.description) : undefined,
		};
	}).sort((a, b) => a.level - b.level);
}

export function loadModelLeagueConfig(configPath = DEFAULT_CONFIG_PATH): ModelLeagueConfig {
	const raw = readJson(configPath);
	const format = typeof raw.format === "string" && raw.format.trim() ? raw.format : "gen9customgame@@@!Team Preview";
	const teams = normalizeTeams(Array.isArray(raw.teams) ? raw.teams : []);
	const models = normalizeModels(Array.isArray(raw.models) ? raw.models : [], teams);
	const benchmarks = normalizeBenchmarks(Array.isArray(raw.benchmarks) ? raw.benchmarks : [], models, teams);
	const config: ModelLeagueConfig = {
		version: 1,
		format,
		stateRoot: typeof raw.stateRoot === "string" && raw.stateRoot.trim() ? raw.stateRoot : "databases/model-league",
		logRoot: typeof raw.logRoot === "string" && raw.logRoot.trim() ? raw.logRoot : "logs/model-league",
		models,
		teams,
		benchmarks,
		scheduler: normalizeScheduler(raw.scheduler || {}),
		ratings: {
			initialElo: toPositiveInteger(raw.ratings?.initialElo, 1000, "ratings.initialElo"),
			minElo: toPositiveInteger(raw.ratings?.minElo, 1000, "ratings.minElo"),
		},
		replay: normalizeReplay(raw.replay || {}),
		training: normalizeTraining(raw.training || {}),
		webhooks: normalizeWebhooks(raw.webhooks || {}),
	};
	for (const benchmark of config.benchmarks) {
		const requiredWinRate = benchmark.requiredWinRate ?? 0.6;
		if (requiredWinRate <= 0 || requiredWinRate > 1) {
			throw new Error(`Benchmark '${benchmark.id}' requiredWinRate must be between 0 and 1.`);
		}
	}
	return config;
}

export function getDefaultModelLeagueConfigPath() {
	return DEFAULT_CONFIG_PATH;
}

export function getActiveModelLeagueConfigPointerPath() {
	return ACTIVE_CONFIG_POINTER_PATH;
}

export function readActiveModelLeagueConfigPath() {
	const raw = FS(ACTIVE_CONFIG_POINTER_PATH).readIfExistsSync();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { configPath?: string };
		const configPath = typeof parsed.configPath === "string" ? parsed.configPath.trim() : "";
		if (!configPath || !FS(configPath).existsSync()) return null;
		return configPath;
	} catch {
		return null;
	}
}

export function resolveModelLeagueConfigPath(configPath?: string | null, options: { preferActive?: boolean } = {}) {
	if (configPath) return configPath;
	if (options.preferActive) return readActiveModelLeagueConfigPath() || DEFAULT_CONFIG_PATH;
	return DEFAULT_CONFIG_PATH;
}

export async function writeActiveModelLeagueConfigPath(configPath: string) {
	await FS(ACTIVE_CONFIG_POINTER_PATH).safeWrite(JSON.stringify({
		configPath,
		updatedAt: new Date().toISOString(),
		pid: process.pid,
	}, null, 2));
}
