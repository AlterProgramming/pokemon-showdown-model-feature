import * as fs from "fs";
import * as path from "path";
import {BattleStream, getPlayerStreams, Teams} from "..";
import {RLAgentAI} from "../tools/rl-agent";
import {parseBooleanOption, resolveRLModelProfileConfig, type RLModelProfileConfig} from "../tools/rl-model-profiles";
import {saveReplayHtml} from "../tools/replay-export";

type CompetitorKey = "modelA" | "modelB";

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
	winner: string | null;
	replayLog: string;
	turns: number;
};

const BATTLE_TIMEOUT_MS = Number(process.env.BATTLE_TIMEOUT_MS || 180_000);
const REPLAY_OUTPUT_DIR = process.env.REPLAY_OUTPUT_DIR || "logs/tv";
const TV_REFRESH_SECONDS = Number(process.env.TV_REFRESH_SECONDS || 60);
const BATTLE_FORMAT = process.env.BATTLE_FORMAT || "gen9randombattle";
const DEFAULT_ENDPOINT = process.env.MODEL_SERVER_ENDPOINT || "http://127.0.0.1:5000/predict";

function getEndpoint(prefix: "MODEL_A" | "MODEL_B"): string {
	return process.env[`${prefix}_ENDPOINT`] || DEFAULT_ENDPOINT;
}

function resolveCompetitor(
	prefix: "MODEL_A" | "MODEL_B",
	key: CompetitorKey,
	defaults: {name: string; modelID: string; profile: string}
): CompetitorConfig {
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

function writeTvHtml(battleLog: string, title: string, statusLabel?: string): void {
	const tmpPath = saveReplayHtml({
		outputDir: REPLAY_OUTPUT_DIR,
		fileStem: "tv.tmp",
		battleLog,
		title,
		live: true,
		refreshSeconds: TV_REFRESH_SECONDS,
		statusLabel,
		autoplayMuted: true,
	});
	fs.renameSync(tmpPath, path.join(path.dirname(tmpPath), "tv.html"));
}

async function runTVBattle(gameNumber: number): Promise<BattleResult> {
	const assignment = assignmentForGame(gameNumber);
	const battleStream = new BattleStream();
	const streams = getPlayerStreams(battleStream);

	const spec = {formatid: BATTLE_FORMAT};
	const p1spec = {
		name: `${assignment.p1.name} (${assignment.p1.modelID})`,
		team: Teams.pack(Teams.generate("gen9randombattle"))!,
	};
	const p2spec = {
		name: `${assignment.p2.name} (${assignment.p2.modelID})`,
		team: Teams.pack(Teams.generate("gen9randombattle"))!,
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
	let turnCount = 0;
	const replayLogLines: string[] = [];

	const battleLoop = (async () => {
		for await (const chunk of streams.omniscient) {
			for (const rawLine of chunk.split("\n")) {
				if (rawLine) replayLogLines.push(rawLine);
				const line = rawLine.trim();
				if (!line) continue;

				const winMatch = line.match(/^\|win\|(.*)/);
				if (winMatch) winner = winMatch[1].trim();

				const turnMatch = line.match(/^\|turn\|(\d+)/);
				if (turnMatch) turnCount = Math.max(turnCount, Number(turnMatch[1]));
			}
		}
	})();

	const battlePromise = (async () => {
		await streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
		await battleLoop;
		return {winner, replayLog: replayLogLines.join("\n"), turns: turnCount};
	})();

	let streamClosed = false;
	function closeBattleStream() {
		if (streamClosed) return;
		streamClosed = true;
		p1.stop();
		p2.stop();
		void streams.omniscient.writeEnd();
	}

	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<BattleResult>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			closeBattleStream();
			reject(new Error(`Game ${gameNumber} timed out after ${BATTLE_TIMEOUT_MS}ms`));
		}, BATTLE_TIMEOUT_MS);
	});

	try {
		return await Promise.race([battlePromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		closeBattleStream();
	}
}

let stopRequested = false;

process.on("SIGINT", () => {
	if (stopRequested) process.exit(1);
	console.log("\n[tv] Stop requested — finishing current game...");
	stopRequested = true;
});

async function runTV(): Promise<void> {
	const tvTitle = `${MODEL_A.name} vs ${MODEL_B.name}`;
	console.log("[tv] Starting continuous TV mode");
	console.log(`[tv] ${MODEL_A.name} (${MODEL_A.modelID}) @ ${MODEL_A.endpoint}`);
	console.log(`[tv] ${MODEL_B.name} (${MODEL_B.modelID}) @ ${MODEL_B.endpoint}`);
	console.log(`[tv] Output: ${path.resolve(REPLAY_OUTPUT_DIR)}/tv.html`);
	console.log(`[tv] Browser refresh: ${TV_REFRESH_SECONDS}s`);

	writeTvHtml("", tvTitle, "Starting first battle...");

	let gameNumber = 0;
	while (!stopRequested) {
		gameNumber++;
		const title = `${MODEL_A.name} vs ${MODEL_B.name} — Game ${gameNumber}`;
		const startMs = Date.now();
		console.log(`[tv] Starting game ${gameNumber}`);

		try {
			const result = await runTVBattle(gameNumber);
			const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
			const winnerLabel = result.winner || "Unknown";
			console.log(`[tv] Game ${gameNumber}: ${winnerLabel} wins in ${result.turns} turns (${elapsedS}s)`);
			writeTvHtml(
				result.replayLog,
				title,
				`Game ${gameNumber} — ${winnerLabel} wins · ${result.turns} turns`
			);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[tv] Game ${gameNumber} error: ${msg}`);
			writeTvHtml("", tvTitle, `Game ${gameNumber} failed — retrying in 5s...`);
			await new Promise<void>(resolve => setTimeout(resolve, 5_000));
		}
	}

	console.log("[tv] Stopped.");
}

runTV().catch(error => {
	console.error("[tv] Fatal error:", error);
	process.exitCode = 1;
});
