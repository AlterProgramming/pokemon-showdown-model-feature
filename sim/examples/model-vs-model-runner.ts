import * as path from "path";
import {BattleStream, getPlayerStreams, Teams} from "..";
import {getRLAgentMetrics, resetRLAgentMetrics, RLAgentAI} from "../tools/rl-agent";
import {parseBooleanOption, resolveRLModelProfileConfig, type RLModelProfileConfig} from "../tools/rl-model-profiles";
import {
	parseReplayCaptureMode,
	saveReplayHtml,
	saveReplayDashboardHtml,
	sanitizeReplayFileSegment,
	shouldCaptureReplay,
	type ReplayDashboardTile,
	type ReplayOutcome,
} from "../tools/replay-export";

type CompetitorKey = "modelA" | "modelB";
type BattleSide = "p1" | "p2";

type CompetitorConfig = {
	key: CompetitorKey;
	name: string;
	modelID: string;
	endpoint: string;
	profile: RLModelProfileConfig;
};

type BattleAssignment = {
	p1: CompetitorConfig;
	p2: CompetitorConfig;
};

type BattleResult = {
	winnerKey: CompetitorKey | "tie" | "unknown";
	switches: Record<CompetitorKey, number>;
	forcedDrags: number;
	turns: number;
	assignment: BattleAssignment;
	replayLog: string;
};

const TOTAL_GAMES = Number(process.env.TOTAL_GAMES || 20);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const BATTLE_TIMEOUT_MS = Number(process.env.BATTLE_TIMEOUT_MS || 180_000);
const MAX_FAILED_GAMES = Number(process.env.MAX_FAILED_GAMES || 10);
const REPLAY_CAPTURE_MODE = parseReplayCaptureMode(process.env.REPLAY_CAPTURE_MODE);
const REPLAY_CAPTURE_COUNT = Number(process.env.REPLAY_CAPTURE_COUNT || 0);
const REPLAY_OUTPUT_DIR = process.env.REPLAY_OUTPUT_DIR || "logs/replays";
const REPLAY_GRID = parseBooleanOption(process.env.REPLAY_GRID) ?? false;
const REPLAY_GRID_REFRESH_SECONDS = Number(process.env.REPLAY_GRID_REFRESH_SECONDS || 2);
const REPLAY_GRID_FILE_NAME = process.env.REPLAY_GRID_FILE_NAME || "model-vs-model-grid.html";
const DEFAULT_ENDPOINT = process.env.MODEL_SERVER_ENDPOINT || "http://127.0.0.1:5000/predict";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15_000);
const activeBattleAborters = new Map<number, (reason?: string) => void>();
const replayDashboardTiles: ReplayDashboardTile[] = [];

function getEndpoint(prefix: "MODEL_A" | "MODEL_B"): string {
	return process.env[`${prefix}_ENDPOINT`] || DEFAULT_ENDPOINT;
}

function resolveCompetitor(prefix: "MODEL_A" | "MODEL_B", key: CompetitorKey, defaults: {
	name: string;
	modelID: string;
	profile: string;
}): CompetitorConfig {
	const allowOverride = parseBooleanOption(process.env[`${prefix}_ALLOW_VOLUNTARY_SWITCHES`]);
	const profile = resolveRLModelProfileConfig(process.env[`${prefix}_PROFILE`] || defaults.profile, allowOverride);
	return {
		key,
		name: process.env[`${prefix}_NAME`] || defaults.name,
		modelID: process.env[`${prefix}_ID`] || defaults.modelID,
		endpoint: getEndpoint(prefix),
		profile,
	};
}

const MODEL_A = resolveCompetitor("MODEL_A", "modelA", {
	name: "Model1",
	modelID: "model1",
	profile: "move-only",
});

const MODEL_B = resolveCompetitor("MODEL_B", "modelB", {
	name: "Model2",
	modelID: "model2",
	profile: "joint-policy",
});

function assignmentForGame(gameNumber: number): BattleAssignment {
	const swapSides = gameNumber % 2 === 0;
	return swapSides ? {p1: MODEL_B, p2: MODEL_A} : {p1: MODEL_A, p2: MODEL_B};
}

function formatDurationMs(durationMs: number): string {
	if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(2)} min`;
	if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)} s`;
	return `${durationMs.toFixed(2)} ms`;
}

function createBattleTimeoutError(gameNumber: number): Error {
	return new Error(`Battle ${gameNumber} timed out after ${formatDurationMs(BATTLE_TIMEOUT_MS)}.`);
}

