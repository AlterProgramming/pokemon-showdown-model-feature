import {BattleStream, getPlayerStreams, Teams} from "..";
import {RandomPlayerAI} from "../tools/random-player-ai";
import {RLAgentAI, type RLAgentDecisionRecord} from "../tools/rl-agent";
import {RLModelClient} from "../tools/rl-model-client";
import {parseBooleanOption, resolveRLModelProfileConfig} from "../tools/rl-model-profiles";
import {extractSwitchSlot} from "../tools/rl-action-helpers";

type BattleResult = {
	records: RLAgentDecisionRecord[];
};

type NormalizedAction = {
	type: string;
	slot: number | null;
};

const RL_PROFILE = resolveRLModelProfileConfig(
	process.env.RL_MODEL_PROFILE,
	parseBooleanOption(process.env.RL_ALLOW_VOLUNTARY_SWITCHES),
);
const TOTAL_GAMES = Number(process.env.TOTAL_GAMES || 20);
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const BATTLE_TIMEOUT_MS = Number(process.env.BATTLE_TIMEOUT_MS || 180_000);
const SAMPLE_LIMIT = Number(process.env.PARITY_SAMPLE_LIMIT || 1000);
const MAX_MISMATCH_EXAMPLES = Number(process.env.PARITY_MISMATCH_EXAMPLES || 20);
const LOCAL_ENDPOINT = process.env.PARITY_LOCAL_ENDPOINT || "local://default";
const IPC_ENDPOINT = process.env.PARITY_IPC_ENDPOINT || "ipc://word-policy";
const MODEL_ID = process.env.RL_MODEL_ID || "word_policy_v1";

function normalizeAction(response: AnyObject | null | undefined): NormalizedAction {
	if (!response || typeof response !== "object") return {type: "none", slot: null};
	const type = String(response.type || "none");
	if (type === "move") {
		const slot = Number(response.best_move?.slot || 0);
		return {type, slot: Number.isFinite(slot) && slot > 0 ? slot : null};
	}
	if (type === "switch" || type === "revive") {
		const slot = extractSwitchSlot(response);
		return {type, slot: typeof slot === "number" ? slot : null};
	}
	return {type, slot: null};
}

function actionsMatch(a: AnyObject | null | undefined, b: AnyObject | null | undefined): boolean {
	const left = normalizeAction(a);
	const right = normalizeAction(b);
	return left.type === right.type && left.slot === right.slot;
}

