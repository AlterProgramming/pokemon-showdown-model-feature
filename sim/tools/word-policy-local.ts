import * as fs from "fs";
import * as path from "path";

import {Dex, toID} from "../dex";
import {RLModelClient} from "./rl-model-client";

type Prediction = {
	word: string;
	score: number;
};

type SerializedWordModel = {
	token_vocab: {[token: string]: number};
	label_vocab: {[label: string]: number};
	token_embeddings: number[][];
	label_embeddings: number[][];
};

type SerializedPokedex = {
	[speciesId: string]: {
		types?: string[];
	};
};

const STATUS_KEYWORDS = new Set([
	"toxic", "poisonpowder", "stunspore", "thunderwave", "spore", "hypnosis",
	"sleeppowder", "willowisp", "leechseed", "yawn", "encore",
]);
const SETUP_KEYWORDS = new Set([
	"swordsdance", "nastyplot", "bulkup", "calmmind", "dragondance",
	"quiverdance", "shellsmash", "agility", "curse", "growth", "trailblaze",
]);
const SCOUT_KEYWORDS = new Set([
	"protect", "detect", "substitute", "uturn", "voltswitch", "flipturn",
	"partingshot", "batonpass",
]);
const RECOVER_KEYWORDS = new Set([
	"recover", "roost", "slackoff", "softboiled", "moonlight", "morningsun",
	"synthesis", "rest",
]);
const HAZARD_SET_KEYWORDS = new Set([
	"stealthrock", "spikes", "stickyweb", "toxicspikes", "stoneaxe", "ceaselessedge",
]);
const HAZARD_CLEAR_KEYWORDS = new Set([
	"rapidspin", "defog", "tidyup", "courtchange", "mortalspin",
]);
const PHAZE_KEYWORDS = new Set([
	"roar", "whirlwind", "dragontail", "circlethrow", "haze", "clearsmog",
]);
const DEFAULT_TOP_K = 3;

let cachedModel: SerializedWordModel | null = null;
let cachedPokedex: SerializedPokedex | null = null;
const registeredEndpoints = new Set<string>();

function artifactPath(): string {
	return path.resolve(__dirname, "../../../../artifacts/word_prediction_model/battle_inquiry_v2/model.json");
}

function getModel(): SerializedWordModel {
	if (!cachedModel) {
		cachedModel = JSON.parse(fs.readFileSync(artifactPath(), "utf8"));
	}
	return cachedModel;
}

function pokedexPath(): string {
	return path.resolve(__dirname, "../../../../Pokemon-Showdown-Sim/data/pokedex.json");
}

function getPokedex(): SerializedPokedex {
	if (!cachedPokedex) {
		cachedPokedex = JSON.parse(fs.readFileSync(pokedexPath(), "utf8"));
	}
	return cachedPokedex;
}

function normalizeToken(text: string): string {
	return String(text || "").toLowerCase().trim().replace(/[^a-z]/g, "");
}

function normalizePrompt(tokens: string[]): string[] {
	return tokens.map(normalizeToken).filter(Boolean);
}

function questionTokens(question: string): string[] {
	return normalizePrompt(String(question || "").replace(/\?/g, " ").replace(/,/g, " ").split(/\s+/g));
}

function activeRequestFlags(data: AnyObject): AnyObject {
	const active = data.active;
	if (Array.isArray(active) && active.length && active[0] && typeof active[0] === "object") {
		return active[0];
	}
	return {};
}

function allowVoluntarySwitches(data: AnyObject): boolean {
	const active = activeRequestFlags(data);
	return !(active.trapped || active.maybeTrapped);
}

function getActiveMon(battleState: AnyObject, player: string): AnyObject | null {
	const side = battleState[player] || {};
	const activeUid = side.active_uid;
	const mons = battleState.mons || {};
	if (!activeUid) return null;
	return mons[activeUid] || null;
}

function countHealthyBench(battleState: AnyObject, player: string): number {
	const side = battleState[player] || {};
	const mons = battleState.mons || {};
	let count = 0;
	for (const uid of side.slots || []) {
		if (!uid || uid === side.active_uid) continue;
		const mon = mons[uid] || {};
		if (!mon.fainted && Number(mon.hp_frac || 0) > 0.2) count++;
	}
	return count;
}

