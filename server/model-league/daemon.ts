import * as crypto from "crypto";
import { FS } from "../../lib";
import { ModelLeagueRunner } from "../../sim/tools/model-league-runner";
import {
	getDefaultModelLeagueConfigPath,
	loadModelLeagueConfig,
	resolveModelLeagueConfigPath,
	writeActiveModelLeagueConfigPath,
} from "./config";
import { applyRatingMatch, createRatingEntry, sortRatings } from "./ratings";
import { postModelLeagueWebhook, ModelLeagueCompletionWebhookServer } from "./webhooks";
import {
	appendModelLeagueEvent,
	archiveControlRequest,
	applyTrainingCompletionPayloadToState,
	ensureModelLeagueDirectories,
	getCheckpoint,
	getTeam,
	getModelLeagueStatePath,
	getModelLeagueTrainingDir,
	loadCompletedTrainingPayloads,
	loadModelLeagueState,
	loadQueuedControlRequests,
	loadTrainingJobFiles,
	removeCompletedTrainingPayload,
	removeTrainingJobFile,
	saveModelLeagueState,
	upsertTrainingJob,
	writeCompletedTrainingPayload,
	writeTrainingJobFile,
} from "./storage";
import type {
	ModelLeagueBenchmarkProgress,
	ModelLeagueCheckpointState,
	ModelLeagueConfig,
	ModelLeagueDaemonState,
	ModelLeagueDaemonTask,
	ModelLeagueMatchSummary,
	ModelLeagueSchedulerBucket,
	ModelLeagueState,
	ModelLeagueTeamState,
	ModelLeagueTrainingCompletionPayload,
	ModelLeagueTrainingJob,
} from "./types";

type LoadedLeague = { configPath: string, config: ModelLeagueConfig, state: ModelLeagueState };
type MatchSelection = {
	pool: ModelLeagueSchedulerBucket,
	rollouts: number,
	modelA: ModelLeagueCheckpointState,
	modelB: ModelLeagueCheckpointState,
	teamA: ModelLeagueTeamState,
	teamB: ModelLeagueTeamState,
};
type MatchSettlementFrontier = {
	pool: ModelLeagueSchedulerBucket,
	rollouts: number,
	modelAId: string,
	modelAName: string,
	modelBId: string,
	modelBName: string,
	teamAId: string,
	teamAName: string,
	teamBId: string,
	teamBName: string,
};
type BenchmarkSettlementFrontier = {
	benchmarkId: string,
	challengerModelId: string,
	challengerTeamId: string,
	opponentModelId: string,
	opponentTeamId: string,
};

export interface ModelLeagueDaemonOptions {
	configPath?: string;
}

export interface ModelLeagueDaemonStatusReport {
	configPath: string;
	statePath: string;
	status: ModelLeagueDaemonState["status"];
	paused: boolean;
	pid: number | null;
	loopCount: number;
	heartbeatAt: string | null;
	lastLoopAt: string | null;
	lastError: string | null;
	activeTask: ModelLeagueDaemonTask | null;
	queuedControlRequests: number;
	trainingJobs: number;
	checkpoints: number;
	teams: number;
	benchmarkProgress: { total: number, cleared: number };
	stats: ModelLeagueState["stats"];
	webhook: ModelLeagueDaemonState["webhook"];
}

function now() {
	return new Date().toISOString();
}

function joinPath(...parts: string[]) {
	return parts.filter(Boolean).join("/").replace(/\\/g, "/");
}