function mismatchSummary(record: RLAgentDecisionRecord, ipcResponse: AnyObject): AnyObject {
	const battleState = record.modelRequest?.battle_state || {};
	const perspective = record.modelRequest?.perspective_player || "p1";
	const side = battleState[perspective] || {};
	const mons = battleState.mons || {};
	const candidates = Array.isArray(record.modelRequest?.legal_switches) ? record.modelRequest.legal_switches.map((choice: AnyObject) => {
		const slotIndex = Number(choice.slot || 0) - 1;
		const uid = Array.isArray(side.slots) ? side.slots[slotIndex] : undefined;
		const mon = uid ? mons[uid] || {} : {};
		return {
			slot: choice.slot,
			species: mon.species || null,
			hp: mon.hp_frac ?? choice.hp_frac ?? null,
			status: mon.status || null,
			observedMoves: mon.observed_moves || [],
		};
	}) : [];
	return {
		requestKind: record.requestKind,
		question: record.modelRequest?.question || null,
		request: record.modelRequest || null,
		local: normalizeAction(record.modelResponse),
		ipc: normalizeAction(ipcResponse),
		localPrimary: record.modelResponse?.word_model_primary || null,
		ipcPrimary: ipcResponse?.word_model_primary || null,
		promptTokensLocal: record.modelResponse?.prompt_tokens || null,
		promptTokensIPC: ipcResponse?.prompt_tokens || null,
		legalMoveSlots: Array.isArray(record.modelRequest?.legal_moves) ? record.modelRequest.legal_moves.map((move: AnyObject) => move.slot) : [],
		legalSwitchSlots: Array.isArray(record.modelRequest?.legal_switches) ? record.modelRequest.legal_switches.map((choice: AnyObject) => choice.slot) : [],
		switchCandidates: candidates,
	};
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
		name: "LocalWordPolicy",
		team: Teams.pack(Teams.generate("gen9randombattle")),
	};
	const records: RLAgentDecisionRecord[] = [];
	const p1 = new RandomPlayerAI(streams.p1);
	const p2 = new RLAgentAI(streams.p2, {
		endpoint: LOCAL_ENDPOINT,
		transport: "local",
		modelID: MODEL_ID,
		modelProfile: RL_PROFILE.profile,
		allowVoluntarySwitches: RL_PROFILE.allowVoluntarySwitches,
		onDecision: record => {
			if (record.modelRequest && record.modelResponse) records.push(record);
		},
	});
	void p1.start();
	void p2.start();

	const battleLoop = (async () => {
		for await (const _chunk of streams.omniscient) {}
	})();

	const battlePromise = (async () => {
		await streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
		await battleLoop;
		return {records};
	})();

	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<BattleResult>((_, reject) => {
		timeoutHandle = setTimeout(() => reject(new Error(`Battle ${gameNumber} timed out.`)), BATTLE_TIMEOUT_MS);
	});

	try {
		return await Promise.race([battlePromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		p1.stop();
		p2.stop();
		void streams.omniscient.writeEnd();
	}
}

async function collectCorpus(): Promise<RLAgentDecisionRecord[]> {
	const records: RLAgentDecisionRecord[] = [];
	let nextGame = 1;
	const workers = Array.from({length: CONCURRENCY}, async () => {
		while (records.length < SAMPLE_LIMIT && nextGame <= TOTAL_GAMES) {
			const gameNumber = nextGame++;
			console.log(`[capture] starting game ${gameNumber}`);
			const result = await runSingleBattle(gameNumber);
			records.push(...result.records);
			console.log(`[capture] finished game ${gameNumber} records=${records.length}`);
		}
	});
	await Promise.all(workers);
	return records.slice(0, SAMPLE_LIMIT);
}

async function main() {
	const corpus = await collectCorpus();
	console.log(`[parity] captured ${corpus.length} requests`);
	const ipcClient = new RLModelClient({
		endpoint: IPC_ENDPOINT,
		transport: "ipc",
		modelID: MODEL_ID,
		modelProfile: RL_PROFILE.profile,
	});

	let exactMatches = 0;
	let moveRequests = 0;
	let moveMatches = 0;
	let switchRequests = 0;
	let switchMatches = 0;
	const mismatches: AnyObject[] = [];

	for (let i = 0; i < corpus.length; i++) {
		const record = corpus[i];
		const request = record.modelRequest;
		if (!request) continue;
		const ipcResponse = await ipcClient.query(request, () => "p2");
		const match = actionsMatch(record.modelResponse, ipcResponse);
		if (record.requestKind === "move") {
			moveRequests++;
			if (match) moveMatches++;
		} else if (record.requestKind === "forceSwitch") {
			switchRequests++;
			if (match) switchMatches++;
		}
		if (match) {
			exactMatches++;
		} else if (mismatches.length < MAX_MISMATCH_EXAMPLES) {
			mismatches.push(mismatchSummary(record, ipcResponse));
		}
	}

	const total = corpus.length || 1;
	console.log("\n===== WORD POLICY PARITY =====");
	console.log(`Model ID: ${MODEL_ID}`);
	console.log(`Profile: ${RL_PROFILE.profile}`);
	console.log(`Corpus Size: ${corpus.length}`);
	console.log(`Exact Action Parity: ${exactMatches}/${corpus.length} (${((exactMatches / total) * 100).toFixed(2)}%)`);
	if (moveRequests) {
		console.log(`Move Request Parity: ${moveMatches}/${moveRequests} (${((moveMatches / moveRequests) * 100).toFixed(2)}%)`);
	}
	if (switchRequests) {
		console.log(`Force-Switch Parity: ${switchMatches}/${switchRequests} (${((switchMatches / switchRequests) * 100).toFixed(2)}%)`);
	}
	if (mismatches.length) {
		console.log("Representative mismatches:");
		for (const mismatch of mismatches) {
			console.log(JSON.stringify(mismatch));
		}
	}
	console.log("================================\n");
}

void main().catch(error => {
	console.error("Parity audit failed.");
	if (error instanceof Error && error.stack) console.error(error.stack);
	else console.error(error);
	process.exitCode = 1;
});