function buildBattlePromptTokens(
	question: string,
	battleState: AnyObject,
	options: {perspectivePlayer?: string; legalMoves?: AnyObject[]; legalSwitches?: AnyObject[]} = {},
): string[] {
	const perspectivePlayer = options.perspectivePlayer || "p1";
	const legalMoves = options.legalMoves || [];
	const legalSwitches = options.legalSwitches || [];
	const otherPlayer = perspectivePlayer === "p1" ? "p2" : "p1";
	const myActive = getActiveMon(battleState, perspectivePlayer) || {};
	const oppActive = getActiveMon(battleState, otherPlayer) || {};
	const qTokens = new Set(questionTokens(question));
	const tokens: string[] = [];
	const myHp = Number(myActive.hp_frac || 0);
	const oppHp = Number(oppActive.hp_frac || 0);
	const myStatus = normalizeToken(String(myActive.status || ""));
	const benchCount = countHealthyBench(battleState, perspectivePlayer);
	const boosts = myActive.boosts || {};
	const totalBoost = Number(boosts.atk || 0) + Number(boosts.spa || 0) + Number(boosts.spe || 0);

	if (intersects(qTokens, ["switch", "swap", "pivot", "retreat", "change"])) tokens.push("pivot", "retreat", "swap");
	if (intersects(qTokens, ["attack", "move", "damage", "hit", "offense"])) tokens.push("damage", "offense", "pressure");
	if (intersects(qTokens, ["ko", "knock", "kill", "finish", "lethal"])) tokens.push("ko", "lethal", "secure");
	if (intersects(qTokens, ["ahead", "winning", "advantage", "lead", "favored", "favour"])) tokens.push("pressure", "steady", "secure");
	if (intersects(qTokens, ["risk", "risky", "danger", "unsafe", "gamble", "uncertain"])) tokens.push("guess", "volatile", "danger");
	if (intersects(qTokens, ["safe", "survive", "recover", "stabilize", "stabilise"])) tokens.push("safe", "recover", "steady");
	if (intersects(qTokens, ["boost", "setup", "sweep", "snowball"])) tokens.push("boost", "charge", "snowball");
	if (intersects(qTokens, ["what", "unknown", "scout", "reveal", "info"])) tokens.push("reveal", "learn", "info");

	if (myHp <= 0.3) {
		tokens.push("save", "protect", "recover");
		if (benchCount > 0) tokens.push("pivot", "escape");
	}
	if (oppHp <= 0.3) tokens.push("ko", "end", "pressure");
	if (["brn", "psn", "tox", "par", "slp"].includes(myStatus)) tokens.push(myStatus === "brn" ? "burn" : "cripple", "recover", "reset");
	if (totalBoost >= 2 && myHp >= 0.45) tokens.push("boost", "stack", "pressure");
	if (myHp > oppHp + 0.25) tokens.push("secure", "steady", "pressure");
	else if (oppHp > myHp + 0.25) tokens.push("danger", "safe", "recover");
	if ((legalSwitches.length > 0 && myHp <= 0.45) || benchCount > 1) tokens.push("swap", "rotate");
	if (legalMoves.length > 0 && oppHp <= 0.5) tokens.push("strike", "close");
	if (!legalSwitches.length && legalMoves.length) tokens.push("strike", "pressure");

	const unique: string[] = [];
	const seen = new Set<string>();
	for (const token of normalizePrompt(tokens)) {
		if (seen.has(token)) continue;
		seen.add(token);
		unique.push(token);
	}
	return unique.slice(0, 5).length ? unique.slice(0, 5) : ["info", "test", "steady"];
}

function intersects(values: Set<string>, options: string[]): boolean {
	for (const option of options) {
		if (values.has(option)) return true;
	}
	return false;
}

function softmax(logits: number[]): number[] {
	if (!logits.length) return [];
	const maxLogit = Math.max(...logits);
	const exps = logits.map(value => Math.exp(value - maxLogit));
	const denom = exps.reduce((total, value) => total + value, 0);
	return exps.map(value => value / (denom || 1));
}

function predictPrompt(promptTokens: string[], topK = DEFAULT_TOP_K): Prediction[] {
	const model = getModel();
	const embeddingDim = model.label_embeddings[0]?.length || 0;
	const tokenIds = promptTokens
		.map(token => model.token_vocab[token])
		.filter((id): id is number => typeof id === "number");
	const promptVec = new Array<number>(embeddingDim).fill(0);
	if (tokenIds.length) {
		for (const tokenID of tokenIds) {
			const embedding = model.token_embeddings[tokenID] || [];
			for (let i = 0; i < embeddingDim; i++) promptVec[i] += Number(embedding[i] || 0);
		}
		for (let i = 0; i < embeddingDim; i++) promptVec[i] /= tokenIds.length;
	}
	const logits = model.label_embeddings.map(row => dot(row, promptVec));
	const probs = softmax(logits);
	const labels = Object.entries(model.label_vocab)
		.map(([word, index]) => ({word, index}))
		.sort((a, b) => a.index - b.index);
	return labels
		.map(({word, index}) => ({word, score: probs[index] || 0}))
		.filter(prediction => prediction.word !== "<unk>")
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);
}

function dot(a: number[], b: number[]): number {
	let total = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) total += Number(a[i] || 0) * Number(b[i] || 0);
	return total;
}

function normalizeMoveName(movePayload: AnyObject): string {
	return toID(String(movePayload.move || movePayload.id || ""));
}

function moveData(movePayload: AnyObject): AnyObject {
	const move = Dex.moves.get(String(movePayload.id || movePayload.move || ""));
	if (!move?.exists) return {};
	return move;
}

