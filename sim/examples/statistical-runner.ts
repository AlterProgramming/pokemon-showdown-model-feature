import * as path from "path";
import {BattleStream, getPlayerStreams, Teams} from "..";
import {RandomPlayerAI} from "../tools/random-player-ai";
import {getRLAgentMetrics, resetRLAgentMetrics, RLAgentAI} from "../tools/rl-agent";
import {parseBooleanOption, resolveRLModelProfileConfig} from "../tools/rl-model-profiles";
import {
	parseReplayCaptureMode,
	saveReplayHtml,
	saveReplayDashboardHtml,
	sanitizeReplayFileSegment,
	shouldCaptureReplay,
	type ReplayDashboardTile,
	type ReplayOutcome,
} from "../tools/replay-export";

type BattleResult = {
	winner: string;
	randomSwitches: number;
	rlSwitches: number;
	forcedDrags: number;
	replayLog: string;
};

type BattleSide = "p1" | "p2";

const RL_PROFILE = resolveRLModelProfileConfig(
	process.env.RL_MODEL_PROFILE,
	parseBooleanOption(process.env.RL_ALLOW_VOLUNTARY_SWITCHES),
);

const TOTAL_GAMES = Number(process.env.TOTAL_GAMES || 20);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const BATTLE_TIMEOUT_MS = Number(process.env.BATTLE_TIMEOUT_MS || 180_000);
const MAX_FAILED_GAMES = Number(process.env.MAX_FAILED_GAMES || 10);
const REPLAY_CAPTURE_MODE = parseReplayCaptureMode(process.env.REPLAY_CAPTURE_MODE);
const REPLAY_CAPTURE_COUNT = Number(process.env.REPLAY_CAPTURE_COUNT || 0);
const REPLAY_OUTPUT_DIR = process.env.REPLAY_OUTPUT_DIR || "logs/replays";
const REPLAY_GRID = parseBooleanOption(process.env.REPLAY_GRID) ?? false;
const REPLAY_GRID_REFRESH_SECONDS = Number(process.env.REPLAY_GRID_REFRESH_SECONDS || 2);
const REPLAY_GRID_FILE_NAME = process.env.REPLAY_GRID_FILE_NAME || "random-vs-model-grid.html";
const RL_MODEL_ENDPOINT = process.env.RL_MODEL_ENDPOINT || "http://127.0.0.1:5000/predict";
const RL_MODEL_TRANSPORT = process.env.RL_MODEL_TRANSPORT || "http";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15_000);
const BENCHMARK_QUIET = parseBooleanOption(process.env.BENCHMARK_QUIET) ?? false;
const activeBattleAborters = new Map<number, (reason?: string) => void>();
const replayDashboardTiles: ReplayDashboardTile[] = [];