function randomId(prefix: string) {
	return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function recent<T>(items: T[], limit: number) {
	return items.length > limit ? items.slice(-limit) : items;
}

function weightedPick<T extends { sampleWeight?: number }>(items: T[]) {
	const total = items.reduce((sum, item) => sum + (item.sampleWeight || 1), 0);
	if (!total) return null;
	let roll = Math.random() * total;
	for (const item of items) {
		roll -= item.sampleWeight || 1;
		if (roll <= 0) return item;
	}
	return items[items.length - 1] || null;
}

function loadLeague(configPath: string): LoadedLeague {
	const config = loadModelLeagueConfig(configPath);
	const state = loadModelLeagueState(config, configPath);
	return { configPath, config, state };
}

function activeTeams(state: ModelLeagueState) {
	return state.teams.filter(team => team.active && !team.archived);
}

function eligibleTeams(checkpoint: ModelLeagueCheckpointState, state: ModelLeagueState) {
	const pool = activeTeams(state);
	if (checkpoint.allowedTeamIds?.length) {
		const allowed = pool.filter(team => checkpoint.allowedTeamIds!.includes(team.id));
		if (allowed.length) return allowed;
	}
	return pool;
}

function pickTeam(checkpoint: ModelLeagueCheckpointState, state: ModelLeagueState) {
	return weightedPick(eligibleTeams(checkpoint, state));
}

function captureMatchSettlementFrontier(selection: MatchSelection): MatchSettlementFrontier {
	return {
		pool: selection.pool,
		rollouts: selection.rollouts,
		modelAId: selection.modelA.id,
		modelAName: selection.modelA.name,
		modelBId: selection.modelB.id,
		modelBName: selection.modelB.name,
		teamAId: selection.teamA.id,
		teamAName: selection.teamA.name,
		teamBId: selection.teamB.id,
		teamBName: selection.teamB.name,
	};
}

function captureBenchmarkSettlementFrontier(
	progress: ModelLeagueBenchmarkProgress,
	challenger: ModelLeagueCheckpointState,
	challengerTeam: ModelLeagueTeamState,
	opponent: ModelLeagueCheckpointState,
	opponentTeam: ModelLeagueTeamState,
): BenchmarkSettlementFrontier {
	return {
		benchmarkId: progress.id,
		challengerModelId: challenger.id,
		challengerTeamId: challengerTeam.id,
		opponentModelId: opponent.id,
		opponentTeamId: opponentTeam.id,
	};
}

function requireCheckpointForSettlement(state: ModelLeagueState, checkpointId: string, role: string) {
	const settledCheckpoint = getCheckpoint(state, checkpointId);
	if (!settledCheckpoint) {
		throw new Error(`Model league settlement drift: missing ${role} checkpoint "${checkpointId}".`);
	}
	return settledCheckpoint;
}

function requireTeamForSettlement(state: ModelLeagueState, teamId: string, role: string) {
	const settledTeam = getTeam(state, teamId);
	if (!settledTeam) {
		throw new Error(`Model league settlement drift: missing ${role} team "${teamId}".`);
	}
	return settledTeam;
}

function requireBenchmarkProgressForSettlement(state: ModelLeagueState, benchmarkId: string) {
	const settledProgress = state.benchmarkProgress.find(candidate => candidate.id === benchmarkId);
	if (!settledProgress) {
		throw new Error(`Model league settlement drift: missing benchmark progress "${benchmarkId}".`);
	}
	return settledProgress;
}

function activeCheckpoints(state: ModelLeagueState) {
	return state.checkpoints.filter(checkpoint => checkpoint.active && !checkpoint.archived);
}

function historicalCheckpoints(state: ModelLeagueState) {
	return state.checkpoints.filter(checkpoint => checkpoint.archived || !checkpoint.active);
}

function createMatchSummary(
	type: "live" | "historical",
	schedulerBucket: ModelLeagueSchedulerBucket,
	batch: any,
	teamAId: string,
	teamBId: string,
	modelAEloBefore: number,
	modelAEloAfter: number,
	modelBEloBefore: number,
	modelBEloAfter: number,
	teamAEloBefore: number,
	teamAEloAfter: number,
	teamBEloBefore: number,
	teamBEloAfter: number,
): ModelLeagueMatchSummary {
	return {
		id: batch.batchId,
		type,
		schedulerBucket,
		recordedAt: batch.recordedAt,
		format: batch.format,
		rollouts: batch.rollouts,
		sideSwap: batch.sideSwap,
		modelAId: batch.modelA.id,
		modelBId: batch.modelB.id,
		teamAId,
		teamBId,
		modelAWins: batch.modelAWins,
		modelBWins: batch.modelBWins,
		ties: batch.ties,
		winRateA: batch.winRateA,
		confidenceLow: batch.confidenceLow,
		confidenceHigh: batch.confidenceHigh,
		modelAEloBefore,
		modelAEloAfter,
		modelBEloBefore,
		modelBEloAfter,
		teamAEloBefore,
		teamAEloAfter,
		teamBEloBefore,
		teamBEloAfter,
		replayPaths: batch.replayPaths,
		exampleFiles: {},
	};
}

async function makeTrainingJob(
	config: ModelLeagueConfig,
	state: ModelLeagueState,
	checkpoint: ModelLeagueCheckpointState,
	requestedBy: string,
) {
	const existing = state.trainingJobs.find(job =>
		job.modelCheckpointId === checkpoint.id &&
		(job.status === "pending" || job.status === "registered")
	);
	if (existing) return existing;
	const frontierCheckpointId = checkpoint.id;
	const jobId = randomId(`modelleague-training-${checkpoint.id}`);
	const bundleDir = joinPath(config.stateRoot, config.training.bundleDir, jobId);
	const manifestPath = joinPath(bundleDir, "manifest.json");
	const job: ModelLeagueTrainingJob = {
		jobId,
		modelCheckpointId: checkpoint.id,
		parentCheckpointId: checkpoint.parentCheckpointId,
		lineageId: checkpoint.lineageId,
		createdAt: now(),
		requestedBy,
		status: "pending",
		bundleDir,
		manifestPath,
		matchCount: checkpoint.trainingBuffer.matchCount,
		exampleCount: checkpoint.trainingBuffer.exampleCount,
		exampleFiles: [...checkpoint.trainingBuffer.exampleFiles],
		matchIds: [...checkpoint.trainingBuffer.matchIds],
		outboundWebhookDeliveredAt: null,
		outboundWebhookError: null,
		completionPayload: null,
		error: null,
	};
	await FS(bundleDir).mkdirp();
	await FS(manifestPath).safeWrite(JSON.stringify({
		version: 1,
		jobId,
		checkpointId: frontierCheckpointId,
		parentCheckpointId: job.parentCheckpointId,
		lineageId: job.lineageId,
		buffer: checkpoint.trainingBuffer,
	}, null, 2));
	const settledState = state;
	const settledCheckpoint = requireCheckpointForSettlement(settledState, frontierCheckpointId, "training");
	upsertTrainingJob(settledState, job);
	settledState.stats.trainingBundles++;
	settledCheckpoint.lastTrainingJobAt = job.createdAt;
	settledCheckpoint.trainingBuffer = {
		matchCount: 0,
		exampleCount: 0,
		exampleFiles: [],
		matchIds: [],
		lastBundleCreatedAt: job.createdAt,
	};
	await writeTrainingJobFile(config, job);
	const webhook = await postModelLeagueWebhook(config.webhooks.outboundTrainingRequested, {
		jobId,
		modelCheckpointId: frontierCheckpointId,
		bundleDir,
		manifestPath,
	});
	job.outboundWebhookDeliveredAt = webhook.delivered ? now() : null;
	job.outboundWebhookError = webhook.error;
	await writeTrainingJobFile(config, job);
	await appendModelLeagueEvent(config, {
		type: "training-job-created",
		jobId,
		checkpointId: frontierCheckpointId,
		requestedBy,
	});
	return job;
}

async function processCompletion(
	config: ModelLeagueConfig,
	state: ModelLeagueState,
	payload: ModelLeagueTrainingCompletionPayload,
	source: "webhook" | "disk",
) {
	if (state.processedCompletedJobIds.includes(payload.jobId)) return;
	await writeCompletedTrainingPayload(config, payload);
	const checkpoint = applyTrainingCompletionPayloadToState(state, payload);
	const job = state.trainingJobs.find(candidate => candidate.jobId === payload.jobId);
	if (job) {
		job.status = "completed";
		job.completionPayload = payload;
	}
	const parent = payload.parentCheckpointId ? getCheckpoint(state, payload.parentCheckpointId) : null;
	if (parent) {
		checkpoint.allowedTeamIds =
			checkpoint.allowedTeamIds ||
			(parent.allowedTeamIds ? [...parent.allowedTeamIds] : null);
		checkpoint.sampleWeight = Math.max(1.5, parent.sampleWeight || 1);
		parent.sampleWeight = Math.max(0.25, parent.sampleWeight * 0.75);
	}
	if (!state.modelRatings.some(entry => entry.id === checkpoint.id)) {
		state.modelRatings.push(createRatingEntry(checkpoint.id, checkpoint.name, config.ratings.initialElo));
		sortRatings(state.modelRatings);
	}
	state.processedCompletedJobIds.push(payload.jobId);
	await removeTrainingJobFile(config, payload.jobId);
	await removeCompletedTrainingPayload(config, payload.jobId);
	await appendModelLeagueEvent(config, {
		type: "training-completed",
		jobId: payload.jobId,
		source,
		newModelId: payload.newModelId,
	});
}

async function processControlRequest(
	config: ModelLeagueConfig,
	state: ModelLeagueState,
	request: any,
	daemon: ModelLeagueDaemon,
) {
	if (state.processedControlRequestIds.includes(request.id)) return;
	if (request.type === "pause") state.daemon.status = "paused";
	if (request.type === "resume") state.daemon.status = "running";
	if (request.type === "force-benchmark") daemon.requestBenchmark = true;
	if (request.type === "force-snapshot") daemon.requestSnapshot = true;
	if (request.type === "enqueue-training") {
		const checkpoint = request.modelCheckpointId ? getCheckpoint(state, request.modelCheckpointId) :
			[...activeCheckpoints(state)].sort(
				(a, b) =>
					(b.trainingBuffer.matchCount + b.trainingBuffer.exampleCount) -
					(a.trainingBuffer.matchCount + a.trainingBuffer.exampleCount)
			)[0];
		if (checkpoint) await makeTrainingJob(config, state, checkpoint, request.requestedBy);
	}
	state.processedControlRequestIds.push(request.id);
	await archiveControlRequest(config, request.id);
	await appendModelLeagueEvent(config, {
		type: "control-request-processed",
		requestId: request.id,
		requestType: request.type,
	});
}

export class ModelLeagueDaemon {
	private readonly configPath: string;
	private config!: ModelLeagueConfig;
	private state!: ModelLeagueState;
	private timer: NodeJS.Timeout | null = null;
	private done = false;
	private running = false;
	private stopResolve: (() => void) | null = null;
	private stopPromise: Promise<void> | null = null;
	private webhookServer: ModelLeagueCompletionWebhookServer | null = null;
	requestBenchmark = false;
	requestSnapshot = false;

	constructor(options: ModelLeagueDaemonOptions = {}) {
		this.configPath = options.configPath || getDefaultModelLeagueConfigPath();
	}

	private async load() {
		const loaded = loadLeague(this.configPath);
		this.config = loaded.config;
		this.state = loaded.state;
		await ensureModelLeagueDirectories(this.config);
		for (const job of await loadTrainingJobFiles(this.config)) upsertTrainingJob(this.state, job);
		sortRatings(this.state.modelRatings);
		sortRatings(this.state.teamRatings);
	}

	private save() {
		saveModelLeagueState(this.config, this.state);
	}

	private schedule(delayMs: number) {
		if (this.done) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.tick(), delayMs);
	}

	private async startWebhook() {
		if (!this.config.webhooks.inboundTrainingCompleted) return;
		this.webhookServer = new ModelLeagueCompletionWebhookServer(
			this.config,
			async payload => {
				await processCompletion(this.config, this.state, payload, "webhook");
				this.save();
			},
			patch => {
				this.state.daemon.webhook = { ...this.state.daemon.webhook, ...patch };
				this.save();
			},
		);
		await this.webhookServer.start();
	}

	private async stopWebhook() {
		await this.webhookServer?.stop();
		this.webhookServer = null;
	}

	async start() {
		if (this.stopPromise) return this.stopPromise;
		await this.load();
		const settledState = this.state;
		const settledDaemon = settledState.daemon;
		this.running = true;
		this.stopPromise = new Promise<void>(resolve => {
			this.stopResolve = resolve;
		});
		settledDaemon.status = settledDaemon.status === "paused" ? "paused" : "running";
		settledDaemon.pid = process.pid;
		settledDaemon.startedAt = settledDaemon.startedAt || now();
		settledDaemon.heartbeatAt = now();
		await writeActiveModelLeagueConfigPath(this.configPath);
		await this.startWebhook();
		this.save();
		this.schedule(0);
		return this.stopPromise;
	}

	async stop() {
		this.done = true;
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		await this.stopWebhook();
		if (this.state) {
			const settledState = this.state;
			const settledDaemon = settledState.daemon;
			settledDaemon.status = "idle";
			settledDaemon.activeTask = null;
			settledDaemon.heartbeatAt = now();
			this.save();
		}
		this.stopResolve?.();
		this.stopResolve = null;
		this.stopPromise = null;
	}

	private async tick() {
		if (this.done) return;
		try {
			await this.load();
			const settledState = this.state;
			const settledDaemon = settledState.daemon;
			settledDaemon.heartbeatAt = now();
			settledDaemon.lastLoopAt = now();
			settledDaemon.loopCount++;
			await this.processQueues();
			await this.runScheduledWork();
			if (this.state.daemon.status !== "paused") {
				await this.processTrainingEligibility();
			}
			if (this.requestSnapshot) {
				this.requestSnapshot = false;
				await appendModelLeagueEvent(this.config, { type: "snapshot-forced", at: now() });
			}
			this.save();
		} catch (error: any) {
			const settledState = this.state;
			const settledDaemon = settledState.daemon;
			settledDaemon.lastError = error.message || String(error);
			this.save();
		} finally {
			if (!this.done) this.schedule(this.config.scheduler.loopIntervalMs);
		}
	}

	private async processQueues() {
		for (const request of await loadQueuedControlRequests(this.config)) {
			await processControlRequest(this.config, this.state, request, this);
		}
		for (const payload of await loadCompletedTrainingPayloads(this.config)) {
			await processCompletion(this.config, this.state, payload, "disk");
		}
	}

	private async runScheduledWork() {
		if (this.state.daemon.status === "paused") {
			if (this.requestBenchmark) {
				this.requestBenchmark = false;
				await this.runBenchmark();
			}
			return;
		}
		const tasks = Math.max(1, this.config.scheduler.maxConcurrentTasks || 1);
		for (let i = 0; i < tasks; i++) {
			const benchmark = this.requestBenchmark || this.isBenchmarkDue();
			if (benchmark) {
				this.requestBenchmark = false;
				if (await this.runBenchmark()) continue;
			}
			const selection = this.selectMatch();
			if (!selection) break;
			await this.runMatch(selection);
		}
	}

	private isBenchmarkDue() {
		const last = this.state.recentBenchmarkRuns[this.state.recentBenchmarkRuns.length - 1];
		if (!last) return true;
		return Date.now() - Date.parse(last.recordedAt) >= this.config.scheduler.benchmarkIntervalMs;
	}

	private selectMatch(): MatchSelection | null {
		const roll = Math.random();
		const live = this.config.scheduler.liveMatchmakingWeight;
		const hist = this.config.scheduler.archivedMatchmakingWeight;
		let pool: ModelLeagueSchedulerBucket = roll < live ? "live" : roll < live + hist ? "historical" : "exploration";
		if (pool === "historical" && !historicalCheckpoints(this.state).length) pool = "live";
		const rollouts = pool === "historical" ? this.config.scheduler.historicalRollouts : this.config.scheduler.liveRollouts;
		let modelA: ModelLeagueCheckpointState | undefined;
		let modelB: ModelLeagueCheckpointState | undefined;
		if (pool === "live") {
			const checkpoints = activeCheckpoints(this.state);
			modelA = weightedPick(checkpoints) || undefined;
			modelB = modelA ? weightedPick(checkpoints.filter(candidate => candidate.id !== modelA!.id)) || undefined : undefined;
		} else if (pool === "historical") {
			const checkpoints = historicalCheckpoints(this.state);
			modelA = weightedPick(activeCheckpoints(this.state)) || weightedPick(checkpoints) || undefined;
			modelB = modelA ?
				weightedPick(
					(checkpoints.length ? checkpoints : activeCheckpoints(this.state))
						.filter(candidate => candidate.id !== modelA!.id)
				) || undefined :
				undefined;
		} else {
			const checkpoints = activeCheckpoints(this.state)
				.slice()
				.sort((a, b) => (a.matchCount + a.exampleCount) - (b.matchCount + b.exampleCount));
			modelA = checkpoints[0];
			modelB = checkpoints.find(candidate => candidate.id !== modelA!.id);
		}
		if (!modelA || !modelB) return null;
		const teamA = pickTeam(modelA, this.state);
		const teamB = pickTeam(modelB, this.state);
		if (!teamA || !teamB) return null;
		return {
			pool,
			rollouts,
			modelA,
			modelB,
			teamA,
			teamB,
		};
	}

	private async runMatch(selection: MatchSelection) {
		const frontier = captureMatchSettlementFrontier(selection);
		const runner = new ModelLeagueRunner({
			format: this.config.format,
			modelA: {
				id: selection.modelA.id,
				name: selection.modelA.name,
				modelID: selection.modelA.modelID,
				endpoint: selection.modelA.endpoint,
				modelProfile: selection.modelA.modelProfile,
				allowVoluntarySwitches: selection.modelA.allowVoluntarySwitches,
				team: selection.teamA.packedTeam,
				teamId: selection.teamA.id,
			},
			modelB: {
				id: selection.modelB.id,
				name: selection.modelB.name,
				modelID: selection.modelB.modelID,
				endpoint: selection.modelB.endpoint,
				modelProfile: selection.modelB.modelProfile,
				allowVoluntarySwitches: selection.modelB.allowVoluntarySwitches,
				team: selection.teamB.packedTeam,
				teamId: selection.teamB.id,
			},
			rollouts: selection.rollouts,
			sideSwap: this.config.scheduler.sideSwap,
			captureTrainingExamples: this.config.training.enabled,
			trainingExampleOutputDir: "",
		});
		const result = await runner.runBatch();
		const settledState = this.state;
		const settledModelA = requireCheckpointForSettlement(settledState, frontier.modelAId, "modelA");
		const settledModelB = requireCheckpointForSettlement(settledState, frontier.modelBId, "modelB");
		const settledTeamA = requireTeamForSettlement(settledState, frontier.teamAId, "teamA");
		const settledTeamB = requireTeamForSettlement(settledState, frontier.teamBId, "teamB");
		const score = result.batch.modelAWins > result.batch.modelBWins ?
			1 :
			result.batch.modelAWins < result.batch.modelBWins ? 0 : 0.5;
		const modelRatings = applyRatingMatch({
			entries: settledState.modelRatings,
			idA: frontier.modelAId,
			nameA: frontier.modelAName,
			idB: frontier.modelBId,
			nameB: frontier.modelBName,
			scoreA: score,
			now: result.batch.recordedAt,
			config: this.config,
		});
		const teamRatings = applyRatingMatch({
			entries: settledState.teamRatings,
			idA: frontier.teamAId,
			nameA: frontier.teamAName,
			idB: frontier.teamBId,
			nameB: frontier.teamBName,
			scoreA: score,
			now: result.batch.recordedAt,
			config: this.config,
		});
		const examplesForARecords = result.batch.battles.flatMap((battle: any) =>
			battle.trainingExamples.filter((record: any) => record.modelCheckpointId === frontier.modelAId)
		);
		const examplesForBRecords = result.batch.battles.flatMap((battle: any) =>
			battle.trainingExamples.filter((record: any) => record.modelCheckpointId === frontier.modelBId)
		);
		const examplesForA = examplesForARecords.length;
		const examplesForB = examplesForBRecords.length;
		const exampleFiles: Record<string, string | undefined> = {};
		if (examplesForARecords.length) {
			const outputDirA = getModelLeagueTrainingDir(
				this.config,
				joinPath(this.config.training.examplesDir, frontier.pool, frontier.modelAId)
			);
			const outputPathA = joinPath(outputDirA, `${result.batch.batchId}.jsonl`);
			await FS(outputDirA).mkdirp();
			await FS(outputPathA).safeWrite(
				examplesForARecords.map((record: any) => JSON.stringify(record)).join("\n") + "\n"
			);
			exampleFiles[frontier.modelAId] = outputPathA;
		}
		if (examplesForBRecords.length) {
			const outputDirB = getModelLeagueTrainingDir(
				this.config,
				joinPath(this.config.training.examplesDir, frontier.pool, frontier.modelBId)
			);
			const outputPathB = joinPath(outputDirB, `${result.batch.batchId}.jsonl`);
			await FS(outputDirB).mkdirp();
			await FS(outputPathB).safeWrite(
				examplesForBRecords.map((record: any) => JSON.stringify(record)).join("\n") + "\n"
			);
			exampleFiles[frontier.modelBId] = outputPathB;
		}
		settledModelA.matchCount++;
		settledModelB.matchCount++;
		settledTeamA.matchCount++;
		settledTeamB.matchCount++;
		if (frontier.pool === "historical") {
			settledModelA.historicalMatchCount++;
			settledModelB.historicalMatchCount++;
			settledTeamA.historicalMatchCount++;
			settledTeamB.historicalMatchCount++;
			settledState.stats.historicalMatches++;
		} else {
			settledModelA.liveMatchCount++;
			settledModelB.liveMatchCount++;
			settledTeamA.liveMatchCount++;
			settledTeamB.liveMatchCount++;
			settledState.stats.liveMatches++;
		}
		settledModelA.trainingBuffer.matchCount++;
		settledModelB.trainingBuffer.matchCount++;
		settledModelA.trainingBuffer.matchIds.push(result.batch.batchId);
		settledModelB.trainingBuffer.matchIds.push(result.batch.batchId);
		settledModelA.trainingBuffer.exampleCount += examplesForA;
		settledModelB.trainingBuffer.exampleCount += examplesForB;
		if (exampleFiles[frontier.modelAId]) {
			settledModelA.trainingBuffer.exampleFiles.push(exampleFiles[frontier.modelAId]!);
		}
		if (exampleFiles[frontier.modelBId]) {
			settledModelB.trainingBuffer.exampleFiles.push(exampleFiles[frontier.modelBId]!);
		}
		settledModelA.exampleCount += examplesForA;
		settledModelB.exampleCount += examplesForB;
		settledState.stats.decisionExamplesCaptured += examplesForA + examplesForB;
		sortRatings(settledState.modelRatings);
		sortRatings(settledState.teamRatings);
		const summary = createMatchSummary(
			frontier.pool === "historical" ? "historical" : "live",
			frontier.pool,
			result.batch,
			frontier.teamAId,
			frontier.teamBId,
			modelRatings.beforeA,
			modelRatings.afterA,
			modelRatings.beforeB,
			modelRatings.afterB,
			teamRatings.beforeA,
			teamRatings.afterA,
			teamRatings.beforeB,
			teamRatings.afterB,
		);
		summary.exampleFiles = exampleFiles;
		settledState.recentMatches.push(summary);
		settledState.recentMatches = recent(
			settledState.recentMatches,
			this.config.scheduler.recentMatchLimit,
		);
		await appendModelLeagueEvent(this.config, {
			type: "match-completed",
			bucket: frontier.pool,
			modelAId: frontier.modelAId,
			modelBId: frontier.modelBId,
		});
	}

	private async runBenchmark() {
		const progress = this.state.benchmarkProgress.find(candidate => !candidate.cleared) ||
			this.state.benchmarkProgress[this.state.benchmarkProgress.length - 1];
		if (!progress) return false;
		const benchmark = this.config.benchmarks.find(candidate => candidate.id === progress.id);
		if (!benchmark) return false;
		const challenger = this.state.modelRatings
			.slice()
			.sort((a, b) => b.elo - a.elo)
			.map(entry => getCheckpoint(this.state, entry.id))
			.find(candidate => !!candidate?.active && !candidate.archived) ||
			activeCheckpoints(this.state)[0];
		if (!challenger) return false;
		const challengerTeam = pickTeam(challenger, this.state);
		const opponent = getCheckpoint(this.state, benchmark.opponentModelId);
		const opponentTeam = getTeam(this.state, benchmark.opponentTeamId);
		if (!challengerTeam || !opponent || !opponentTeam) return false;
		const frontier = captureBenchmarkSettlementFrontier(
			progress,
			challenger,
			challengerTeam,
			opponent,
			opponentTeam,
		);
		const runner = new ModelLeagueRunner({
			format: this.config.format,
			modelA: {
				id: challenger.id,
				name: challenger.name,
				modelID: challenger.modelID,
				endpoint: challenger.endpoint,
				modelProfile: challenger.modelProfile,
				allowVoluntarySwitches: challenger.allowVoluntarySwitches,
				team: challengerTeam.packedTeam,
				teamId: challengerTeam.id,
			},
			modelB: {
				id: opponent.id,
				name: opponent.name,
				modelID: opponent.modelID,
				endpoint: opponent.endpoint,
				modelProfile: opponent.modelProfile,
				allowVoluntarySwitches: opponent.allowVoluntarySwitches,
				team: opponentTeam.packedTeam,
				teamId: opponentTeam.id,
			},
			rollouts: benchmark.rollouts || this.config.scheduler.benchmarkRolloutsDefault,
			sideSwap: this.config.scheduler.sideSwap,
			captureTrainingExamples: false,
		});
		const result = await runner.runBatch();
		const settledState = this.state;
		const settledProgress = requireBenchmarkProgressForSettlement(
			settledState,
			frontier.benchmarkId,
		);
		const settledChallenger = requireCheckpointForSettlement(
			settledState,
			frontier.challengerModelId,
			"challenger",
		);
		const settledChallengerTeam = requireTeamForSettlement(
			settledState,
			frontier.challengerTeamId,
			"challenger",
		);
		const settledOpponent = requireCheckpointForSettlement(
			settledState,
			frontier.opponentModelId,
			"opponent",
		);
		const settledOpponentTeam = requireTeamForSettlement(
			settledState,
			frontier.opponentTeamId,
			"opponent",
		);
		const cleared = result.batch.winRateA >= (benchmark.requiredWinRate ?? 0.6);
		settledProgress.lastRunAt = result.batch.recordedAt;
		settledProgress.lastChallengerModelId = frontier.challengerModelId;
		settledProgress.lastChallengerTeamId = frontier.challengerTeamId;
		settledProgress.lastWinRate = result.batch.winRateA;
		settledProgress.lastConfidenceLow = result.batch.confidenceLow;
		settledProgress.lastConfidenceHigh = result.batch.confidenceHigh;
		if (cleared) {
			settledProgress.cleared = true;
			settledProgress.clearedAt = result.batch.recordedAt;
		}
		settledChallenger.matchCount++;
		settledOpponent.matchCount++;
		settledChallengerTeam.matchCount++;
		settledOpponentTeam.matchCount++;
		settledChallenger.benchmarkMatchCount++;
		settledOpponent.benchmarkMatchCount++;
		settledChallengerTeam.benchmarkMatchCount++;
		settledOpponentTeam.benchmarkMatchCount++;
		settledState.stats.benchmarkRuns++;
		settledState.recentBenchmarkRuns.push({
			id: result.batch.batchId,
			benchmarkId: frontier.benchmarkId,
			recordedAt: result.batch.recordedAt,
			challengerModelId: frontier.challengerModelId,
			challengerTeamId: frontier.challengerTeamId,
			opponentModelId: frontier.opponentModelId,
			opponentTeamId: frontier.opponentTeamId,
			rollouts: result.batch.rollouts,
			winRate: result.batch.winRateA,
			confidenceLow: result.batch.confidenceLow,
			confidenceHigh: result.batch.confidenceHigh,
			cleared,
			replayPaths: result.batch.replayPaths,
		});
		settledState.recentBenchmarkRuns = recent(
			settledState.recentBenchmarkRuns,
			this.config.scheduler.recentMatchLimit,
		);
		await appendModelLeagueEvent(this.config, {
			type: "benchmark-completed",
			benchmarkId: frontier.benchmarkId,
			cleared,
			winRate: result.batch.winRateA,
		});
		return true;
	}

	private async processTrainingEligibility() {
		const eligible = this.state.checkpoints
			.filter(checkpoint => checkpoint.active && !checkpoint.archived)
			.filter(checkpoint =>
				checkpoint.trainingBuffer.matchCount >= this.config.training.minMatches &&
				checkpoint.trainingBuffer.exampleCount >= this.config.training.minExamples
			)
			.filter(checkpoint =>
				!checkpoint.lastTrainingJobAt ||
				Date.now() - Date.parse(checkpoint.lastTrainingJobAt) >= this.config.training.cooldownMs
			)
			.sort(
				(a, b) =>
					(b.trainingBuffer.matchCount + b.trainingBuffer.exampleCount) -
					(a.trainingBuffer.matchCount + a.trainingBuffer.exampleCount)
			);
		if (!eligible.length) return;
		await makeTrainingJob(this.config, this.state, eligible[0], "daemon");
	}
}