function speciesTypes(speciesName: string): string[] {
	const entry = getPokedex()[toID(speciesName)] || {};
	return Array.isArray(entry.types) ? [...entry.types] : [];
}

function moveType(nameOrId: string): string {
	const move = Dex.moves.get(nameOrId);
	return move?.exists ? String(move.type || "") : "";
}

function typeEffectiveness(moveTypeName: string, defendingTypes: string[]): number {
	if (!moveTypeName || !defendingTypes.length) return 1;
	if (!Dex.getImmunity(moveTypeName, defendingTypes)) return 0;
	return Math.pow(2, Dex.getEffectiveness(moveTypeName, defendingTypes));
}

function moveWordScore(word: string, movePayload: AnyObject): number {
	const name = normalizeMoveName(movePayload);
	if (word === "finish") return STATUS_KEYWORDS.has(name) || SETUP_KEYWORDS.has(name) || RECOVER_KEYWORDS.has(name) ? -1.5 : 2;
	if (word === "attack") return STATUS_KEYWORDS.has(name) || SETUP_KEYWORDS.has(name) || RECOVER_KEYWORDS.has(name) ? -1 : 1.4;
	if (word === "setup") return SETUP_KEYWORDS.has(name) ? 2.2 : SCOUT_KEYWORDS.has(name) ? 0.5 : -0.8;
	if (word === "status") return STATUS_KEYWORDS.has(name) ? 2 : RECOVER_KEYWORDS.has(name) ? 0.4 : -0.7;
	if (word === "scout") return SCOUT_KEYWORDS.has(name) ? 1.8 : -0.4;
	if (["stabilize", "preserve", "wall"].includes(word)) {
		if (RECOVER_KEYWORDS.has(name)) return 1.8;
		if (STATUS_KEYWORDS.has(name)) return 1;
		if (SCOUT_KEYWORDS.has(name)) return 0.5;
		return -0.5;
	}
	if (word === "risk") return STATUS_KEYWORDS.has(name) || RECOVER_KEYWORDS.has(name) ? -0.6 : 0.8;
	return 0;
}

function attackPressureScore(movePayload: AnyObject, mySpecies: string, oppSpecies: string): number {
	const metadata = moveData(movePayload);
	const category = String(metadata.category || "");
	if (!["Physical", "Special"].includes(category)) return -10;
	const basePower = Number(metadata.basePower || 0);
	const accuracy = Number(metadata.accuracy === true ? 101 : metadata.accuracy || 0);
	const priority = Number(metadata.priority || 0);
	const inferredMoveType = String(metadata.type || moveType(String(movePayload.id || movePayload.move || "")) || "");
	let score = Math.min(basePower / 55, 2.8);
	if (accuracy) score -= Math.max(0, (100 - accuracy) / 60);
	if (priority > 0) score += 0.25;
	const myTypes = speciesTypes(mySpecies);
	const oppTypes = speciesTypes(oppSpecies);
	if (inferredMoveType && oppTypes.length) {
		const multiplier = typeEffectiveness(inferredMoveType, oppTypes);
		if (multiplier === 0) score -= 4;
		else if (multiplier >= 4) score += 3.5;
		else if (multiplier > 1) score += 2;
		else if (multiplier < 1) score -= 1.1;
	}
	if (inferredMoveType && myTypes.includes(inferredMoveType)) score += 0.5;
	return score;
}

function healthyTeamState(battleState: AnyObject, player: string): {healthy: number; hpTotal: number} {
	const side = battleState[player] || {};
	const mons = battleState.mons || {};
	let healthy = 0;
	let hpTotal = 0;
	for (const uid of side.slots || []) {
		if (!uid) continue;
		const mon = mons[uid] || {};
		if (mon.fainted) continue;
		const hp = Number(mon.hp_frac || 0);
		if (hp > 0) {
			healthy++;
			hpTotal += hp;
		}
	}
	return {healthy, hpTotal};
}

function materialEdge(battleState: AnyObject, perspectivePlayer: string): number {
	const other = perspectivePlayer === "p1" ? "p2" : "p1";
	const mine = healthyTeamState(battleState, perspectivePlayer);
	const theirs = healthyTeamState(battleState, other);
	return (mine.healthy - theirs.healthy) * 1.6 + (mine.hpTotal - theirs.hpTotal);
}

function slotMonForSwitch(battleState: AnyObject, perspectivePlayer: string, switchPayload: AnyObject): AnyObject {
	const side = battleState[perspectivePlayer] || {};
	const slots = [...(side.slots || [])];
	const slotIndex = Number(switchPayload.slot || 0) - 1;
	if (slotIndex >= 0 && slotIndex < slots.length) {
		const uid = slots[slotIndex];
		if (uid) return {...((battleState.mons || {})[uid] || {})};
	}
	return {};
}