function createBattleAbortedError(gameNumber: number, reason: string): Error {
	const error = new Error(`Battle ${gameNumber} aborted: ${reason}`);
	error.name = "BattleAbortedError";
	return error;
}

function createInterruptAbortError(message: string): Error {
	const error = new Error(message);
	error.name = "InterruptAbortError";
	return error;
}

function isBattleTimeoutError(error: unknown): boolean {
	return error instanceof Error && /timed out/i.test(error.message);
}

function isBattleAbortedError(error: unknown): boolean {
	return error instanceof Error && error.name === "BattleAbortedError";
}

function isInterruptAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "InterruptAbortError";
}

async function runSingleBattle(gameNumber: number): Promise<BattleResult> {
	const assignment = assignmentForGame(gameNumber);
	const battleStream = new BattleStream();
	const streams = getPlayerStreams(battleStream);

	const spec = {formatid: "gen9randombattle"};
	const p1spec = {
		name: `${assignment.p1.name} (${assignment.p1.modelID})`,
		team: Teams.pack(Teams.generate("gen9randombattle")),
	};
	const p2spec = {
		name: `${assignment.p2.name} (${assignment.p2.modelID})`,
		team: Teams.pack(Teams.generate("gen9randombattle")),
	};

	const p1 = new RLAgentAI(streams.p1, {
		endpoint: assignment.p1.endpoint,
		modelID: assignment.p1.modelID,
		modelProfile: assignment.p1.profile.profile,
		allowVoluntarySwitches: assignment.p1.profile.allowVoluntarySwitches,
	});
	const p2 = new RLAgentAI(streams.p2, {
		endpoint: assignment.p2.endpoint,
		modelID: assignment.p2.modelID,
		modelProfile: assignment.p2.profile.profile,
		allowVoluntarySwitches: assignment.p2.profile.allowVoluntarySwitches,
	});

	void p1.start();
	void p2.start();

	let winner: string | null = null;
	let forcedDrags = 0;
	let turnCount = 0;
	const replayLogLines: string[] = [];
	const seenOpeningSendout: Record<BattleSide, boolean> = {p1: false, p2: false};
	const switches: Record<CompetitorKey, number> = {modelA: 0, modelB: 0};
	const sideToKey: Record<BattleSide, CompetitorKey> = {
		p1: assignment.p1.key,
		p2: assignment.p2.key,
	};

	const battleLoop = (async () => {
		for await (const chunk of streams.omniscient) {
			for (const rawLine of chunk.split("\n")) {
				if (rawLine) replayLogLines.push(rawLine);
				const line = rawLine.trim();
				if (!line) continue;

				const switchMatch = line.match(/^\|switch\|(p[12])a:/);
				if (switchMatch) {
					const side = switchMatch[1] as BattleSide;
					if (!seenOpeningSendout[side]) {
						seenOpeningSendout[side] = true;
						continue;
					}
					switches[sideToKey[side]]++;
					continue;
				}

				const dragMatch = line.match(/^\|drag\|(p[12])a:/);
				if (dragMatch) {
					const side = dragMatch[1] as BattleSide;
					forcedDrags++;
					switches[sideToKey[side]]++;
					continue;
				}

				const winMatch = line.match(/^\|win\|(.*)/);
				if (winMatch) winner = winMatch[1].trim();

				const turnMatch = line.match(/^\|turn\|(\d+)/);
				if (turnMatch) {
					turnCount = Math.max(turnCount, Number(turnMatch[1]));
				}
			}
		}
	})();

	const battlePromise = (async () => {
		await streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);

		await battleLoop;

		let winnerKey: BattleResult["winnerKey"] = "unknown";
		if (winner === p1spec.name) winnerKey = assignment.p1.key;
		else if (winner === p2spec.name) winnerKey = assignment.p2.key;
		else if (winner === "tie") winnerKey = "tie";

		return {
			winnerKey,
			switches,
			forcedDrags,
			turns: turnCount,
			assignment,
			replayLog: replayLogLines.join("\n"),
		};
	})();

	let streamClosed = false;
	function closeBattleStream() {
		if (streamClosed) return;
		streamClosed = true;
		p1.stop();
		p2.stop();
		void streams.omniscient.writeEnd();
	}

	const abortPromise = new Promise<BattleResult>((_, reject) => {
		const abortBattle = (reason = "aborted by user interrupt") => {
			closeBattleStream();
			reject(createBattleAbortedError(gameNumber, reason));
		};
		activeBattleAborters.set(gameNumber, abortBattle);
	});

	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<BattleResult>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			closeBattleStream();
			reject(createBattleTimeoutError(gameNumber));
		}, BATTLE_TIMEOUT_MS);
	});

	try {
		return await Promise.race([battlePromise, timeoutPromise, abortPromise]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		activeBattleAborters.delete(gameNumber);
		closeBattleStream();
	}
}