export async function loadModelLeagueDaemonStatus(configPath?: string) {
	const resolvedConfigPath = resolveModelLeagueConfigPath(configPath, { preferActive: true });
	const config = loadModelLeagueConfig(resolvedConfigPath);
	await ensureModelLeagueDirectories(config);
	const state = loadModelLeagueState(config, resolvedConfigPath);
	for (const job of await loadTrainingJobFiles(config)) upsertTrainingJob(state, job);
	const queuedControlRequests = (await loadQueuedControlRequests(config)).length;
	return {
		configPath: resolvedConfigPath,
		statePath: getModelLeagueStatePath(config),
		status: state.daemon.status,
		paused: state.daemon.status === "paused",
		pid: state.daemon.pid,
		loopCount: state.daemon.loopCount,
		heartbeatAt: state.daemon.heartbeatAt,
		lastLoopAt: state.daemon.lastLoopAt,
		lastError: state.daemon.lastError,
		activeTask: state.daemon.activeTask,
		queuedControlRequests,
		trainingJobs: state.trainingJobs.length,
		checkpoints: state.checkpoints.length,
		teams: state.teams.length,
		benchmarkProgress: {
			total: state.benchmarkProgress.length,
			cleared: state.benchmarkProgress.filter(progress => progress.cleared).length,
		},
		stats: state.stats,
		webhook: state.daemon.webhook,
	} satisfies ModelLeagueDaemonStatusReport;
}

export async function runModelLeagueDaemon(options: ModelLeagueDaemonOptions = {}) {
	const daemon = new ModelLeagueDaemon(options);
	await daemon.start();
	return daemon;
}