function benchSwitchScore(
	switchPayload: AnyObject,
	battleState: AnyObject,
	perspectivePlayer: string,
	oppSpecies: string,
	oppObservedMoves: string[],
	material: number,
): number {
	const benchMon = slotMonForSwitch(battleState, perspectivePlayer, switchPayload);
	if (!benchMon || benchMon.fainted) return -10;
	const benchHp = Number(benchMon.hp_frac || switchPayload.hp_frac || 0);
	if (benchHp <= 0) return -10;
	const benchSpecies = String(benchMon.species || "");
	const benchTypes = speciesTypes(benchSpecies);
	let score = benchHp * 2.8;
	if (benchHp >= 0.7) score += 0.4;
	if (String(benchMon.status || "")) score -= 0.5;
	for (const oppMoveName of oppObservedMoves) {
		const oppMeta = moveData({id: oppMoveName});
		const oppMoveType = String(oppMeta.type || moveType(oppMoveName) || "");
		const oppCategory = String(oppMeta.category || "");
		const oppPower = Number(oppMeta.basePower || 0);
		if (!["Physical", "Special"].includes(oppCategory) || !oppMoveType) continue;
		const multiplier = typeEffectiveness(oppMoveType, benchTypes);
		let local = Math.min(oppPower / 80, 1.8);
		if (multiplier === 0) local -= 1;
		else if (multiplier >= 4) local += 2.4;
		else if (multiplier > 1) local += 1;
		else if (multiplier < 1) local -= 0.6;
		score -= local;
	}
	if (material > 1.5) score += 0.3;
	if (!oppObservedMoves.length && oppSpecies) score += 0.1;
	return score;
}

function sideConditions(battleState: AnyObject, player: string): {[key: string]: number} {
	const side = battleState[player] || {};
	const conditions = side.side_conditions || side.sideConditions || {};
	const result: {[key: string]: number} = {};
	for (const [key, value] of Object.entries(conditions)) result[String(key)] = Number(value || 0);
	return result;
}

function hazardPressure(conditions: {[key: string]: number}): number {
	return (conditions.stealthrock || 0) * 1.3 + (conditions.spikes || 0) * 0.9 + (conditions.toxicspikes || 0) * 0.8 + (conditions.stickyweb || 0) * 0.7;
}

function opponentRoleFlags(oppObservedMoves: string[]): {[key: string]: boolean} {
	const normalized = new Set(oppObservedMoves.map(move => toID(move)));
	return {
		setup: someHas(normalized, SETUP_KEYWORDS),
		recover: someHas(normalized, RECOVER_KEYWORDS),
		hazard: someHas(normalized, HAZARD_SET_KEYWORDS),
		phaze: someHas(normalized, PHAZE_KEYWORDS),
		status: someHas(normalized, STATUS_KEYWORDS),
	};
}

function someHas(values: Set<string>, options: Set<string>): boolean {
	for (const value of values) {
		if (options.has(value)) return true;
	}
	return false;
}

function boostTotal(mon: AnyObject): number {
	const boosts = mon.boosts || {};
	return Number(boosts.atk || 0) + Number(boosts.spa || 0) + Number(boosts.spe || 0);
}