const experimentStartedAt = Date.now();
let completed = 0;
let failed = 0;
let timedOut = 0;
let ties = 0;
let forcedDrags = 0;
let totalTurns = 0;
let savedReplays = 0;
let stopRequested = false;
let hardStopRequested = false;
let interruptCount = 0;
let fatalError: Error | null = null;
const wins: Record<CompetitorKey, number> = {modelA: 0, modelB: 0};
const switches: Record<CompetitorKey, number> = {modelA: 0, modelB: 0};
const seatGames: Record<CompetitorKey, Record<BattleSide, number>> = {
	modelA: {p1: 0, p2: 0},
	modelB: {p1: 0, p2: 0},
};
const seatWins: Record<CompetitorKey, Record<BattleSide, number>> = {
	modelA: {p1: 0, p2: 0},
	modelB: {p1: 0, p2: 0},
};

function printCompetitorConfig(label: string, competitor: CompetitorConfig) {
	console.log(`${label}: ${competitor.name}`);
	console.log(`  Model ID: ${competitor.modelID}`);
	console.log(`  Profile: ${competitor.profile.profile}`);
	console.log(`  Voluntary Switches: ${competitor.profile.allowVoluntarySwitches ? "yes" : "no"}`);
	console.log(`  Endpoint: ${competitor.endpoint}`);
}

function printStats() {
	const elapsedMs = Date.now() - experimentStartedAt;
	const agentMetrics = getRLAgentMetrics();

	console.log("\n===== HEAD-TO-HEAD RESULTS =====");
	console.log(`Configured Games: ${TOTAL_GAMES}`);
	console.log(`Configured Concurrency: ${CONCURRENCY}`);
	console.log(`Battle Timeout: ${formatDurationMs(BATTLE_TIMEOUT_MS)}`);
	console.log(`Max Failed Games Before Stop: ${MAX_FAILED_GAMES}`);
	console.log(`Replay Capture Mode: ${REPLAY_CAPTURE_MODE}`);
	console.log(`Replay Capture Limit: ${REPLAY_CAPTURE_COUNT}`);
	console.log(`Saved Replays: ${savedReplays}`);
	printCompetitorConfig("Model A", MODEL_A);
	printCompetitorConfig("Model B", MODEL_B);
	console.log(`Completed Games: ${completed}`);
	console.log(`Model A Wins: ${wins.modelA}`);
	console.log(`Model B Wins: ${wins.modelB}`);
	console.log(`Ties: ${ties}`);
	console.log(`Failed Games: ${failed}`);
	console.log(`Timed Out Games: ${timedOut}`);
	console.log(`Model A Switches: ${switches.modelA}`);
	console.log(`Model B Switches: ${switches.modelB}`);
	console.log(`Forced Drag Switches: ${forcedDrags}`);
	console.log(`Total Turns: ${totalTurns}`);
	console.log(`Elapsed Wall Time: ${formatDurationMs(elapsedMs)}`);

	if (completed > 0) {
		console.log(`Model A Win Rate: ${((wins.modelA / completed) * 100).toFixed(2)}%`);
		console.log(`Model B Win Rate: ${((wins.modelB / completed) * 100).toFixed(2)}%`);
		console.log(`Avg Model A Switches/Game: ${(switches.modelA / completed).toFixed(2)}`);
		console.log(`Avg Model B Switches/Game: ${(switches.modelB / completed).toFixed(2)}`);
		console.log(`Avg Turns/Battle: ${(totalTurns / completed).toFixed(2)}`);
		console.log(`Avg Wall Time/Game: ${formatDurationMs(elapsedMs / completed)}`);
		console.log(`Throughput: ${((completed / elapsedMs) * 60_000).toFixed(2)} games/min`);
	}

	console.log(`Model A Games as p1/p2: ${seatGames.modelA.p1}/${seatGames.modelA.p2}`);
	console.log(`Model B Games as p1/p2: ${seatGames.modelB.p1}/${seatGames.modelB.p2}`);
	console.log(`Model A Wins as p1/p2: ${seatWins.modelA.p1}/${seatWins.modelA.p2}`);
	console.log(`Model B Wins as p1/p2: ${seatWins.modelB.p1}/${seatWins.modelB.p2}`);

	if (agentMetrics.decisions.count > 0) {
		console.log(`Combined RL Decisions: ${agentMetrics.decisions.count}`);
		console.log(
			`Avg Decision Time: ${agentMetrics.decisions.avgMs.toFixed(2)} ms ` +
			`(p95 ${agentMetrics.decisions.p95Ms.toFixed(2)} ms, max ${agentMetrics.decisions.maxMs.toFixed(2)} ms)`
		);
	}
	if (agentMetrics.stateVectorBuilds.count > 0) {
		console.log(
			`Avg State Vector Build: ${agentMetrics.stateVectorBuilds.avgMs.toFixed(2)} ms ` +
			`(p95 ${agentMetrics.stateVectorBuilds.p95Ms.toFixed(2)} ms, max ${agentMetrics.stateVectorBuilds.maxMs.toFixed(2)} ms)`
		);
	}
	if (agentMetrics.modelRequests.count > 0) {
		console.log(`Combined Model Requests: ${agentMetrics.modelRequests.count}`);
		console.log(
			`Avg Model Request Latency: ${agentMetrics.modelRequests.avgMs.toFixed(2)} ms ` +
			`(p95 ${agentMetrics.modelRequests.p95Ms.toFixed(2)} ms, max ${agentMetrics.modelRequests.maxMs.toFixed(2)} ms)`
		);
		console.log(
			`Cumulative Model Request Time: ${formatDurationMs(agentMetrics.modelRequests.totalMs)} across concurrent battles`
		);
		console.log(
			`Model Request Outcomes: ${agentMetrics.modelRequestSuccesses} succeeded, ` +
			`${agentMetrics.modelRequestFailures} failed`
		);
	}
	console.log("Switch totals exclude the initial opening send-outs.");
	console.log("================================\n");
}