function progressLog(message: string) {
	if (!BENCHMARK_QUIET) console.log(message);
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
	const battleStream = new BattleStream();
	const streams = getPlayerStreams(battleStream);

	const spec = {formatid: "gen9randombattle"};

	const p1spec = {
		name: "RandomBot",
		team: Teams.pack(Teams.generate("gen9randombattle")),
	};

	const p2spec = {
		name: "RLBot",
		team: Teams.pack(Teams.generate("gen9randombattle")),
	};

	const p1 = new RandomPlayerAI(streams.p1);
	const p2 = new RLAgentAI(streams.p2, {
		endpoint: RL_MODEL_ENDPOINT,
		modelProfile: RL_PROFILE.profile,
		allowVoluntarySwitches: RL_PROFILE.allowVoluntarySwitches,
	});

	void p1.start();
	void p2.start();

	let winner: string | null = null;
	let randomSwitches = 0;
	let rlSwitches = 0;
	let forcedDrags = 0;
	const replayLogLines: string[] = [];
	const seenOpeningSendout: Record<BattleSide, boolean> = {
		p1: false,
		p2: false,
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
					if (side === "p1") randomSwitches++;
					else rlSwitches++;
					continue;
				}

				const dragMatch = line.match(/^\|drag\|(p[12])a:/);
				if (dragMatch) {
					const side = dragMatch[1] as BattleSide;
					forcedDrags++;
					if (side === "p1") randomSwitches++;
					else rlSwitches++;
					continue;
				}

				const winMatch = line.match(/^\|win\|(.*)/);
				if (winMatch) winner = winMatch[1].trim();
			}
		}
	})();

	const battlePromise = (async () => {
		await streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);

		await battleLoop;

		return {
			winner: winner || "unknown",
			randomSwitches,
			rlSwitches,
			forcedDrags,
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

let rlWins = 0;
let randomWins = 0;
let ties = 0;
let completed = 0;
let failed = 0;
let timedOut = 0;
let randomSwitches = 0;
let rlSwitches = 0;
let forcedDrags = 0;
let savedReplays = 0;
let stopRequested = false;
let hardStopRequested = false;
let interruptCount = 0;
let fatalError: Error | null = null;
const experimentStartedAt = Date.now();

function formatDurationMs(durationMs: number): string {
	if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(2)} min`;
	if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)} s`;
	return `${durationMs.toFixed(2)} ms`;
}

function printStats() {
	const elapsedMs = Date.now() - experimentStartedAt;
	const agentMetrics = getRLAgentMetrics();

	console.log("\n===== PARTIAL RESULTS =====");
	console.log(`Configured Games: ${TOTAL_GAMES}`);
	console.log(`Configured Concurrency: ${CONCURRENCY}`);
	console.log(`Battle Timeout: ${formatDurationMs(BATTLE_TIMEOUT_MS)}`);
	console.log(`Max Failed Games Before Stop: ${MAX_FAILED_GAMES}`);
	console.log(`Replay Capture Mode: ${REPLAY_CAPTURE_MODE}`);
	console.log(`Replay Capture Limit: ${REPLAY_CAPTURE_COUNT}`);
	console.log(`Saved Replays: ${savedReplays}`);
	console.log(`RL Model Profile: ${RL_PROFILE.profile}`);
	console.log(`Profile Description: ${RL_PROFILE.description}`);
	console.log(`Voluntary Switches Enabled: ${RL_PROFILE.allowVoluntarySwitches ? "yes" : "no"}`);
	console.log(`RL Model Transport: ${RL_MODEL_TRANSPORT}`);
	console.log(`RL Model Endpoint: ${RL_MODEL_ENDPOINT}`);
	console.log(`Completed Games: ${completed}`);
	console.log(`RL Wins: ${rlWins}`);
	console.log(`Random Wins: ${randomWins}`);
	console.log(`Ties: ${ties}`);
	console.log(`Failed Games: ${failed}`);
	console.log(`Timed Out Games: ${timedOut}`);
	console.log(`RL Switches: ${rlSwitches}`);
	console.log(`Random Switches: ${randomSwitches}`);
	console.log(`Total Switches: ${rlSwitches + randomSwitches}`);
	console.log(`Forced Drag Switches: ${forcedDrags}`);
	console.log(`Elapsed Wall Time: ${formatDurationMs(elapsedMs)}`);

	if (completed > 0) {
		const winRate = (rlWins / completed) * 100;
		console.log(`RL Win Rate: ${winRate.toFixed(2)}%`);
		console.log(`Avg RL Switches/Game: ${(rlSwitches / completed).toFixed(2)}`);
		console.log(`Avg Random Switches/Game: ${(randomSwitches / completed).toFixed(2)}`);
		console.log(`Avg Total Switches/Game: ${((rlSwitches + randomSwitches) / completed).toFixed(2)}`);
		console.log(`Avg Wall Time/Game: ${formatDurationMs(elapsedMs / completed)}`);
		console.log(`Throughput: ${((completed / elapsedMs) * 60_000).toFixed(2)} games/min`);
	}

	if (agentMetrics.decisions.count > 0) {
		console.log(`RL Decisions: ${agentMetrics.decisions.count}`);
		console.log(
			`Avg RL Decision Time: ${agentMetrics.decisions.avgMs.toFixed(2)} ms ` +
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
		console.log(`Model Requests: ${agentMetrics.modelRequests.count}`);
		console.log(
			`Avg Model Request Latency: ${agentMetrics.modelRequests.avgMs.toFixed(2)} ms ` +
			`(p95 ${agentMetrics.modelRequests.p95Ms.toFixed(2)} ms, max ${agentMetrics.modelRequests.maxMs.toFixed(2)} ms)`
		);
		console.log(
			`Cumulative Model Request Time: ${formatDurationMs(agentMetrics.modelRequests.totalMs)} ` +
			`across concurrent battles`
		);
		console.log(
			`Model Request Outcomes: ${agentMetrics.modelRequestSuccesses} succeeded, ` +
			`${agentMetrics.modelRequestFailures} failed`
		);
	}
	if (agentMetrics.actions.moveTurnRequests > 0 || agentMetrics.actions.forceSwitchRequests > 0) {
		console.log(`Move-turn Requests: ${agentMetrics.actions.moveTurnRequests}`);
		console.log(`Move Turns With Switch Options: ${agentMetrics.actions.moveTurnRequestsWithSwitchOptions}`);
		console.log(`Forced-switch Requests: ${agentMetrics.actions.forceSwitchRequests}`);
		console.log(`Forced Revive Requests: ${agentMetrics.actions.forceSwitchRequestsWithReviveSelection}`);
		console.log(`Model Move Choices: ${agentMetrics.actions.modelMoveChoices}`);
		console.log(`Model Voluntary Switch Choices: ${agentMetrics.actions.modelVoluntarySwitchChoices}`);
		console.log(`Model Force Switch Choices: ${agentMetrics.actions.modelForceSwitchChoices}`);
		console.log(`Model Revive Choices: ${agentMetrics.actions.modelReviveChoices}`);
		console.log(`Fallback Move Choices: ${agentMetrics.actions.fallbackMoveChoices}`);
		console.log(`Fallback Move-turn Switch Choices: ${agentMetrics.actions.fallbackMoveTurnSwitchChoices}`);
		console.log(`Fallback Force Switch Choices: ${agentMetrics.actions.fallbackForceSwitchChoices}`);
		console.log(`Pass Choices: ${agentMetrics.actions.passChoices}`);
		if (!RL_PROFILE.allowVoluntarySwitches) {
			console.log(`Suppressed Voluntary Switch Opportunities: ${agentMetrics.actions.voluntarySwitchOptionsSuppressed}`);
		}
	}
	console.log("Switch totals exclude the initial opening send-outs.");
	console.log("===========================\n");
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
	if (result.winner === "RLBot") return "win";
	if (result.winner === "RandomBot") return "loss";
	return "tie";
}

function updateReplayDashboard() {
	if (!REPLAY_GRID) return;
	saveReplayDashboardHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileName: REPLAY_GRID_FILE_NAME,
		title: `Random vs RL Replay Grid (${RL_PROFILE.profile})`,
		tiles: replayDashboardTiles,
		refreshSeconds: REPLAY_GRID_REFRESH_SECONDS,
	});
}