function stateMoveScore(movePayload: AnyObject, context: {
	myHp: number; myStatus: string; oppHp: number; oppStatus: string; totalBoost: number;
	mySpecies: string; oppSpecies: string; oppObservedMoves: string[]; material: number;
	bestAttackPressure: number; myHazardPressure: number; oppHazardPressure: number;
	myRemaining: number; oppRemaining: number;
}): number {
	const name = normalizeMoveName(movePayload);
	const metadata = moveData(movePayload);
	const inferredMoveType = String(metadata.type || moveType(String(movePayload.id || movePayload.move || "")) || "");
	const category = String(metadata.category || "");
	const basePower = Number(metadata.basePower || 0);
	const accuracy = Number(metadata.accuracy === true ? 101 : metadata.accuracy || 0);
	const priority = Number(metadata.priority || 0);
	const target = String(metadata.target || "");
	const selfSwitch = Boolean(metadata.selfSwitch);
	const sideCondition = String(metadata.sideCondition || "");
	const pseudoWeather = String(metadata.pseudoWeather || "");
	const myTypes = speciesTypes(context.mySpecies);
	const oppTypes = speciesTypes(context.oppSpecies);
	const oppFlags = opponentRoleFlags(context.oppObservedMoves);
	let threatScore = 0;
	for (const oppMoveName of context.oppObservedMoves) {
		const oppMeta = moveData({id: oppMoveName});
		const oppMoveType = String(oppMeta.type || moveType(oppMoveName) || "");
		const oppCategory = String(oppMeta.category || "");
		const oppPower = Number(oppMeta.basePower || 0);
		const oppPriority = Number(oppMeta.priority || 0);
		if (!["Physical", "Special"].includes(oppCategory) || !oppMoveType) continue;
		const multiplier = typeEffectiveness(oppMoveType, myTypes);
		let local = Math.min(oppPower / 70, 2);
		if (multiplier === 0) local -= 0.5;
		else if (multiplier >= 4) local += 3;
		else if (multiplier > 1) local += 1.5;
		else if (multiplier < 1) local -= 0.5;
		if (oppPriority > 0 && context.myHp <= 0.35) local += 0.8;
		threatScore = Math.max(threatScore, local);
	}
	if (RECOVER_KEYWORDS.has(name)) {
		if (context.bestAttackPressure >= 3.6 && context.oppHp <= 0.55) return -1.8;
		if (oppFlags.setup && context.myHp <= 0.45) return 0.4;
		if (oppFlags.status && context.bestAttackPressure >= 2.8 && context.oppHp >= 0.35) return -0.6;
		if (["tox", "psn", "brn"].includes(context.myStatus) && context.bestAttackPressure >= 2.4) return -1;
		if (context.material >= 2 && context.myHp > 0.45 && context.oppHp <= 0.4) return -1.2;
		if (context.myHp <= 0.18) return 3.2;
		if (context.myHp <= 0.3) return 2 + Math.min(threatScore, 1.6);
		if (context.myHp <= 0.42) return 0.6 + Math.min(threatScore, 1);
		return -1;
	}
	if (STATUS_KEYWORDS.has(name)) {
		if (context.bestAttackPressure >= 3.2 && context.oppHp <= 0.7) return -2;
		if (oppFlags.recover && context.myHp >= 0.55 && context.oppHp >= 0.55) return 0.3;
		if (oppFlags.status && !context.oppStatus && context.bestAttackPressure >= 2.6) return -0.7;
		if (context.material >= 2 && context.oppHp <= 0.55) return -1.4;
		if (!context.oppStatus && context.oppHp >= 0.8 && context.myHp >= 0.7 && context.totalBoost === 0) return 0.3;
		return -1 - Math.min(threatScore * 0.4, 1);
	}
	if (SETUP_KEYWORDS.has(name)) {
		if (context.totalBoost >= 2) return -3;
		if (context.totalBoost >= 1 && context.bestAttackPressure >= 2.3) return -2.7;
		if (context.bestAttackPressure >= 3) return -2.4;
		if (oppFlags.phaze) return -2;
		if (oppFlags.status || oppFlags.recover) return -2.1 - Math.min(threatScore * 0.3, 0.6);
		if (["tox", "psn", "brn"].includes(context.myStatus)) return -2.3;
		if (context.material >= 1.5) return -2.2 - Math.min(threatScore * 0.4, 0.8);
		if (context.myHp >= 0.92 && context.oppHp >= 0.85 && context.totalBoost === 0) return 0.2;
		return -1.6 - Math.min(threatScore * 0.6, 1.4);
	}
	if (SCOUT_KEYWORDS.has(name)) {
		if (context.bestAttackPressure >= 3.4 && context.material >= 0.5) return -1.3;
		if (context.myHp >= 0.35 && context.myHp <= 0.7 && context.oppHp >= 0.55) return 0.6 - Math.min(threatScore * 0.2, 0.4);
		return -0.2 - Math.min(threatScore * 0.2, 0.4);
	}
	if (HAZARD_SET_KEYWORDS.has(name)) {
		if (context.oppHazardPressure >= 1.2) return -1.2;
		if (context.oppRemaining >= 4 && context.myHp >= 0.6 && context.oppHp >= 0.45 && context.bestAttackPressure < 3.8) return 2.8;
		if (context.oppRemaining >= 3 && context.material <= 0.5 && context.oppHp >= 0.55 && context.bestAttackPressure < 3.4) return 1.5;
		return -0.8;
	}
	if (HAZARD_CLEAR_KEYWORDS.has(name)) {
		if (context.myHazardPressure >= 2.4 && context.myRemaining >= 3 && context.myHp >= 0.35) return 4.4;
		if (context.myHazardPressure >= 1.2 && context.myRemaining >= 3 && context.myHp >= 0.4) return 2.8;
		if (context.myHazardPressure >= 0.8 && context.myRemaining >= 2) return 1.5;
		return -0.7;
	}
	let score = 0;
	if (["Physical", "Special"].includes(category)) {
		const directPressure = attackPressureScore(movePayload, context.mySpecies, context.oppSpecies);
		const pressureGap = Math.max(0, context.bestAttackPressure - directPressure);
		score += directPressure * 0.9 + Math.min(basePower / 60, 2.2);
		if (accuracy && accuracy < 100) score -= (100 - accuracy) / 50;
		if (accuracy >= 100 && directPressure >= context.bestAttackPressure - 0.45) score += 0.45;
		if (pressureGap >= 1 && basePower <= 50 && priority <= 0) score -= 0.7;
		if (pressureGap >= 1.4 && basePower <= 45) score -= 0.9;
		if (priority > 0 && context.oppHp <= 0.35) score += 1.2;
		else if (priority > 0) score += 0.3;
		if (context.oppHp <= 0.25 && priority > 0) score += 1.4;
		if (priority > 0 && context.oppHp > 0.28 && pressureGap >= 0.9) score -= 0.8;
		if (context.oppHp <= 0.3 && accuracy >= 95 && basePower >= 40) score += 0.8;
		if (context.oppHp <= 0.3 && accuracy && accuracy < 90) score -= 1.2;
		if (context.oppHp <= 0.2 && accuracy && accuracy < 100) score -= 0.8;
		if (selfSwitch) {
			score -= 0.4;
			if (context.oppHp <= 0.45 || context.material >= 0.5) score -= 0.5;
		}
	} else if (category === "Status") {
		if (["self", "allySide"].includes(target)) score -= 0.5;
		if (sideCondition || pseudoWeather) score -= 0.7;
	}
	if (inferredMoveType && oppTypes.length) {
		const multiplier = typeEffectiveness(inferredMoveType, oppTypes);
		if (multiplier === 0) score -= 3;
		else if (multiplier >= 4) score += 3.2;
		else if (multiplier > 1) score += 1.8;
		else if (multiplier < 1) score -= 0.9;
	}
	if (inferredMoveType && myTypes.includes(inferredMoveType)) score += 0.4;
	if (oppFlags.setup && priority > 0) score += 0.4;
	if (oppFlags.recover && basePower >= 70) score += 0.3;
	if (oppFlags.recover && ["Physical", "Special"].includes(category) && accuracy >= 90 && basePower >= 60) score += 0.5;
	if (oppFlags.status && !context.oppStatus && ["Physical", "Special"].includes(category) && accuracy >= 90 && basePower >= 60) score += 0.4;
	if (["tox", "psn", "brn"].includes(context.myStatus) && ["Physical", "Special"].includes(category) && basePower >= 60) score += 0.5;
	if (["tox", "psn", "brn"].includes(context.myStatus) && priority > 0 && context.oppHp <= 0.4) score += 0.4;
	if (context.oppHp <= 0.25 && inferredMoveType && oppTypes.length && typeEffectiveness(inferredMoveType, oppTypes) > 1) score += 0.6;
	if (context.material >= 1.5 && accuracy >= 90 && basePower > 0) score += 0.5;
	if (context.material >= 2 && accuracy && accuracy < 90 && context.oppHp <= 0.45) score -= 0.8;
	if (context.oppHp <= 0.4) {
		score += 2.6;
		if (accuracy >= 95 && basePower > 0) score += 0.6;
	}
	if (context.oppHp <= 0.18 && context.myHp <= 0.35 && basePower > 0 && accuracy >= 95) score += 0.7;
	score += context.myHp <= 0.2 ? 1 : 1.5;
	if (context.myHp <= 0.35 && threatScore >= 2 && !RECOVER_KEYWORDS.has(name)) score -= 0.8;
	if (context.material <= -1.5 && SCOUT_KEYWORDS.has(name)) score += 0.4;
	if (threatScore >= 2 && context.oppHp > 0.45) score -= 0.4;
	return score;
}

