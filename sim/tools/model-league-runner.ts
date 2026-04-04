import * as path from "path";
import {FS} from "../../lib";
import {BattleStream, getPlayerStreams, Teams} from "..";
import {PRNG, type PRNGSeed} from "../prng";
import {RLAgentAI, type RLAgentDecisionRecord} from "./rl-agent";
import {parseBooleanOption, resolveRLModelProfileConfig, type RLModelProfileConfig} from "./rl-model-profiles";
import {
	parseReplayCaptureMode,
	saveReplayHtml,
	saveReplayDashboardHtml,
	sanitizeReplayFileSegment,
	shouldCaptureReplay,
	type ReplayDashboardTile,
	type ReplayOutcome,
	type ReplayCaptureMode,
} from "./replay-export";

export type ModelLeagueCompetitorSpec = {
	id: string;
	name: string;
	modelID: string;
	endpoint: string;
	modelProfile: RLModelProfileConfig["profile"] | string;
	allowVoluntarySwitches?: boolean;
	team: string | PokemonSet[];
	teamId?: string;
	metadata?: AnyObject;
};

type NormalizedCompetitor = ModelLeagueCompetitorSpec & {
	packedTeam: string;
	modelProfile: RLModelProfileConfig;
};

export type ModelLeagueRunnerOptions = {
	format: string;
	modelA: ModelLeagueCompetitorSpec;
	modelB: ModelLeagueCompetitorSpec;
	rollouts: number;
	sideSwap?: boolean;
	baseSeed?: PRNGSeed | PRNG | null;
	captureReplays?: boolean;
	replayCaptureMode?: ReplayCaptureMode | string;
	replayCaptureCount?: number;
	replayOutputDir?: string;
	replayGrid?: boolean;
	replayGridFileName?: string;
	replayGridRefreshSeconds?: number;
	replayFilePrefix?: string;
	battleTimeoutMs?: number;
	captureTrainingExamples?: boolean;
	trainingExampleOutputDir?: string;
	onReplaySaved?: (info: {battleId: string; replayPath: string; outcome: ReplayOutcome}) => void;
};

export type ModelLeagueBattleResult = {
	battleId: string;
	seed: PRNGSeed;
	winner: "p1" | "p2" | "tie" | "unknown";
	turns: number;
	switches: {p1: number; p2: number};
	forcedDrags: number;
	replayLog: string;
	p1: NormalizedCompetitor;
	p2: NormalizedCompetitor;
	trainingExamples: RLAgentDecisionRecord[];
};

export type ModelLeagueBatchResult = {
	batchId: string;
	recordedAt: string;
	format: string;
	rollouts: number;
	sideSwap: boolean;
	modelA: NormalizedCompetitor;
	modelB: NormalizedCompetitor;
	modelAWins: number;
	modelBWins: number;
	ties: number;
	winRateA: number;
	confidenceLow: number;
	confidenceHigh: number;
	replayPaths: string[];
	battles: ModelLeagueBattleResult[];
};

export type ModelLeagueRunnerOutput = {
	batches: ModelLeagueBatchResult[];
	batch: ModelLeagueBatchResult;
};

function now() {
	return new Date().toISOString();
}

function normalizeTeam(team: string | PokemonSet[]) {
	return typeof team === "string" ? team : Teams.pack(team);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function makeModelProfileConfig(profile: string, allowVoluntarySwitches?: boolean) {
	return resolveRLModelProfileConfig(profile, allowVoluntarySwitches);
}

function createBattleTimeoutError(battleId: string, timeoutMs: number) {
	return new Error(`Battle ${battleId} timed out after ${timeoutMs}ms.`);
}

function createBattleResultOutcome(winner: string | null, p1Name: string, p2Name: string) {
	if (winner === p1Name) return "p1" as const;
	if (winner === p2Name) return "p2" as const;
	if (winner === "tie") return "tie" as const;
	return "unknown" as const;
}

function formatDurationMs(durationMs: number): string {
	if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(2)} min`;
	if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)} s`;
	return `${durationMs.toFixed(2)} ms`;
}

function buildConfidenceInterval(wins: number, total: number) {
	if (!total) return {low: 0, high: 0};
	const z = 1.96;
	const p = wins / total;
	const denominator = 1 + (z * z) / total;
	const centre = p + (z * z) / (2 * total);
	const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
	return {
		low: Math.max(0, (centre - margin) / denominator),
		high: Math.min(1, (centre + margin) / denominator),
	};
}

