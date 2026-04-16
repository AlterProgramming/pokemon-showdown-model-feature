import {FS} from "../../lib";
import type {
	ModelLeagueBenchmarkProgress,
	ModelLeagueConfig,
	ModelLeagueControlRequest,
	ModelLeagueDaemonState,
	ModelLeagueCheckpointState,
	ModelLeagueState,
	ModelLeagueTeamState,
	ModelLeagueTrainingCompletionPayload,
	ModelLeagueTrainingJob,
} from "./types";
import {ensureRatingEntries, sortRatings} from "./ratings";

const STATE_FILE_NAME = "state.json";
const EVENTS_FILE_NAME = "events.jsonl";
const CONTROL_QUEUE_DIR = "control-requests";
const CONTROL_ARCHIVE_DIR = "control-requests-archive";

function now() {
	return new Date().toISOString();
}

function joinPath(...parts: string[]) {
	return parts.filter(Boolean).join("/").replace(/\\/g, "/");
}

function readJson<T>(path: string): T | null {
	const raw = FS(path).readIfExistsSync();
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch (error: any) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${path}: ${errorMessage}`);
	}
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function defaultDaemonState(config: ModelLeagueConfig): ModelLeagueDaemonState {
	return {
		status: "idle",
		pid: null,
		startedAt: null,
		heartbeatAt: null,
		lastLoopAt: null,
		loopCount: 0,
		activeTask: null,
		lastError: null,
		webhook: {
			enabled: !!config.webhooks.inboundTrainingCompleted,
			listening: false,
			host: config.webhooks.inboundTrainingCompleted?.host || null,
			port: config.webhooks.inboundTrainingCompleted?.port || null,
			path: config.webhooks.inboundTrainingCompleted?.path || null,
			lastReceivedAt: null,
			lastError: null,
		},
	};
}

function createCheckpointState(config: ModelLeagueConfig, model: ModelLeagueConfig["models"][number]) {
	return {
		id: model.id,
		name: model.name,
		modelID: model.modelID,
		endpoint: model.endpoint,
		modelProfile: model.modelProfile,
		allowVoluntarySwitches: !!model.allowVoluntarySwitches,
		active: model.active !== false,
		archived: !!model.archived,
		lineageId: model.lineageId || model.id,
		parentCheckpointId: model.parentCheckpointId || null,
		sampleWeight: model.sampleWeight || 1,
		allowedTeamIds: model.allowedTeamIds ? [...model.allowedTeamIds] : null,
		createdAt: now(),
		lastTrainingJobAt: null,
		matchCount: 0,
		liveMatchCount: 0,
		historicalMatchCount: 0,
		benchmarkMatchCount: 0,
		exampleCount: 0,
		trainingBuffer: {
			matchCount: 0,
			exampleCount: 0,
			exampleFiles: [],
			matchIds: [],
			lastBundleCreatedAt: null,
		},
		metadata: model.metadata || null,
	};
}

function createTeamState(team: ModelLeagueConfig["teams"][number]): ModelLeagueTeamState {
	return {
		id: team.id,
		name: team.name,
		packedTeam: team.packedTeam,
		active: team.active !== false,
		archived: !!team.archived,
		sampleWeight: team.sampleWeight || 1,
		createdAt: now(),
		matchCount: 0,
		liveMatchCount: 0,
		historicalMatchCount: 0,
		benchmarkMatchCount: 0,
		metadata: team.metadata || null,
	};
}

function createBenchmarkProgress(config: ModelLeagueConfig): ModelLeagueBenchmarkProgress[] {
	return config.benchmarks.map(benchmark => ({
		id: benchmark.id,
		name: benchmark.name,
		level: benchmark.level,
		requiredWinRate: benchmark.requiredWinRate ?? 0.6,
		lastRunAt: null,
		lastChallengerModelId: null,
		lastChallengerTeamId: null,
		lastWinRate: null,
		lastConfidenceLow: null,
		lastConfidenceHigh: null,
		cleared: false,
		clearedAt: null,
	}));
}

export function createInitialModelLeagueState(config: ModelLeagueConfig, configPath: string): ModelLeagueState {
	const state: ModelLeagueState = {
		version: 1,
		updatedAt: null,
		configPath,
		daemon: defaultDaemonState(config),
		checkpoints: config.models.map(model => createCheckpointState(config, model)),
		teams: config.teams.map(team => createTeamState(team)),
		modelRatings: [],
		teamRatings: [],
		recentMatches: [],
		recentBenchmarkRuns: [],
		benchmarkProgress: createBenchmarkProgress(config),
		trainingJobs: [],
		processedControlRequestIds: [],
		processedCompletedJobIds: [],
		stats: {
			liveMatches: 0,
			historicalMatches: 0,
			benchmarkRuns: 0,
			trainingBundles: 0,
			decisionExamplesCaptured: 0,
		},
	};
	ensureRatingEntries(state, config);
	sortRatings(state.modelRatings);
	sortRatings(state.teamRatings);
	return state;
}

export function hydrateModelLeagueState(state: ModelLeagueState, config: ModelLeagueConfig, configPath: string) {
	state.configPath = configPath;
	for (const model of config.models) {
		let checkpoint = state.checkpoints.find(candidate => candidate.id === model.id);
		if (!checkpoint) {
			checkpoint = createCheckpointState(config, model);
			state.checkpoints.push(checkpoint);
		}
		checkpoint.name = model.name;
		checkpoint.modelID = model.modelID;
		checkpoint.endpoint = model.endpoint;
		checkpoint.modelProfile = model.modelProfile;
		checkpoint.allowVoluntarySwitches = !!model.allowVoluntarySwitches;
		checkpoint.active = model.active !== false;
		checkpoint.archived = !!model.archived;
		checkpoint.lineageId = model.lineageId || checkpoint.lineageId || model.id;
		checkpoint.parentCheckpointId = model.parentCheckpointId || checkpoint.parentCheckpointId || null;
		checkpoint.sampleWeight = model.sampleWeight || checkpoint.sampleWeight || 1;
		checkpoint.allowedTeamIds = model.allowedTeamIds ? [...model.allowedTeamIds] : null;
		checkpoint.metadata = model.metadata || checkpoint.metadata || null;
	}
	for (const team of config.teams) {
		let stateTeam = state.teams.find(candidate => candidate.id === team.id);
		if (!stateTeam) {
			stateTeam = createTeamState(team);
			state.teams.push(stateTeam);
		}
		stateTeam.name = team.name;
		stateTeam.packedTeam = team.packedTeam;
		stateTeam.active = team.active !== false;
		stateTeam.archived = !!team.archived;
		stateTeam.sampleWeight = team.sampleWeight || stateTeam.sampleWeight || 1;
		stateTeam.metadata = team.metadata || stateTeam.metadata || null;
	}
	for (const benchmark of config.benchmarks) {
		if (!state.benchmarkProgress.some(candidate => candidate.id === benchmark.id)) {
			state.benchmarkProgress.push({
				id: benchmark.id,
				name: benchmark.name,
				level: benchmark.level,
				requiredWinRate: benchmark.requiredWinRate ?? 0.6,
				lastRunAt: null,
				lastChallengerModelId: null,
				lastChallengerTeamId: null,
				lastWinRate: null,
				lastConfidenceLow: null,
				lastConfidenceHigh: null,
				cleared: false,
				clearedAt: null,
			});
		}
	}
	state.benchmarkProgress.sort((a, b) => a.level - b.level);
	ensureRatingEntries(state, config);
	sortRatings(state.modelRatings);
	sortRatings(state.teamRatings);
}

export async function ensureModelLeagueDirectories(config: ModelLeagueConfig) {
	await FS(config.stateRoot).mkdirp();
	await FS(joinPath(config.stateRoot, CONTROL_QUEUE_DIR)).mkdirp();
	await FS(joinPath(config.stateRoot, CONTROL_ARCHIVE_DIR)).mkdirp();
	await FS(joinPath(config.stateRoot, config.training.examplesDir)).mkdirp();
	await FS(joinPath(config.stateRoot, config.training.bundleDir)).mkdirp();
	await FS(joinPath(config.stateRoot, config.training.pendingJobDir)).mkdirp();
	await FS(joinPath(config.stateRoot, config.training.completedJobDir)).mkdirp();
	await FS(config.logRoot).mkdirp();
}

export function getModelLeagueStatePath(config: ModelLeagueConfig) {
	return joinPath(config.stateRoot, STATE_FILE_NAME);
}

export function getModelLeagueEventsPath(config: ModelLeagueConfig) {
	return joinPath(config.logRoot, EVENTS_FILE_NAME);
}

export function getModelLeagueControlQueuePath(config: ModelLeagueConfig) {
	return joinPath(config.stateRoot, CONTROL_QUEUE_DIR);
}

export function getModelLeagueControlArchivePath(config: ModelLeagueConfig) {
	return joinPath(config.stateRoot, CONTROL_ARCHIVE_DIR);
}

export function getModelLeagueTrainingDir(config: ModelLeagueConfig, relativePath: string) {
	return joinPath(config.stateRoot, relativePath);
}

export function loadModelLeagueState(config: ModelLeagueConfig, configPath: string) {
	const existing = readJson<ModelLeagueState>(getModelLeagueStatePath(config));
	if (!existing) return createInitialModelLeagueState(config, configPath);
	hydrateModelLeagueState(existing, config, configPath);
	return existing;
}

export function saveModelLeagueState(config: ModelLeagueConfig, state: ModelLeagueState) {
	state.updatedAt = now();
	FS(getModelLeagueStatePath(config)).writeUpdate(() => JSON.stringify(state, null, 2));
}

export async function appendModelLeagueEvent(config: ModelLeagueConfig, event: AnyObject) {
	const payload = JSON.stringify({
		recordedAt: now(),
		...cloneJson(event),
	});
	await FS(getModelLeagueEventsPath(config)).append(payload + "\n");
}

export async function loadQueuedControlRequests(config: ModelLeagueConfig) {
	const queueDir = getModelLeagueControlQueuePath(config);
	const fileNames = (await FS(queueDir).readdirIfExists()).filter(name => name.endsWith(".json")).sort();
	const requests: ModelLeagueControlRequest[] = [];
	for (const fileName of fileNames) {
		const request = readJson<ModelLeagueControlRequest>(joinPath(queueDir, fileName));
		if (request) requests.push(request);
	}
	return requests;
}

export async function writeControlRequest(config: ModelLeagueConfig, request: ModelLeagueControlRequest) {
	const filePath = joinPath(getModelLeagueControlQueuePath(config), `${request.id}.json`);
	await FS(filePath).safeWrite(JSON.stringify(request, null, 2));
}

export async function archiveControlRequest(config: ModelLeagueConfig, requestId: string) {
	const sourcePath = joinPath(getModelLeagueControlQueuePath(config), `${requestId}.json`);
	const archivePath = joinPath(getModelLeagueControlArchivePath(config), `${requestId}.json`);
	if (!FS(sourcePath).existsSync()) return;
	await FS(sourcePath).rename(archivePath);
}

export async function writeTrainingJobFile(config: ModelLeagueConfig, job: ModelLeagueTrainingJob) {
	const filePath = joinPath(config.stateRoot, config.training.pendingJobDir, `${job.jobId}.json`);
	await FS(filePath).safeWrite(JSON.stringify(job, null, 2));
}

export async function loadTrainingJobFiles(config: ModelLeagueConfig) {
	const dirPath = joinPath(config.stateRoot, config.training.pendingJobDir);
	const fileNames = (await FS(dirPath).readdirIfExists()).filter(name => name.endsWith(".json")).sort();
	const jobs: ModelLeagueTrainingJob[] = [];
	for (const fileName of fileNames) {
		const job = readJson<ModelLeagueTrainingJob>(joinPath(dirPath, fileName));
		if (job) jobs.push(job);
	}
	return jobs;
}

export async function removeTrainingJobFile(config: ModelLeagueConfig, jobId: string) {
	await FS(joinPath(config.stateRoot, config.training.pendingJobDir, `${jobId}.json`)).unlinkIfExists();
}

export async function writeCompletedTrainingPayload(
	config: ModelLeagueConfig,
	payload: ModelLeagueTrainingCompletionPayload
) {
	const filePath = joinPath(config.stateRoot, config.training.completedJobDir, `${payload.jobId}.json`);
	await FS(filePath).safeWrite(JSON.stringify(payload, null, 2));
}

export async function loadCompletedTrainingPayloads(config: ModelLeagueConfig) {
	const dirPath = joinPath(config.stateRoot, config.training.completedJobDir);
	const fileNames = (await FS(dirPath).readdirIfExists()).filter(name => name.endsWith(".json")).sort();
	const payloads: ModelLeagueTrainingCompletionPayload[] = [];
	for (const fileName of fileNames) {
		const payload = readJson<ModelLeagueTrainingCompletionPayload>(joinPath(dirPath, fileName));
		if (payload) payloads.push(payload);
	}
	return payloads;
}

export async function removeCompletedTrainingPayload(config: ModelLeagueConfig, jobId: string) {
	await FS(joinPath(config.stateRoot, config.training.completedJobDir, `${jobId}.json`)).unlinkIfExists();
}

export function applyTrainingCompletionPayloadToState(
	state: ModelLeagueState,
	payload: ModelLeagueTrainingCompletionPayload,
	nowISO = now(),
) {
	const checkpointId = payload.newModelId;
	let checkpoint = state.checkpoints.find(candidate => candidate.id === checkpointId);
	if (!checkpoint) {
		checkpoint = {
			id: checkpointId,
			name: payload.name || checkpointId,
			modelID: payload.newModelId,
			endpoint: payload.endpoint,
			modelProfile: payload.modelProfile,
			allowVoluntarySwitches: payload.allowVoluntarySwitches ?? true,
			active: payload.activate !== false,
			archived: false,
			lineageId: payload.lineageId || payload.parentCheckpointId || checkpointId,
			parentCheckpointId: payload.parentCheckpointId || null,
			sampleWeight: 1,
			allowedTeamIds: null,
			createdAt: nowISO,
			lastTrainingJobAt: null,
			matchCount: 0,
			liveMatchCount: 0,
			historicalMatchCount: 0,
			benchmarkMatchCount: 0,
			exampleCount: 0,
			trainingBuffer: {
				matchCount: 0,
				exampleCount: 0,
				exampleFiles: [],
				matchIds: [],
				lastBundleCreatedAt: null,
			},
			metadata: payload.metadata || null,
		} satisfies ModelLeagueCheckpointState;
		state.checkpoints.push(checkpoint);
	} else {
		checkpoint.name = payload.name || checkpoint.name;
		checkpoint.endpoint = payload.endpoint;
		checkpoint.modelProfile = payload.modelProfile;
		checkpoint.allowVoluntarySwitches = payload.allowVoluntarySwitches ?? checkpoint.allowVoluntarySwitches;
		checkpoint.active = payload.activate !== false;
		checkpoint.archived = false;
		checkpoint.lineageId = payload.lineageId || checkpoint.lineageId || payload.parentCheckpointId || checkpoint.id;
		checkpoint.parentCheckpointId = payload.parentCheckpointId || checkpoint.parentCheckpointId;
		checkpoint.metadata = payload.metadata || checkpoint.metadata;
	}

	const trainingJob = state.trainingJobs.find(job => job.jobId === payload.jobId);
	if (trainingJob) {
		trainingJob.status = "registered";
		trainingJob.completionPayload = payload;
		trainingJob.error = null;
	}
	state.stats.trainingBundles++;
	state.updatedAt = nowISO;
	return checkpoint;
}

export async function updateTrainingJobFile(config: ModelLeagueConfig, job: ModelLeagueTrainingJob) {
	await writeTrainingJobFile(config, job);
}

export function upsertTrainingJob(state: ModelLeagueState, job: ModelLeagueTrainingJob) {
	const existingIndex = state.trainingJobs.findIndex(candidate => candidate.jobId === job.jobId);
	if (existingIndex >= 0) state.trainingJobs[existingIndex] = job;
	else state.trainingJobs.push(job);
}

export function getCheckpoint(state: ModelLeagueState, checkpointId: string) {
	return state.checkpoints.find(candidate => candidate.id === checkpointId);
}

export function getTeam(state: ModelLeagueState, teamId: string) {
	return state.teams.find(candidate => candidate.id === teamId);
}