function bestMoveForPredictionsWithState(predictions: Prediction[], moves: AnyObject[], context: {
	myHp: number; myStatus: string; oppHp: number; oppStatus: string; totalBoost: number;
	mySpecies: string; oppSpecies: string; oppObservedMoves: string[]; material: number;
	myHazardPressure: number; oppHazardPressure: number; myRemaining: number; oppRemaining: number;
	bestAttackPressure: number;
}): AnyObject {
	let bestMove = moves[0];
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const move of moves) {
		let total = 0;
		for (const prediction of predictions) total += prediction.score * moveWordScore(prediction.word, move);
		total += stateMoveScore(move, {
			...context,
			bestAttackPressure: context.bestAttackPressure,
		});
		const slotWeight = -Number(move.slot || 99);
		if (total > bestScore || (total === bestScore && slotWeight > -Number(bestMove.slot || 99))) {
			bestScore = total;
			bestMove = move;
		}
	}
	return bestMove;
}

function defaultQuestionForState(data: AnyObject): string {
	const legalMoves = Array.isArray(data.legal_moves) ? data.legal_moves : [];
	const legalSwitches = Array.isArray(data.legal_switches) ? data.legal_switches : [];
	const canVoluntarySwitch = allowVoluntarySwitches(data);
	const battleState = data.battle_state || {};
	const perspective = data.perspective_player === "p2" ? "p2" : "p1";
	const side = battleState[perspective] || {};
	const activeUid = side.active_uid;
	const oppSide = battleState[perspective === "p1" ? "p2" : "p1"] || {};
	const oppActiveUid = oppSide.active_uid;
	const mons = battleState.mons || {};
	const myActive = mons[activeUid] || {};
	const oppActive = mons[oppActiveUid] || {};
	const myHp = Number(myActive.hp_frac || 0);
	const oppHp = Number(oppActive.hp_frac || 0);
	const oppStatus = String(oppActive.status || "");
	const oppObservedMoves = [...(oppActive.observed_moves || [])];
	const oppTotalBoost = boostTotal(oppActive);
	const totalBoost = boostTotal(myActive);
	const moveNames = new Set(legalMoves.map((move: AnyObject) => normalizeMoveName(move)));
	const hasSetup = someHas(moveNames, SETUP_KEYWORDS);
	const hasStatus = someHas(moveNames, STATUS_KEYWORDS);
	const hasRecover = someHas(moveNames, RECOVER_KEYWORDS);
	let myAlive = 0;
	let oppAlive = 0;
	let myHpTotal = 0;
	let oppHpTotal = 0;
	for (const uid of side.slots || []) {
		if (!uid) continue;
		const mon = mons[uid] || {};
		if (mon.fainted) continue;
		const hp = Number(mon.hp_frac || 0);
		if (hp > 0) {
			myAlive++;
			myHpTotal += hp;
		}
	}
	for (const uid of oppSide.slots || []) {
		if (!uid) continue;
		const mon = mons[uid] || {};
		if (mon.fainted) continue;
		const hp = Number(mon.hp_frac || 0);
		if (hp > 0) {
			oppAlive++;
			oppHpTotal += hp;
		}
	}
	const material = (myAlive - oppAlive) * 1.6 + (myHpTotal - oppHpTotal);
	const highThreat = oppObservedMoves.length > 0 && myHp <= 0.45 && oppHp > 0.35;
	if (oppHp <= 0.35 && legalMoves.length) return "can I knock it out now?";
	if (material >= 2 && oppHp <= 0.55 && legalMoves.length) return "how do I close this out safely?";
	if (highThreat && canVoluntarySwitch && legalSwitches.length) return "should I preserve this and switch?";
	if (myHp <= 0.12 && canVoluntarySwitch && legalSwitches.length && !hasRecover) return "should I switch out here?";
	if (myHp <= 0.3 && hasRecover) return "what is the safe play?";
	if (material <= -1.5 && !oppStatus && hasStatus) return "should I slow this down with status?";
	if (myHp >= 0.85 && oppHp >= 0.75 && totalBoost === 0 && hasSetup) return "should I setup here?";
	if (legalMoves.length) return "should I attack now?";
	if (oppTotalBoost >= 1) return "what is the safe play?";
	return "what is the safe play?";
}