function printHeartbeat(runningGames: number) {
	const elapsedMs = Date.now() - experimentStartedAt;
	console.log(
		`[heartbeat] completed=${completed}/${TOTAL_GAMES} failed=${failed} ` +
		`running=${runningGames} elapsed=${formatDurationMs(elapsedMs)}`
	);
}

function requestStop(message: string) {
	if (stopRequested) return;
	console.log(message);
	stopRequested = true;
}

function abortActiveBattles(reason: string) {
	const activeGames = [...activeBattleAborters.keys()].sort((a, b) => a - b);
	if (activeGames.length) {
		console.log(`[interrupt] Aborting active games: ${activeGames.join(", ")}`);
	}
	for (const abortBattle of activeBattleAborters.values()) {
		abortBattle(reason);
	}
}

function requestHardStop(message: string) {
	if (hardStopRequested) return;
	console.log(message);
	hardStopRequested = true;
	stopRequested = true;
	if (!fatalError) {
		fatalError = createInterruptAbortError("Interrupted by user. Active battles were aborted.");
	}
	abortActiveBattles("aborted by second user interrupt");
}

function replayOutcomeForResult(result: BattleResult): ReplayOutcome {
	if (result.winnerKey === "modelA") return "win";
	if (result.winnerKey === "modelB") return "loss";
	return "tie";
}

function updateReplayDashboard() {
	if (!REPLAY_GRID) return;
	saveReplayDashboardHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileName: REPLAY_GRID_FILE_NAME,
		title: `${MODEL_A.name} vs ${MODEL_B.name} Replay Grid`,
		tiles: replayDashboardTiles,
		refreshSeconds: REPLAY_GRID_REFRESH_SECONDS,
	});
}

function addReplayToDashboard(gameNumber: number, outcome: ReplayOutcome, replayPath: string) {
	if (!REPLAY_GRID) return;
	replayDashboardTiles.push({
		slot: gameNumber,
		label: `Game ${gameNumber}`,
		title: `${MODEL_A.name} vs ${MODEL_B.name}`,
		subtitle: `Outcome: ${outcome}`,
		fileName: path.basename(replayPath),
		status: "completed",
	});
	updateReplayDashboard();
}

function saveReplayForGrid(gameNumber: number, result: BattleResult) {
	if (!REPLAY_GRID) return;
	const outcome = replayOutcomeForResult(result);
	const fileStem = [
		"model-vs-model",
		`game-${gameNumber}`,
		outcome,
		sanitizeReplayFileSegment(MODEL_A.modelID),
		"vs",
		sanitizeReplayFileSegment(MODEL_B.modelID),
	].join("-");
	const replayPath = saveReplayHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileStem,
		battleLog: result.replayLog,
		title: `${MODEL_A.name} vs ${MODEL_B.name} - Game ${gameNumber}`,
		autoplayMuted: true,
	});
	addReplayToDashboard(gameNumber, outcome, replayPath);
}

