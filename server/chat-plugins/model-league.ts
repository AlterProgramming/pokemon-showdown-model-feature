import * as crypto from "crypto";
import { FS, Utils } from "../../lib";
import {
	getDefaultModelLeagueConfigPath,
	loadModelLeagueConfig,
	resolveModelLeagueConfigPath,
} from "../model-league/config";
import { ensureRatingEntries, sortRatings } from "../model-league/ratings";
import type {
	ModelLeagueBenchmarkProgress,
	ModelLeagueConfig,
	ModelLeagueControlRequest,
	ModelLeagueControlRequestType,
	ModelLeagueDaemonState,
	ModelLeagueCheckpointState,
	ModelLeagueModelConfig,
	ModelLeagueRatingEntry,
	ModelLeagueState,
	ModelLeagueTeamConfig,
	ModelLeagueTeamState,
} from "../model-league/types";

const STATE_FILE_NAME = "state.json";
const CONTROL_QUEUE_DIR = "control-requests";

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
		throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
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

function createCheckpointState(model: ModelLeagueModelConfig): ModelLeagueCheckpointState {
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

function createTeamState(team: ModelLeagueTeamConfig): ModelLeagueTeamState {
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

function createInitialState(config: ModelLeagueConfig, configPath: string): ModelLeagueState {
	const state: ModelLeagueState = {
		version: 1,
		updatedAt: null,
		configPath,
		daemon: defaultDaemonState(config),
		checkpoints: config.models.map(createCheckpointState),
		teams: config.teams.map(createTeamState),
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

function mergeCheckpointState(base: ModelLeagueCheckpointState, raw: Partial<ModelLeagueCheckpointState>) {
	base.name = typeof raw.name === "string" ? raw.name : base.name;
	base.modelID = typeof raw.modelID === "string" ? raw.modelID : base.modelID;
	base.endpoint = typeof raw.endpoint === "string" ? raw.endpoint : base.endpoint;
	base.modelProfile = raw.modelProfile || base.modelProfile;
	base.allowVoluntarySwitches = raw.allowVoluntarySwitches ?? base.allowVoluntarySwitches;
	base.active = raw.active ?? base.active;
	base.archived = raw.archived ?? base.archived;
	base.lineageId = typeof raw.lineageId === "string" ? raw.lineageId : base.lineageId;
	base.parentCheckpointId = raw.parentCheckpointId ?? base.parentCheckpointId;
	base.sampleWeight = typeof raw.sampleWeight === "number" ? raw.sampleWeight : base.sampleWeight;
	base.allowedTeamIds = raw.allowedTeamIds ? [...raw.allowedTeamIds] : base.allowedTeamIds;
	base.createdAt = typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt;
	base.lastTrainingJobAt = raw.lastTrainingJobAt ?? base.lastTrainingJobAt;
	base.matchCount = typeof raw.matchCount === "number" ? raw.matchCount : base.matchCount;
	base.liveMatchCount = typeof raw.liveMatchCount === "number" ? raw.liveMatchCount : base.liveMatchCount;
	base.historicalMatchCount =
		typeof raw.historicalMatchCount === "number" ?
			raw.historicalMatchCount :
			base.historicalMatchCount;
	base.benchmarkMatchCount =
		typeof raw.benchmarkMatchCount === "number" ?
			raw.benchmarkMatchCount :
			base.benchmarkMatchCount;
	base.exampleCount = typeof raw.exampleCount === "number" ? raw.exampleCount : base.exampleCount;
	base.trainingBuffer = raw.trainingBuffer || base.trainingBuffer;
	base.metadata = raw.metadata ?? base.metadata;
}

function mergeTeamState(base: ModelLeagueTeamState, raw: Partial<ModelLeagueTeamState>) {
	base.name = typeof raw.name === "string" ? raw.name : base.name;
	base.packedTeam = typeof raw.packedTeam === "string" ? raw.packedTeam : base.packedTeam;
	base.active = raw.active ?? base.active;
	base.archived = raw.archived ?? base.archived;
	base.sampleWeight = typeof raw.sampleWeight === "number" ? raw.sampleWeight : base.sampleWeight;
	base.createdAt = typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt;
	base.matchCount = typeof raw.matchCount === "number" ? raw.matchCount : base.matchCount;
	base.liveMatchCount = typeof raw.liveMatchCount === "number" ? raw.liveMatchCount : base.liveMatchCount;
	base.historicalMatchCount =
		typeof raw.historicalMatchCount === "number" ?
			raw.historicalMatchCount :
			base.historicalMatchCount;
	base.benchmarkMatchCount =
		typeof raw.benchmarkMatchCount === "number" ?
			raw.benchmarkMatchCount :
			base.benchmarkMatchCount;
	base.metadata = raw.metadata ?? base.metadata;
}

function mergeDaemonState(base: ModelLeagueDaemonState, raw: Partial<ModelLeagueDaemonState>) {
	base.status = raw.status || base.status;
	base.pid = raw.pid ?? base.pid;
	base.startedAt = raw.startedAt ?? base.startedAt;
	base.heartbeatAt = raw.heartbeatAt ?? base.heartbeatAt;
	base.lastLoopAt = raw.lastLoopAt ?? base.lastLoopAt;
	base.loopCount = typeof raw.loopCount === "number" ? raw.loopCount : base.loopCount;
	base.activeTask = raw.activeTask ?? base.activeTask;
	base.lastError = raw.lastError ?? base.lastError;
	base.webhook = {
		...base.webhook,
		...(raw.webhook || {}),
	};
}

function normalizeState(raw: AnyObject | null, config: ModelLeagueConfig, configPath: string): ModelLeagueState {
	const base = createInitialState(config, configPath);
	if (!raw || typeof raw !== "object") return base;
	const state = raw as Partial<ModelLeagueState>;
	base.updatedAt = typeof state.updatedAt === "string" ? state.updatedAt : base.updatedAt;
	if (state.daemon) mergeDaemonState(base.daemon, state.daemon);

	if (Array.isArray(state.checkpoints)) {
		for (const checkpoint of state.checkpoints) {
			if (!checkpoint?.id) continue;
			const existing = base.checkpoints.find(candidate => candidate.id === checkpoint.id);
			if (existing) {
				mergeCheckpointState(existing, checkpoint);
			} else {
				base.checkpoints.push({
					...createCheckpointState({
						id: checkpoint.id,
						name: checkpoint.name || checkpoint.id,
						modelID: checkpoint.modelID || checkpoint.id,
						endpoint: checkpoint.endpoint || "",
						modelProfile: checkpoint.modelProfile || config.models[0]?.modelProfile || "joint-policy",
						allowVoluntarySwitches: checkpoint.allowVoluntarySwitches,
						active: checkpoint.active,
						archived: checkpoint.archived,
						lineageId: checkpoint.lineageId,
						parentCheckpointId: checkpoint.parentCheckpointId,
						sampleWeight: checkpoint.sampleWeight,
						allowedTeamIds: checkpoint.allowedTeamIds || undefined,
						metadata: checkpoint.metadata || undefined,
					} as ModelLeagueModelConfig),
					...checkpoint,
				});
			}
		}
	}

	if (Array.isArray(state.teams)) {
		for (const team of state.teams) {
			if (!team?.id) continue;
			const existing = base.teams.find(candidate => candidate.id === team.id);
			if (existing) {
				mergeTeamState(existing, team);
			} else {
				base.teams.push({
					...createTeamState({
						id: team.id,
						name: team.name || team.id,
						packedTeam: team.packedTeam || "",
						active: team.active,
						archived: team.archived,
						sampleWeight: team.sampleWeight,
						metadata: team.metadata || undefined,
					}),
					...team,
				});
			}
		}
	}

	if (Array.isArray(state.modelRatings)) base.modelRatings = state.modelRatings;
	if (Array.isArray(state.teamRatings)) base.teamRatings = state.teamRatings;
	if (Array.isArray(state.recentMatches)) base.recentMatches = state.recentMatches;
	if (Array.isArray(state.recentBenchmarkRuns)) base.recentBenchmarkRuns = state.recentBenchmarkRuns;
	if (Array.isArray(state.benchmarkProgress)) base.benchmarkProgress = state.benchmarkProgress;
	if (Array.isArray(state.trainingJobs)) base.trainingJobs = state.trainingJobs;
	if (Array.isArray(state.processedControlRequestIds)) base.processedControlRequestIds = state.processedControlRequestIds;
	if (Array.isArray(state.processedCompletedJobIds)) base.processedCompletedJobIds = state.processedCompletedJobIds;
	if (state.stats) base.stats = { ...base.stats, ...state.stats };

	ensureRatingEntries(base, config);
	sortRatings(base.modelRatings);
	sortRatings(base.teamRatings);
	base.benchmarkProgress.sort((a, b) => a.level - b.level);
	return base;
}

function getModelLeagueStatePath(config: ModelLeagueConfig) {
	return joinPath(config.stateRoot, STATE_FILE_NAME);
}

function getModelLeagueControlQueuePath(config: ModelLeagueConfig) {
	return joinPath(config.stateRoot, CONTROL_QUEUE_DIR);
}

function loadModelLeagueMaterializedState() {
	const configPath = resolveModelLeagueConfigPath(null, { preferActive: true });
	const config = loadModelLeagueConfig(configPath);
	const state = normalizeState(readJson<AnyObject>(getModelLeagueStatePath(config)), config, configPath);
	return { config, state, configPath };
}

async function loadControlRequests(config: ModelLeagueConfig) {
	const queueDir = getModelLeagueControlQueuePath(config);
	const fileNames = (await FS(queueDir).readdirIfExists()).filter(name => name.endsWith(".json")).sort();
	const requests: ModelLeagueControlRequest[] = [];
	for (const fileName of fileNames) {
		const request = readJson<ModelLeagueControlRequest>(joinPath(queueDir, fileName));
		if (request) requests.push(request);
	}
	return requests;
}

async function writeControlRequest(
	config: ModelLeagueConfig,
	type: ModelLeagueControlRequestType,
	requestedBy: string,
	modelCheckpointId?: string,
) {
	await FS(getModelLeagueControlQueuePath(config)).mkdirp();
	const request: ModelLeagueControlRequest = {
		id: `modelleague-${type}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
		type,
		createdAt: now(),
		requestedBy,
		...(modelCheckpointId ? { modelCheckpointId } : {}),
	};
	const path = joinPath(getModelLeagueControlQueuePath(config), `${request.id}.json`);
	await FS(path).safeWrite(JSON.stringify(request, null, 2));
	return request;
}

function requireModelLeagueAccess(this: Chat.PageContext | Chat.CommandContext) {
	const room = Rooms.get("development");
	if (!room) throw new Chat.ErrorMessage("No Development room found.");
	this.checkCan("warn", null, room);
	return room;
}

function renderBadge(value: boolean, truthyLabel = "Yes", falsyLabel = "No") {
	return value ? truthyLabel : falsyLabel;
}

function renderRequestButton(label: string, command: string, disabled = false) {
	if (disabled) return `<button class="button" disabled>${Utils.escapeHTML(label)}</button>`;
	return `<button class="button notifying" name="send" value="${Utils.escapeHTML(command)}">${Utils.escapeHTML(label)}</button>`;
}

function renderCheckpointOption(checkpoint: ModelLeagueCheckpointState) {
	return `<option value="${Utils.escapeHTML(checkpoint.id)}">${Utils.escapeHTML(checkpoint.name)} (${Utils.escapeHTML(checkpoint.id)})</option>`;
}

function renderLeaderboard(entries: ModelLeagueRatingEntry[], title: string) {
	let buf = `<div class="infobox"><h3>${Utils.escapeHTML(title)}</h3><hr />`;
	if (!entries.length) {
		buf += `<p>No ratings recorded yet.</p></div>`;
		return buf;
	}
	buf += `<div class="ladder pad"><table><tr><th>#</th><th>ID</th><th>Name</th><th>Elo</th><th>W-L-T</th><th>Matches</th></tr>`;
	for (const [index, entry] of entries.entries()) {
		buf += `<tr>`;
		buf += `<td>${index + 1}</td>`;
		buf += `<td><code>${Utils.escapeHTML(entry.id)}</code></td>`;
		buf += `<td>${Utils.escapeHTML(entry.name)}</td>`;
		buf += `<td>${Math.round(entry.elo)}</td>`;
		buf += `<td>${entry.wins}-${entry.losses}-${entry.ties}</td>`;
		buf += `<td>${entry.totalMatches}</td>`;
		buf += `</tr>`;
	}
	buf += `</table></div></div>`;
	return buf;
}

function renderStatusRow(label: string, value: string | number | boolean | null | undefined) {
	return `<tr><th>${Utils.escapeHTML(label)}</th><td>${Utils.escapeHTML(value === null || value === undefined ? "-" : String(value))}</td></tr>`;
}

function renderControlRequests(requests: ModelLeagueControlRequest[], config: ModelLeagueConfig) {
	let buf = `<div class="infobox"><h3>Pending Control Requests</h3><hr />`;
	buf += `<p>The daemon consumes queue files from <code>${Utils.escapeHTML(getModelLeagueControlQueuePath(config))}</code>.</p>`;
	if (!requests.length) {
		buf += `<p>None queued.</p></div>`;
		return buf;
	}
	buf += `<div class="ladder pad"><table><tr><th>ID</th><th>Type</th><th>Requested By</th><th>Created</th><th>Checkpoint</th></tr>`;
	for (const request of requests) {
		buf += `<tr>`;
		buf += `<td><code>${Utils.escapeHTML(request.id)}</code></td>`;
		buf += `<td>${Utils.escapeHTML(request.type)}</td>`;
		buf += `<td>${Utils.escapeHTML(request.requestedBy)}</td>`;
		buf += `<td>${Utils.escapeHTML(request.createdAt)}</td>`;
		buf += `<td>${Utils.escapeHTML(request.modelCheckpointId || "-")}</td>`;
		buf += `</tr>`;
	}
	buf += `</table></div></div>`;
	return buf;
}

function renderBenchmarkProgress(state: ModelLeagueState) {
	let buf = `<div class="infobox"><h3>Benchmark Tower</h3><hr />`;
	if (!state.benchmarkProgress.length) {
		buf += `<p>No benchmarks configured.</p></div>`;
		return buf;
	}
	buf += `<div class="ladder pad"><table><tr><th>Level</th><th>Name</th><th>Required Win Rate</th><th>Cleared</th><th>Last Run</th><th>Last Result</th></tr>`;
	for (const progress of state.benchmarkProgress) {
		buf += `<tr>`;
		buf += `<td>${progress.level}</td>`;
		buf += `<td>${Utils.escapeHTML(progress.name)}</td>`;
		buf += `<td>${Math.round(progress.requiredWinRate * 100)}%</td>`;
		buf += `<td>${renderBadge(progress.cleared)}</td>`;
		buf += `<td>${Utils.escapeHTML(progress.lastRunAt || "-")}</td>`;
		buf += `<td>${progress.lastWinRate === null ? "-" : `${Math.round(progress.lastWinRate * 100)}%`}</td>`;
		buf += `</tr>`;
	}
	buf += `</table></div></div>`;
	return buf;
}

function renderTrainingJobs(state: ModelLeagueState) {
	const pendingJobs = state.trainingJobs.filter(job => job.status === "pending");
	let buf = `<div class="infobox"><h3>Pending Training Jobs</h3><hr />`;
	if (!pendingJobs.length) {
		buf += `<p>No pending training jobs.</p></div>`;
		return buf;
	}
	buf += `<div class="ladder pad"><table><tr><th>Job ID</th><th>Checkpoint</th><th>Status</th><th>Created</th><th>Matches</th><th>Examples</th><th>Webhook</th><th>Error</th></tr>`;
	for (const job of pendingJobs) {
		buf += `<tr>`;
		buf += `<td><code>${Utils.escapeHTML(job.jobId)}</code></td>`;
		buf += `<td><code>${Utils.escapeHTML(job.modelCheckpointId)}</code></td>`;
		buf += `<td>${Utils.escapeHTML(job.status)}</td>`;
		buf += `<td>${Utils.escapeHTML(job.createdAt)}</td>`;
		buf += `<td>${job.matchCount}</td>`;
		buf += `<td>${job.exampleCount}</td>`;
		buf += `<td>${job.outboundWebhookDeliveredAt ? Utils.escapeHTML(job.outboundWebhookDeliveredAt) : "-"}</td>`;
		buf += `<td>${job.error ? Utils.escapeHTML(job.error) : "-"}</td>`;
		buf += `</tr>`;
	}
	buf += `</table></div></div>`;
	return buf;
}

function renderCheckpointTable(state: ModelLeagueState, config: ModelLeagueConfig) {
	let buf = `<div class="infobox"><h3>Checkpoints</h3><hr />`;
	if (!state.checkpoints.length) {
		buf += `<p>No checkpoints configured.</p></div>`;
		return buf;
	}
	buf += `<p><strong>Config path:</strong> <code>${Utils.escapeHTML(configPathDisplay(config))}</code><br />`;
	buf += `<strong>State root:</strong> <code>${Utils.escapeHTML(config.stateRoot)}</code><br />`;
	buf += `<strong>Log root:</strong> <code>${Utils.escapeHTML(config.logRoot)}</code></p>`;
	buf += `<div class="ladder pad"><table><tr><th>ID</th><th>Name</th><th>Status</th><th>Model ID</th><th>Profile</th><th>Matches</th><th>Examples</th><th>Action</th></tr>`;
	for (const checkpoint of state.checkpoints) {
		buf += `<tr>`;
		buf += `<td><code>${Utils.escapeHTML(checkpoint.id)}</code></td>`;
		buf += `<td>${Utils.escapeHTML(checkpoint.name)}</td>`;
		buf += `<td>${checkpoint.active ? "Active" : "Inactive"}${checkpoint.archived ? " / Archived" : ""}</td>`;
		buf += `<td><code>${Utils.escapeHTML(checkpoint.modelID)}</code></td>`;
		buf += `<td>${Utils.escapeHTML(String(checkpoint.modelProfile))}</td>`;
		buf += `<td>${checkpoint.matchCount}</td>`;
		buf += `<td>${checkpoint.exampleCount}</td>`;
		buf += `<td>${renderRequestButton("Request training", `/msgroom development,/modelleague enqueue-training ${checkpoint.id}`)}</td>`;
		buf += `</tr>`;
	}
	buf += `</table></div></div>`;
	return buf;
}

function renderTeamTable(state: ModelLeagueState) {
	let buf = `<div class="infobox"><h3>Teams</h3><hr />`;
	if (!state.teams.length) {
		buf += `<p>No teams configured.</p></div>`;
		return buf;
	}
	buf += `<div class="ladder pad"><table><tr><th>ID</th><th>Name</th><th>Status</th><th>Matches</th><th>Packed Team</th></tr>`;
	for (const team of state.teams) {
		buf += `<tr>`;
		buf += `<td><code>${Utils.escapeHTML(team.id)}</code></td>`;
		buf += `<td>${Utils.escapeHTML(team.name)}</td>`;
		buf += `<td>${team.active ? "Active" : "Inactive"}${team.archived ? " / Archived" : ""}</td>`;
		buf += `<td>${team.matchCount}</td>`;
		buf += `<td><code>${Utils.escapeHTML(team.packedTeam)}</code></td>`;
		buf += `</tr>`;
	}
	buf += `</table></div></div>`;
	return buf;
}

function configPathDisplay(config: ModelLeagueConfig) {
	return getDefaultModelLeagueConfigPath();
}

export const commands: Chat.ChatCommands = {
	ml: 'modelleague',
	modelleague: {
		''() {
			requireModelLeagueAccess.call(this);
			return this.parse(`/j view-modelleague`);
		},
		open: '',
		page() {
			requireModelLeagueAccess.call(this);
			return this.parse(`/j view-modelleague`);
		},
		status() {
			requireModelLeagueAccess.call(this);
			return this.parse(`/j view-modelleague`);
		},
		async pause(target, room, user) {
			requireModelLeagueAccess.call(this);
			await writeControlRequest(loadModelLeagueMaterializedState().config, "pause", user.id);
			this.sendReply(`Queued a pause request for the model league daemon.`);
		},
		async resume(target, room, user) {
			requireModelLeagueAccess.call(this);
			await writeControlRequest(loadModelLeagueMaterializedState().config, "resume", user.id);
			this.sendReply(`Queued a resume request for the model league daemon.`);
		},
		benchmark: 'forcebenchmark',
		async forcebenchmark(target, room, user) {
			requireModelLeagueAccess.call(this);
			await writeControlRequest(loadModelLeagueMaterializedState().config, "force-benchmark", user.id);
			this.sendReply(`Queued a benchmark request for the model league daemon.`);
		},
		snapshot: 'forcesnapshot',
		async forcesnapshot(target, room, user) {
			requireModelLeagueAccess.call(this);
			await writeControlRequest(loadModelLeagueMaterializedState().config, "force-snapshot", user.id);
			this.sendReply(`Queued a snapshot request for the model league daemon.`);
		},
		enqueue: 'enqueuetraining',
		"enqueue-training": 'enqueuetraining',
		async enqueuetraining(target, room, user) {
			requireModelLeagueAccess.call(this);
			const modelCheckpointId = `${target || ""}`.trim();
			const config = loadModelLeagueMaterializedState().config;
			await writeControlRequest(config, "enqueue-training", user.id, modelCheckpointId || undefined);
			this.sendReply(
				`Queued a training request${modelCheckpointId ? ` for ${modelCheckpointId}` : ``}.`
			);
		},
		help() {
			return this.parse('/help modelleague');
		},
	},
	modelleaguehelp: [
		`/modelleague - Open the model league admin page. Requires Development-room admin access.`,
		`/modelleague status - Refresh the model league admin page.`,
		`/modelleague pause - Queue a pause request for the daemon.`,
		`/modelleague resume - Queue a resume request for the daemon.`,
		`/modelleague benchmark - Queue a benchmark run request.`,
		`/modelleague snapshot - Queue a snapshot request.`,
		`/modelleague enqueue-training [checkpoint] - Queue a training request, optionally targeting a checkpoint.`,
	],
};

export const pages: Chat.PageTable = {
	async modelleague(query, user) {
		const { config, state } = loadModelLeagueMaterializedState();
		const room = Rooms.get("development");
		if (!room) throw new Chat.ErrorMessage("No Development room found.");
		this.checkCan("warn", null, room);
		this.title = "[Model League]";
		const queuedRequests = await loadControlRequests(config);

		const pendingCount = state.trainingJobs.filter(job => job.status === "pending").length;
		let buf = `<div class="pad ladder">`;
		buf += `<div class="pad">`;
		buf += `<button style="float:right;" class="button" name="send" value="/j view-modelleague">`;
		buf += `<i class="fa fa-refresh"></i> Refresh</button>`;
		buf += `<h2>Model League Admin</h2>`;
		buf += `<p><strong>Format:</strong> <code>${Utils.escapeHTML(config.format)}</code><br />`;
		buf += `<strong>Materialized config:</strong> <code>${Utils.escapeHTML(state.configPath)}</code><br />`;
		buf += `<strong>State file:</strong> <code>${Utils.escapeHTML(getModelLeagueStatePath(config))}</code><br />`;
		buf += `<strong>State root:</strong> <code>${Utils.escapeHTML(config.stateRoot)}</code><br />`;
		buf += `<strong>Log root:</strong> <code>${Utils.escapeHTML(config.logRoot)}</code></p>`;
		buf += `<div class="infobox"><table>`;
		buf += renderStatusRow("Daemon status", state.daemon.status);
		buf += renderStatusRow("Loop count", state.daemon.loopCount);
		buf += renderStatusRow("Last loop", state.daemon.lastLoopAt);
		buf += renderStatusRow("Heartbeat", state.daemon.heartbeatAt);
		buf += renderStatusRow("Active task", state.daemon.activeTask?.description || "-");
		buf += renderStatusRow("Pending training jobs", pendingCount);
		buf += renderStatusRow("Queued control requests", queuedRequests.length);
		buf += renderStatusRow("Processed control requests", state.processedControlRequestIds.length);
		buf += renderStatusRow("Processed completed jobs", state.processedCompletedJobIds.length);
		buf += renderStatusRow("Benchmark runs", state.stats.benchmarkRuns);
		buf += renderStatusRow("Training bundles", state.stats.trainingBundles);
		buf += renderStatusRow("Decision examples", state.stats.decisionExamplesCaptured);
		buf += `</table></div><br />`;
		buf += `<div style="margin-bottom: 8px;">`;
		buf += renderRequestButton("Pause daemon", "/msgroom development,/modelleague pause");
		buf += ` `;
		buf += renderRequestButton("Resume daemon", "/msgroom development,/modelleague resume");
		buf += ` `;
		buf += renderRequestButton("Force benchmark", "/msgroom development,/modelleague benchmark");
		buf += ` `;
		buf += renderRequestButton("Force snapshot", "/msgroom development,/modelleague snapshot");
		buf += `</div>`;
		buf += `<form data-submitsend="/msgroom development,/modelleague enqueue-training {modelCheckpointId}">`;
		buf += `<label><strong>Queue training for checkpoint:</strong></label><br />`;
		buf += `<select name="modelCheckpointId">`;
		buf += state.checkpoints.map(renderCheckpointOption).join('');
		buf += `</select> `;
		buf += `<button class="button notifying" type="submit">Queue training</button>`;
		buf += `</form>`;
		buf += `</div><hr />`;
		buf += renderCheckpointTable(state, config);
		buf += `<br />`;
		buf += renderTeamTable(state);
		buf += `<br />`;
		buf += renderTrainingJobs(state);
		buf += `<br />`;
		buf += renderLeaderboard(state.modelRatings.slice().sort((a, b) => b.elo - a.elo), "Model Leaderboard");
		buf += `<br />`;
		buf += renderLeaderboard(state.teamRatings.slice().sort((a, b) => b.elo - a.elo), "Team Leaderboard");
		buf += `<br />`;
		buf += renderBenchmarkProgress(state);
		buf += `<br />`;
		buf += renderControlRequests(queuedRequests, config);
		buf += `</div>`;
		return buf;
	},
};