function chooseAction(modelData: AnyObject): AnyObject {
	const battleState = modelData.battle_state || {};
	const perspectivePlayer = modelData.perspective_player === "p2" ? "p2" : "p1";
	const legalMoves = Array.isArray(modelData.legal_moves) ? modelData.legal_moves : [];
	const legalSwitches = allowVoluntarySwitches(modelData) && Array.isArray(modelData.legal_switches) ? modelData.legal_switches : [];
	const question = String(modelData.question || defaultQuestionForState(modelData));
	const promptTokens = buildBattlePromptTokens(question, battleState, {
		perspectivePlayer,
		legalMoves,
		legalSwitches,
	});
	const predictions = predictPrompt(promptTokens);
	const primaryWord = predictions[0]?.word;
	const myActive = getActiveMon(battleState, perspectivePlayer) || {};
	const oppActive = getActiveMon(battleState, perspectivePlayer === "p1" ? "p2" : "p1") || {};
	const mySpecies = String(myActive.species || "");
	const oppSpecies = String(oppActive.species || "");
	const myHp = Number(myActive.hp_frac || 0);
	const myStatus = String(myActive.status || "");
	const oppHp = Number(oppActive.hp_frac || 0);
	const oppStatus = String(oppActive.status || "");
	const totalBoost = boostTotal(myActive);
	const material = materialEdge(battleState, perspectivePlayer);
	const oppObservedMoves = [...(oppActive.observed_moves || [])];
	const otherPlayer = perspectivePlayer === "p1" ? "p2" : "p1";
	const myHazardPressure = hazardPressure(sideConditions(battleState, perspectivePlayer));
	const oppHazardPressure = hazardPressure(sideConditions(battleState, otherPlayer));
	const myRemaining = healthyTeamState(battleState, perspectivePlayer).healthy;
	const oppRemaining = healthyTeamState(battleState, otherPlayer).healthy;
	const normalizedQuestion = String(question || "").toLowerCase().replace(/\?/g, " ").replace(/,/g, " ").replace(/-/g, " ");
	const oppBoostTotal = boostTotal(oppActive);
	const oppFlags = opponentRoleFlags(oppObservedMoves);
	const bestAttackPressure = legalMoves.reduce(
		(best, move) => Math.max(best, attackPressureScore(move, mySpecies, oppSpecies)),
		-10,
	);
	const context = {
		myHp, myStatus, oppHp, oppStatus, totalBoost, mySpecies, oppSpecies, oppObservedMoves,
		material, myHazardPressure, oppHazardPressure, myRemaining, oppRemaining, bestAttackPressure,
	};

	if (legalMoves.length && normalizedQuestion.includes("clear hazards") && myHazardPressure >= 1.2) {
		const clearMoves = legalMoves.filter(move => HAZARD_CLEAR_KEYWORDS.has(normalizeMoveName(move)));
		if (clearMoves.length) return moveResult(bestMoveByState(clearMoves, context), primaryWord, promptTokens);
	}
	if (legalMoves.length && normalizedQuestion.includes("get hazards up") && oppHazardPressure < 1 && oppRemaining >= 3) {
		const hazardMoves = legalMoves.filter(move => HAZARD_SET_KEYWORDS.has(normalizeMoveName(move)));
		if (hazardMoves.length) return moveResult(bestMoveByState(hazardMoves, context), primaryWord, promptTokens);
	}
	if (legalMoves.length && normalizedQuestion.includes("deny setup") && (oppBoostTotal >= 1 || oppFlags.setup)) {
		const denialMoves = legalMoves.filter(move => {
			const name = normalizeMoveName(move);
			return STATUS_KEYWORDS.has(name) || PHAZE_KEYWORDS.has(name) || SCOUT_KEYWORDS.has(name);
		});
		if (denialMoves.length) return moveResult(denialMoves[0], primaryWord, promptTokens);
	}
	if (legalMoves.length && normalizedQuestion.includes("stop recovery") && oppFlags.recover) {
		const denialMoves = legalMoves.filter(move => {
			const name = normalizeMoveName(move);
			return STATUS_KEYWORDS.has(name) || PHAZE_KEYWORDS.has(name);
		});
		if (denialMoves.length && oppHp >= 0.4) return moveResult(denialMoves[0], primaryWord, promptTokens);
	}

	const hardSwitch = primaryWord === "switch" && myHp <= 0.08;
	const softSwitch = primaryWord === "switch" && myHp <= 0.05;
	if ((hardSwitch || softSwitch) && legalSwitches.length) {
		const chosenSwitch = bestSwitch(legalSwitches, battleState, perspectivePlayer, oppSpecies, oppObservedMoves, material);
		return switchResult(chosenSwitch, primaryWord, promptTokens);
	}
	if (legalSwitches.length && legalMoves.length) {
		const chosenSwitch = bestSwitch(legalSwitches, battleState, perspectivePlayer, oppSpecies, oppObservedMoves, material);
		const switchScore = benchSwitchScore(chosenSwitch, battleState, perspectivePlayer, oppSpecies, oppObservedMoves, material);
		const threatened = myHp <= 0.4 && oppHp > 0.35 && oppObservedMoves.length > 0;
		const preserveMode = ["switch", "preserve", "wall", "stabilize"].includes(String(primaryWord || ""));
		if (preserveMode && threatened && switchScore >= 1.2) return switchResult(chosenSwitch, primaryWord, promptTokens);
	}
	if (legalMoves.length) {
		const chosenMove = bestMoveForPredictionsWithState(predictions, legalMoves, context);
		return moveResult(chosenMove, primaryWord, promptTokens);
	}
	if (legalSwitches.length) return switchResult(legalSwitches[0], primaryWord, promptTokens);
	return {type: "none", best_action: null, word_model_primary: primaryWord, prompt_tokens: promptTokens};
}