function addReplayToDashboard(gameNumber: number, outcome: ReplayOutcome, replayPath: string) {
	if (!REPLAY_GRID) return;
	replayDashboardTiles.push({
		slot: gameNumber,
		label: `Game ${gameNumber}`,
		title: `Random vs RL (${RL_PROFILE.profile})`,
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
		"random-vs-model",
		`game-${gameNumber}`,
		outcome,
		sanitizeReplayFileSegment(RL_PROFILE.profile),
	].join("-");
	const replayPath = saveReplayHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileStem,
		battleLog: result.replayLog,
		title: `Random vs RL (${RL_PROFILE.profile}) - Game ${gameNumber}`,
		autoplayMuted: true,
	});
	addReplayToDashboard(gameNumber, outcome, replayPath);
}

function maybeSaveReplay(gameNumber: number, result: BattleResult) {
	if (!REPLAY_CAPTURE_COUNT || savedReplays >= REPLAY_CAPTURE_COUNT) return;
	const outcome = replayOutcomeForResult(result);
	if (!shouldCaptureReplay(REPLAY_CAPTURE_MODE, outcome)) return;
	const fileStem = [
		"random-vs-model",
		`game-${gameNumber}`,
		outcome,
		sanitizeReplayFileSegment(RL_PROFILE.profile),
	].join("-");
	const replayPath = saveReplayHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileStem,
		battleLog: result.replayLog,
		title: `Random vs RL (${RL_PROFILE.profile}) - Game ${gameNumber}`,
	});
	savedReplays++;
	progressLog(`[replay] Saved ${outcome} replay: ${replayPath}`);
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
		progressLog(`[replay-grid] Dashboard: ${path.resolve(REPLAY_OUTPUT_DIR, REPLAY_GRID_FILE_NAME)}`);
	}
	let runningGames = 0;
	const heartbeatHandle = setInterval(() => {
		if (!BENCHMARK_QUIET) printHeartbeat(runningGames);
	}, HEARTBEAT_INTERVAL_MS);

	async function worker(gameNumber: number) {
		if (stopRequested) return;
		runningGames++;
		progressLog(`[battle] Starting game ${gameNumber}`);

		try {
			const result = await runSingleBattle(gameNumber);

			if (result.winner === "RLBot") rlWins++;
			else if (result.winner === "RandomBot") randomWins++;
			else ties++;
			randomSwitches += result.randomSwitches;
			rlSwitches += result.rlSwitches;
			forcedDrags += result.forcedDrags;
			saveReplayForGrid(gameNumber, result);
			maybeSaveReplay(gameNumber, result);

			completed++;
			progressLog(`Completed ${completed}`);
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

		if (fatalError) {
			throw fatalError;
		}
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