function maybeSaveReplay(gameNumber: number, result: BattleResult) {
	if (!REPLAY_CAPTURE_COUNT || savedReplays >= REPLAY_CAPTURE_COUNT) return;
	const outcome = replayOutcomeForResult(result);
	if (!shouldCaptureReplay(REPLAY_CAPTURE_MODE, outcome)) return;
	const fileStem = [
		"model-vs-model",
		`game-${gameNumber}`,
		outcome,
		sanitizeReplayFileSegment(MODEL_A.modelID),
		"vs",
		sanitizeReplayFileSegment(MODEL_B.modelID),
	].join("-");
	const replayPath = saveReplayHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileStem,
		battleLog: result.replayLog,
		title: `${MODEL_A.name} vs ${MODEL_B.name} - Game ${gameNumber}`,
	});
	savedReplays++;
	console.log(`[replay] Saved ${outcome} replay: ${replayPath}`);
}

process.on("SIGINT", () => {
	interruptCount++;
	if (interruptCount === 1) {
		requestStop("\nInterrupt received. Finishing running games... Press Ctrl+C again to abort running games immediately.");
		if (!activeBattleAborters.size && !fatalError) {
			fatalError = createInterruptAbortError("Interrupted by user.");
		}
		return;
	}
	requestHardStop("\nSecond interrupt received. Aborting running games now...");
});

async function runExperiment() {
	resetRLAgentMetrics();
	if (REPLAY_GRID) {
		updateReplayDashboard();
		console.log(`[replay-grid] Dashboard: ${path.resolve(REPLAY_OUTPUT_DIR, REPLAY_GRID_FILE_NAME)}`);
	}
	let runningGames = 0;
	const heartbeatHandle = setInterval(() => {
		printHeartbeat(runningGames);
	}, HEARTBEAT_INTERVAL_MS);

	async function worker(gameNumber: number) {
		if (stopRequested) return;
		runningGames++;
		console.log(`[battle] Starting game ${gameNumber}`);

		try {
			const result = await runSingleBattle(gameNumber);

			completed++;
			switches.modelA += result.switches.modelA;
			switches.modelB += result.switches.modelB;
			forcedDrags += result.forcedDrags;
			totalTurns += result.turns;
			saveReplayForGrid(gameNumber, result);
			maybeSaveReplay(gameNumber, result);
			seatGames[result.assignment.p1.key].p1++;
			seatGames[result.assignment.p2.key].p2++;

			if (result.winnerKey === "modelA" || result.winnerKey === "modelB") {
				wins[result.winnerKey]++;
				if (result.assignment.p1.key === result.winnerKey) {
					seatWins[result.winnerKey].p1++;
				} else if (result.assignment.p2.key === result.winnerKey) {
					seatWins[result.winnerKey].p2++;
				}
			} else {
				ties++;
			}

			console.log(`Completed ${completed}`);
		} catch (error) {
			failed++;
			if (isBattleTimeoutError(error)) timedOut++;

			const battleError = error instanceof Error ? error : new Error(String(error));
			if (isBattleAbortedError(battleError)) {
				console.error(`Runner interrupted (game ${gameNumber}): ${battleError.message}`);
			} else {
				console.error(`Runner error (game ${gameNumber}): ${battleError.message}`);
			}

			if (!hardStopRequested && failed >= MAX_FAILED_GAMES) {
				stopRequested = true;
				if (!fatalError) {
					fatalError = new Error(
						`Stopping after ${failed} failed games (limit ${MAX_FAILED_GAMES}). Last error: ${battleError.message}`
					);
				}
			}
		} finally {
			runningGames = Math.max(0, runningGames - 1);
		}
	}

	const running: Promise<void>[] = [];

	try {
		for (let i = 0; i < TOTAL_GAMES; i++) {
			if (stopRequested) break;

			running.push(worker(i + 1));
			if (running.length >= CONCURRENCY) {
				await Promise.allSettled(running);
				running.length = 0;
				if (fatalError) break;
			}
		}

		await Promise.allSettled(running);

		if (fatalError) throw fatalError;
	} finally {
		clearInterval(heartbeatHandle);
		printStats();
	}
}

runExperiment().catch(error => {
	if (isInterruptAbortError(error)) {
		console.error(error.message);
		process.exitCode = 130;
		return;
	}
	console.error("Experiment terminated with an error.");
	if (error instanceof Error && error.stack) {
		console.error(error.stack);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