function buildTrainingExamplePath(outputDir: string, battleId: string) {
	return path.join(outputDir, `${sanitizeReplayFileSegment(battleId)}.jsonl`);
}

async function appendDecisionRecords(outputDir: string, battleId: string, records: RLAgentDecisionRecord[]) {
	if (!records.length) return;
	const filePath = buildTrainingExamplePath(outputDir, battleId);
	const content = records.map(record => JSON.stringify(record)).join("\n") + "\n";
	await FS(outputDir).mkdirp();
	await FS(filePath).append(content);
}

export class ModelLeagueRunner {
	private readonly options: Required<Pick<ModelLeagueRunnerOptions, "format" | "rollouts">> & ModelLeagueRunnerOptions;
	private readonly prng: PRNG;
	private readonly replayDashboardTiles: ReplayDashboardTile[] = [];
	private readonly captureMode: ReplayCaptureMode;
	private readonly replayCaptureCount: number;
	private savedReplays = 0;

	constructor(options: ModelLeagueRunnerOptions) {
		this.options = {
			...options,
			sideSwap: options.sideSwap ?? true,
			captureReplays: options.captureReplays ?? false,
			replayCaptureMode: parseReplayCaptureMode(options.replayCaptureMode ? String(options.replayCaptureMode) : undefined),
			replayCaptureCount: options.replayCaptureCount ?? 0,
			replayOutputDir: options.replayOutputDir || "logs/model-league/replays",
			replayGrid: options.replayGrid ?? false,
			replayGridFileName: options.replayGridFileName || "model-league-grid.html",
			replayGridRefreshSeconds: options.replayGridRefreshSeconds ?? 2,
			replayFilePrefix: options.replayFilePrefix || "model-league",
			captureTrainingExamples: options.captureTrainingExamples ?? false,
			trainingExampleOutputDir: options.trainingExampleOutputDir || "",
		};
		this.prng = PRNG.get(options.baseSeed ?? null);
		this.captureMode = parseReplayCaptureMode(this.options.replayCaptureMode ? String(this.options.replayCaptureMode) : undefined);
		this.replayCaptureCount = this.options.replayCaptureCount || 0;
	}

	async runBatch(): Promise<ModelLeagueRunnerOutput> {
		const batch = await this.runRolloutBatch({
			batchId: this.newBatchId(),
			rollouts: this.options.rollouts,
		});
		return {batches: [batch], batch};
	}

	async runRolloutBatch(input: {batchId: string; rollouts: number}): Promise<ModelLeagueBatchResult> {
		const modelA = this.normalizeCompetitor(this.options.modelA);
		const modelB = this.normalizeCompetitor(this.options.modelB);
		const battles: ModelLeagueBattleResult[] = [];
		let modelAWins = 0;
		let modelBWins = 0;
		let ties = 0;
		const replayPaths: string[] = [];

		if (this.options.replayGrid) {
			this.updateReplayDashboard();
		}

		for (let i = 0; i < input.rollouts; i++) {
			const battleId = `${input.batchId}-battle-${i + 1}`;
			const battleSeed = this.newSeed();
			const swapped = !!this.options.sideSwap && (i % 2 === 1);
			const p1 = swapped ? modelB : modelA;
			const p2 = swapped ? modelA : modelB;
			const battle = await this.runSingleBattle({
				battleId,
				seed: battleSeed,
				p1,
				p2,
				captureTrainingExamples: this.options.captureTrainingExamples,
			});
			battles.push(battle);
			const modelAOutcome = this.scoreBattleForModel(battle, modelA.id);
			if (modelAOutcome === 1) modelAWins++;
			else if (modelAOutcome === 0) modelBWins++;
			else ties++;

			const replayOutcome = modelAOutcome === 1 ? "win" : modelAOutcome === 0 ? "loss" : "tie";
			const shouldSaveReplay = this.options.captureReplays && this.shouldCaptureReplay(replayOutcome);
			if (shouldSaveReplay) {
				const replayPath = this.saveReplay(battle, input.batchId, replayOutcome, modelA.name, modelB.name, i + 1);
				if (replayPath) {
					replayPaths.push(replayPath);
					this.options.onReplaySaved?.({battleId, replayPath, outcome: replayOutcome});
				}
			}

			if (this.options.captureTrainingExamples && this.options.trainingExampleOutputDir) {
				await appendDecisionRecords(this.options.trainingExampleOutputDir, battleId, battle.trainingExamples);
			}
		}

		const total = battles.length || 1;
		const scoredWins = modelAWins + ties * 0.5;
		const confidence = buildConfidenceInterval(scoredWins, total);
		const batch: ModelLeagueBatchResult = {
			batchId: input.batchId,
			recordedAt: now(),
			format: this.options.format,
			rollouts: input.rollouts,
			sideSwap: !!this.options.sideSwap,
			modelA,
			modelB,
			modelAWins,
			modelBWins,
			ties,
			winRateA: scoredWins / total,
			confidenceLow: confidence.low,
			confidenceHigh: confidence.high,
			replayPaths,
			battles,
		};
		return batch;
	}