function bestMoveByState(moves: AnyObject[], context: {
	myHp: number; myStatus: string; oppHp: number; oppStatus: string; totalBoost: number;
	mySpecies: string; oppSpecies: string; oppObservedMoves: string[]; material: number;
	bestAttackPressure: number; myHazardPressure: number; oppHazardPressure: number;
	myRemaining: number; oppRemaining: number;
}): AnyObject {
	let best = moves[0];
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const move of moves) {
		const score = stateMoveScore(move, context);
		if (score > bestScore || (score === bestScore && Number(move.slot || 99) < Number(best.slot || 99))) {
			best = move;
			bestScore = score;
		}
	}
	return best;
}

function bestSwitch(
	switches: AnyObject[],
	battleState: AnyObject,
	perspectivePlayer: string,
	oppSpecies: string,
	oppObservedMoves: string[],
	material: number,
): AnyObject {
	let best = switches[0];
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const item of switches) {
		const score = benchSwitchScore(item, battleState, perspectivePlayer, oppSpecies, oppObservedMoves, material);
		if (score > bestScore || (score === bestScore && Number(item.slot || 99) < Number(best.slot || 99))) {
			best = item;
			bestScore = score;
		}
	}
	return best;
}

function moveResult(move: AnyObject, primaryWord: string | undefined, promptTokens: string[]): AnyObject {
	return {
		type: "move",
		best_move: move,
		word_model_primary: primaryWord,
		prompt_tokens: promptTokens,
	};
}

function switchResult(choice: AnyObject, primaryWord: string | undefined, promptTokens: string[]): AnyObject {
	return {
		type: "switch",
		best_switch: choice,
		slot: choice.slot,
		word_model_primary: primaryWord,
		prompt_tokens: promptTokens,
	};
}

export function ensureLocalWordPolicyHandler(endpoint = "local://default"): void {
	if (registeredEndpoints.has(endpoint)) return;
	Dex.includeData();
	RLModelClient.registerLocalHandler(endpoint, payload => chooseAction(payload));
	registeredEndpoints.add(endpoint);
}