	private normalizeCompetitor(competitor: ModelLeagueCompetitorSpec): NormalizedCompetitor {
		return {
			...competitor,
			modelProfile: makeModelProfileConfig(String(competitor.modelProfile), competitor.allowVoluntarySwitches),
			packedTeam: normalizeTeam(competitor.team),
		};
	}

	private async runSingleBattle(options: {
		battleId: string;
		seed: PRNGSeed;
		p1: NormalizedCompetitor;
		p2: NormalizedCompetitor;
		captureTrainingExamples: boolean;
	}): Promise<ModelLeagueBattleResult> {
		const battleStream = new BattleStream();
		const streams = getPlayerStreams(battleStream);
		const spec = {formatid: this.options.format, seed: options.seed};
		const p1Records: RLAgentDecisionRecord[] = [];
		const p2Records: RLAgentDecisionRecord[] = [];
		const p1 = new RLAgentAI(streams.p1, {
			endpoint: options.p1.endpoint,
			modelID: options.p1.modelID,
			modelProfile: options.p1.modelProfile.profile,
			allowVoluntarySwitches: options.p1.modelProfile.allowVoluntarySwitches,
			onDecision: record => p1Records.push({
				...record,
				modelCheckpointId: options.p1.id,
				battleId: options.battleId,
				format: this.options.format,
				seed: options.seed,
				teamId: options.p1.teamId,
				opponentModelId: options.p2.id,
				opponentTeamId: options.p2.teamId,
			}),
		});
		const p2 = new RLAgentAI(streams.p2, {
			endpoint: options.p2.endpoint,
			modelID: options.p2.modelID,
			modelProfile: options.p2.modelProfile.profile,
			allowVoluntarySwitches: options.p2.modelProfile.allowVoluntarySwitches,
			onDecision: record => p2Records.push({
				...record,
				modelCheckpointId: options.p2.id,
				battleId: options.battleId,
				format: this.options.format,
				seed: options.seed,
				teamId: options.p2.teamId,
				opponentModelId: options.p1.id,
				opponentTeamId: options.p1.teamId,
			}),
		});

		void p1.start();
		void p2.start();

		const p1spec = {name: options.p1.name, team: options.p1.packedTeam};
		const p2spec = {name: options.p2.name, team: options.p2.packedTeam};

		let winner: string | null = null;
		let forcedDrags = 0;
		let turnCount = 0;
		const replayLogLines: string[] = [];
		const seenOpeningSendout: Record<"p1" | "p2", boolean> = {p1: false, p2: false};
		const switches: Record<"p1" | "p2", number> = {p1: 0, p2: 0};

		const battleLoop = (async () => {
			for await (const chunk of streams.omniscient) {
				for (const rawLine of chunk.split("\n")) {
					if (rawLine) replayLogLines.push(rawLine);
					const line = rawLine.trim();
					if (!line) continue;
					const switchMatch = line.match(/^\|switch\|(p[12])a:/);
					if (switchMatch) {
						const side = switchMatch[1] as "p1" | "p2";
						if (!seenOpeningSendout[side]) {
							seenOpeningSendout[side] = true;
							continue;
						}
						switches[side]++;
						continue;
					}
					const dragMatch = line.match(/^\|drag\|(p[12])a:/);
					if (dragMatch) {
						const side = dragMatch[1] as "p1" | "p2";
						forcedDrags++;
						switches[side]++;
						continue;
					}
					const winMatch = line.match(/^\|win\|(.*)/);
					if (winMatch) winner = winMatch[1].trim();
					const turnMatch = line.match(/^\|turn\|(\d+)/);
					if (turnMatch) turnCount = Math.max(turnCount, Number(turnMatch[1]));
				}
			}
		})();

		const battlePromise = (async () => {
			await streams.omniscient.write(
				`>start ${JSON.stringify(spec)}\n` +
				`>player p1 ${JSON.stringify(p1spec)}\n` +
				`>player p2 ${JSON.stringify(p2spec)}`
			);
			await battleLoop;
			return {
				battleId: options.battleId,
				seed: options.seed,
				winner: createBattleResultOutcome(winner, options.p1.name, options.p2.name),
				turns: turnCount,
				switches,
				forcedDrags,
				replayLog: replayLogLines.join("\n"),
				p1: options.p1,
				p2: options.p2,
				trainingExamples: [...p1Records, ...p2Records],
			};
		})();

		const timeoutMs = this.options.battleTimeoutMs || 180_000;
		let timeoutHandle: NodeJS.Timeout | null = null;
		const timeoutPromise = new Promise<ModelLeagueBattleResult>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				void streams.omniscient.writeEnd();
				reject(createBattleTimeoutError(options.battleId, timeoutMs));
			}, timeoutMs);
		});

		let streamClosed = false;
		const closeBattleStream = () => {
			if (streamClosed) return;
			streamClosed = true;
			p1.stop();
			p2.stop();
			void streams.omniscient.writeEnd();
		};

		try {
			const result = await Promise.race([battlePromise, timeoutPromise]);
			this.markDecisionResults(result.trainingExamples, result.winner, options.p1.id, options.p2.id);
			if (this.options.captureTrainingExamples) {
				return result;
			}
			return {...result, trainingExamples: []};
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			closeBattleStream();
		}
	}

	private markDecisionResults(records: RLAgentDecisionRecord[], winner: "p1" | "p2" | "tie" | "unknown", p1Id: string, p2Id: string) {
		for (const record of records) {
			if (winner === "tie") {
				record.result = "tie";
				continue;
			}
			if (winner === "unknown") {
				record.result = "error";
				continue;
			}
			const winnerId = winner === "p1" ? p1Id : p2Id;
			record.result = record.modelCheckpointId === winnerId ? "win" : "loss";
		}
	}

	private scoreBattleForModel(battle: ModelLeagueBattleResult, modelId: string) {
		if (battle.winner === "tie") return 0.5;
		if (battle.winner === "unknown") return 0.5;
		const winnerId = battle.winner === "p1" ? battle.p1.id : battle.p2.id;
		return winnerId === modelId ? 1 : 0;
	}

	private shouldCaptureReplay(outcome: ReplayOutcome) {
		if (!this.options.captureReplays) return false;
		return shouldCaptureReplay(this.captureMode, outcome);
	}

	private saveReplay(
		battle: ModelLeagueBattleResult,
		batchId: string,
		outcome: ReplayOutcome,
		modelAName: string,
		modelBName: string,
		index: number,
	) {
		if (!this.options.replayOutputDir) return "";
		if (this.replayCaptureCount && this.savedReplays >= this.replayCaptureCount) return "";
		const fileStem = [
			this.options.replayFilePrefix,
			sanitizeReplayFileSegment(batchId),
			`battle-${index}`,
			outcome,
			sanitizeReplayFileSegment(modelAName),
			"vs",
			sanitizeReplayFileSegment(modelBName),
		].join("-");
		const filePath = saveReplayHtml({
			outputDir: this.options.replayOutputDir,
			fileStem,
			battleLog: battle.replayLog,
			title: `${modelAName} vs ${modelBName} - ${batchId}`,
			autoplayMuted: true,
		});
		this.savedReplays++;
		if (this.options.replayGrid) {
			this.replayDashboardTiles.push({
				slot: index,
				label: `Battle ${index}`,
				title: `${modelAName} vs ${modelBName}`,
				subtitle: `Outcome: ${outcome}`,
				fileName: path.basename(filePath),
				status: "completed",
			});
			this.updateReplayDashboard();
		}
		return filePath;
	}

	private updateReplayDashboard() {
		if (!this.options.replayGrid) return;
		saveReplayDashboardHtml({
			outputDir: this.options.replayOutputDir || "logs/model-league/replays",
			fileName: this.options.replayGridFileName || "model-league-grid.html",
			title: "Model League Replay Grid",
			tiles: this.replayDashboardTiles,
			refreshSeconds: this.options.replayGridRefreshSeconds || 2,
		});
	}

	private newSeed(): PRNGSeed {
		return [
			this.prng.random(2 ** 16),
			this.prng.random(2 ** 16),
			this.prng.random(2 ** 16),
			this.prng.random(2 ** 16),
		].join(",") as PRNGSeed;
	}

	private newBatchId() {
		return `model-league-${Date.now()}-${this.prng.random(1_000_000)}`;
	}
}
