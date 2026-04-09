/**
 * RL Agent Player AI
 * Uses an external Python model via HTTP, local IPC, or a local in-process transport.
 * Assumes:
 *  - 1v1 battles
 *  - No mega, z-move, dynamax, tera
 */

import type { ObjectReadWriteStream } from "../../lib/streams";
import { BattlePlayer } from "../battle-stream";
import type { ChoiceRequest } from "../side";
import type { PRNGSeed } from "../prng";
import { ProtocolStateTracker } from "./protocol-state-tracker";
import {parseBooleanOption, resolveRLModelProfileConfig, type RLModelProfile} from "./rl-model-profiles";
import { RLModelClient } from "./rl-model-client";
import {ensureLocalWordPolicyHandler} from "./word-policy-local";
import {
	buildLegalMoveOptions,
	buildLegalReviveTargets,
	buildLegalSwitchTargets,
	extractSwitchSlot,
	getPrimaryActivePokemon,
	hasReviveSelectionRequest,
	type RLRequestSide,
	requestSlotForChoice,
} from "./rl-action-helpers";

export type RLAgentDecisionKind = "move" | "forceSwitch" | "teamPreview";
export type RLAgentDecisionRecord = {
	modelCheckpointId?: string;
	battleId?: string;
	recordedAt: string;
	perspectivePlayer: "p1" | "p2";
	requestKind: RLAgentDecisionKind;
	modelRequest: AnyObject | null;
	modelResponse: AnyObject | null;
	chosenAction: string;
	usedFallback: boolean;
	format?: string;
	seed?: PRNGSeed | string | null;
	teamId?: string;
	opponentModelId?: string;
	opponentTeamId?: string;
	result?: "win" | "loss" | "tie" | "timeout" | "error";
};

type TimingMetric = {
	count: number;
	totalMs: number;
	maxMs: number;
	samplesMs: number[];
};

type TimingMetricSummary = {
	count: number;
	totalMs: number;
	avgMs: number;
	p95Ms: number;
	maxMs: number;
};

type RLAgentActionMetrics = {
	moveTurnRequests: number;
	moveTurnRequestsWithSwitchOptions: number;
	forceSwitchRequests: number;
	forceSwitchRequestsWithReviveSelection: number;
	teamPreviewRequests: number;
	modelMoveChoices: number;
	modelVoluntarySwitchChoices: number;
	modelForceSwitchChoices: number;
	modelReviveChoices: number;
	fallbackMoveChoices: number;
	fallbackMoveTurnSwitchChoices: number;
	fallbackForceSwitchChoices: number;
	passChoices: number;
	voluntarySwitchOptionsSuppressed: number;
};

type RLAgentMetrics = {
	decisions: TimingMetric;
	stateVectorBuilds: TimingMetric;
	modelRequests: TimingMetric;
	modelRequestSuccesses: number;
	modelRequestFailures: number;
	actions: RLAgentActionMetrics;
};

const rlAgentMetrics: RLAgentMetrics = {
	decisions: createTimingMetric(),
	stateVectorBuilds: createTimingMetric(),
	modelRequests: createTimingMetric(),
	modelRequestSuccesses: 0,
	modelRequestFailures: 0,
	actions: createActionMetrics(),
};

function createTimingMetric(): TimingMetric {
	return {
		count: 0,
		totalMs: 0,
		maxMs: 0,
		samplesMs: [],
	};
}

function createActionMetrics(): RLAgentActionMetrics {
	return {
		moveTurnRequests: 0,
		moveTurnRequestsWithSwitchOptions: 0,
		forceSwitchRequests: 0,
		forceSwitchRequestsWithReviveSelection: 0,
		teamPreviewRequests: 0,
		modelMoveChoices: 0,
		modelVoluntarySwitchChoices: 0,
		modelForceSwitchChoices: 0,
		modelReviveChoices: 0,
		fallbackMoveChoices: 0,
		fallbackMoveTurnSwitchChoices: 0,
		fallbackForceSwitchChoices: 0,
		passChoices: 0,
		voluntarySwitchOptionsSuppressed: 0,
	};
}

function resetTimingMetric(metric: TimingMetric) {
	metric.count = 0;
	metric.totalMs = 0;
	metric.maxMs = 0;
	metric.samplesMs = [];
}

function resetActionMetrics(metric: RLAgentActionMetrics) {
	for (const key of Object.keys(metric) as (keyof RLAgentActionMetrics)[]) {
		metric[key] = 0;
	}
}

function recordTiming(metric: TimingMetric, durationMs: number) {
	metric.count++;
	metric.totalMs += durationMs;
	metric.maxMs = Math.max(metric.maxMs, durationMs);
	metric.samplesMs.push(durationMs);
}

function summarizeTimingMetric(metric: TimingMetric): TimingMetricSummary {
	const sorted = [...metric.samplesMs].sort((a, b) => a - b);
	const p95Index = sorted.length ? Math.ceil(sorted.length * 0.95) - 1 : 0;
	return {
		count: metric.count,
		totalMs: metric.totalMs,
		avgMs: metric.count ? metric.totalMs / metric.count : 0,
		p95Ms: sorted.length ? sorted[Math.max(0, p95Index)] : 0,
		maxMs: metric.maxMs,
	};
}

export function resetRLAgentMetrics() {
	resetTimingMetric(rlAgentMetrics.decisions);
	resetTimingMetric(rlAgentMetrics.stateVectorBuilds);
	resetTimingMetric(rlAgentMetrics.modelRequests);
	rlAgentMetrics.modelRequestSuccesses = 0;
	rlAgentMetrics.modelRequestFailures = 0;
	resetActionMetrics(rlAgentMetrics.actions);
}

export function getRLAgentMetrics() {
	return {
		decisions: summarizeTimingMetric(rlAgentMetrics.decisions),
		stateVectorBuilds: summarizeTimingMetric(rlAgentMetrics.stateVectorBuilds),
		modelRequests: summarizeTimingMetric(rlAgentMetrics.modelRequests),
		modelRequestSuccesses: rlAgentMetrics.modelRequestSuccesses,
		modelRequestFailures: rlAgentMetrics.modelRequestFailures,
		actions: {...rlAgentMetrics.actions},
	};
}

export class RLAgentAI extends BattlePlayer {
	private readonly modelID: string | undefined;
	private readonly modelProfile: RLModelProfile;
	private readonly allowVoluntarySwitches: boolean;
	private readonly requiresStateVector: boolean;
	private readonly useCompactWordPolicyPayload: boolean;
	private readonly modelClient: RLModelClient;
	private readonly onDecision: ((record: RLAgentDecisionRecord) => void) | undefined;
	private tracker = new ProtocolStateTracker();
	private lastRequestSide: string | undefined;
	constructor(
		playerStream: ObjectReadWriteStream<string>,
		options: {
			endpoint?: string;
			transport?: "http" | "ipc" | "local";
			modelID?: string;
			modelProfile?: RLModelProfile;
			allowVoluntarySwitches?: boolean;
			onDecision?: (record: RLAgentDecisionRecord) => void;
		} = {},
		debug = false,
	) {
		super(playerStream, debug);
		const profileConfig = resolveRLModelProfileConfig(
			options.modelProfile ?? process.env.RL_MODEL_PROFILE,
			options.allowVoluntarySwitches ?? parseBooleanOption(process.env.RL_ALLOW_VOLUNTARY_SWITCHES),
		);
		const envTransport = process.env.RL_MODEL_TRANSPORT;
		const transport = options.transport || (envTransport === "ipc" || envTransport === "local" ? envTransport : "http");
		const endpoint = options.endpoint || (
			transport === "ipc" ? "ipc://word-policy" :
			transport === "local" ? "local://default" :
			"http://127.0.0.1:5000/predict"
		);
		const modelID = options.modelID ?? process.env.RL_MODEL_ID;
		this.modelID = modelID;
		this.modelProfile = profileConfig.profile;
		this.allowVoluntarySwitches = profileConfig.allowVoluntarySwitches;
		this.requiresStateVector = modelID !== "word_policy_v1";
		this.useCompactWordPolicyPayload = modelID === "word_policy_v1";
		this.onDecision = options.onDecision;
		if (transport === "local" && modelID === "word_policy_v1") {
			ensureLocalWordPolicyHandler(endpoint);
		}
		this.modelClient = new RLModelClient({
			endpoint,
			transport,
			modelID,
			modelProfile: this.modelProfile,
		});
	}
	override receive(chunk: string): void {
		this.tracker.applyChunk(chunk);
		super.receive(chunk);
	}

	override receiveError(error: Error) {
		if (error.message.startsWith("[Unavailable choice]")) return;
		if (error.message.startsWith("[Invalid choice]")) {
			console.error("Last model decision payload:");
			console.error(this.stringifyForLog(this.modelClient.lastRequest));
			console.error("Last model decision response:");
			console.error(this.stringifyForLog(this.modelClient.lastResponse));
			console.error(`Error side: ${this.describeErrorSide()}`);
		}
		throw error;
	}

	override async receiveRequest(request: ChoiceRequest) {
		this.tracker.applyRequest(request);
		this.lastRequestSide = request.side.id;
		const perspective: RLRequestSide = request.side.id === 'p1' ? 'p1' : 'p2';
		const requestSide: RLRequestSide = perspective;
		if (request.wait) return;
		const decisionStart = Date.now();

		try {
			// === FORCE SWITCH ===
			if (request.forceSwitch) {
				rlAgentMetrics.actions.forceSwitchRequests++;
				const pokemon = request.side.pokemon;
				const hasReviveRequest = hasReviveSelectionRequest(pokemon);
				if (hasReviveRequest) rlAgentMetrics.actions.forceSwitchRequestsWithReviveSelection++;
				const legalSwitches = hasReviveRequest ? [] : buildLegalSwitchTargets(requestSide, pokemon, this.getStableSlot);
				const legalRevives = hasReviveRequest ? buildLegalReviveTargets(requestSide, pokemon, this.getStableSlot) : [];
				const fallbackTargets = legalRevives.length ? legalRevives : legalSwitches;
				const recordedAt = new Date().toISOString();

				if (!fallbackTargets.length) {
					rlAgentMetrics.actions.passChoices++;
					this.captureDecision({
						recordedAt,
						perspectivePlayer: perspective,
						requestKind: "forceSwitch",
						modelRequest: null,
						modelResponse: null,
						chosenAction: "pass",
						usedFallback: true,
					});
					this.choose("pass");
					return;
				}
				const {snapshot, stateVector} = this.buildModelState(perspective);
				const modelData = {
					...(this.modelID ? {model_id: this.modelID} : {}),
					...(stateVector ? {state_vector: stateVector} : {}),
					battle_state: snapshot,
					perspective_player: perspective,
					legal_moves: [],
					legal_switches: legalSwitches,
					legal_revives: legalRevives,
					...(this.useCompactWordPolicyPayload ? {} : {
						forceSwitch: request.forceSwitch,
						reviving: hasReviveRequest,
						side: request.side,
					}),
				};

				const action = await this.queryModel(modelData);
				const switchSlot = extractSwitchSlot(action);
				if ((action.type === "switch" || action.type === "revive") && switchSlot) {
					if (action.type === "revive") rlAgentMetrics.actions.modelReviveChoices++;
					else rlAgentMetrics.actions.modelForceSwitchChoices++;
					this.captureDecision({
						recordedAt,
						perspectivePlayer: perspective,
						requestKind: "forceSwitch",
						modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
						modelResponse: this.cloneForCapture(action),
						chosenAction: `switch ${switchSlot}`,
						usedFallback: false,
					});
					this.chooseSwitchLikeAction(switchSlot);
				} else {
					const fallbackSlot = requestSlotForChoice(fallbackTargets[0]);
					if (fallbackSlot) {
						rlAgentMetrics.actions.fallbackForceSwitchChoices++;
						this.captureDecision({
							recordedAt,
							perspectivePlayer: perspective,
							requestKind: "forceSwitch",
							modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
							modelResponse: this.cloneForCapture(action),
							chosenAction: `switch ${fallbackSlot}`,
							usedFallback: true,
						});
						this.chooseSwitchLikeAction(fallbackSlot);
					} else {
						rlAgentMetrics.actions.passChoices++;
						this.captureDecision({
							recordedAt,
							perspectivePlayer: perspective,
							requestKind: "forceSwitch",
							modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
							modelResponse: this.cloneForCapture(action),
							chosenAction: "pass",
							usedFallback: true,
						});
						this.choose("pass");
					}
				}

				return;
			} else if (request.teamPreview) {
				rlAgentMetrics.actions.teamPreviewRequests++;
				this.captureDecision({
					recordedAt: new Date().toISOString(),
					perspectivePlayer: perspective,
					requestKind: "teamPreview",
					modelRequest: null,
					modelResponse: null,
					chosenAction: "default",
					usedFallback: false,
				});
				this.choose(this.chooseTeamPreview(request.side.pokemon));
			}

			// === MOVE REQUEST (1v1 ONLY) ===
			else if (request.active) {
				rlAgentMetrics.actions.moveTurnRequests++;
				const active = request.active[0];
				const pokemon = getPrimaryActivePokemon(request.side.pokemon);

				if (!pokemon || pokemon.condition.endsWith(" fnt")) {
					rlAgentMetrics.actions.passChoices++;
					this.choose("pass");
					return;
				}

				const possibleMoves = buildLegalMoveOptions(active);

				const availableSwitches = buildLegalSwitchTargets(requestSide, request.side.pokemon, this.getStableSlot);
				if (availableSwitches.length) rlAgentMetrics.actions.moveTurnRequestsWithSwitchOptions++;
				const canSwitch = this.allowVoluntarySwitches ? availableSwitches : [];
				if (!this.allowVoluntarySwitches && availableSwitches.length) {
					rlAgentMetrics.actions.voluntarySwitchOptionsSuppressed++;
				}
				const {snapshot, stateVector} = this.buildModelState(perspective);
				const modelData = {
					...(this.modelID ? {model_id: this.modelID} : {}),
					...(stateVector ? {state_vector: stateVector} : {}),
					battle_state: snapshot,
					perspective_player: perspective,
					legal_moves: possibleMoves,
					legal_switches: canSwitch,
					active: this.useCompactWordPolicyPayload
						? [{trapped: !!active?.trapped, maybeTrapped: !!active?.maybeTrapped}]
						: request.active,
					...(this.useCompactWordPolicyPayload ? {} : {side: request.side}),
				};
				
				const modelResponse = await this.queryModel(modelData);
				const moveSlot = modelResponse?.best_move?.slot;
				const moveChoiceSlot = typeof moveSlot === "number" || typeof moveSlot === "string" ? moveSlot : null;
				const switchSlot = extractSwitchSlot(modelResponse);
				if (modelResponse.type === "move" && moveChoiceSlot !== null) {
					rlAgentMetrics.actions.modelMoveChoices++;
					this.captureDecision({
						recordedAt: new Date().toISOString(),
						perspectivePlayer: perspective,
						requestKind: "move",
						modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
						modelResponse: this.cloneForCapture(modelResponse),
						chosenAction: `move ${String(moveChoiceSlot)}`,
						usedFallback: false,
					});
					this.choose(`move ${String(moveChoiceSlot)}`);
				} else if ((modelResponse.type === "switch" || modelResponse.type === "revive") && switchSlot) {
					if (modelResponse.type === "revive") rlAgentMetrics.actions.modelReviveChoices++;
					else rlAgentMetrics.actions.modelVoluntarySwitchChoices++;
					this.captureDecision({
						recordedAt: new Date().toISOString(),
						perspectivePlayer: perspective,
						requestKind: "move",
						modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
						modelResponse: this.cloneForCapture(modelResponse),
						chosenAction: `switch ${switchSlot}`,
						usedFallback: false,
					});
					this.chooseSwitchLikeAction(switchSlot);
				} else {
					// safe fallback
					if (possibleMoves.length) {
						rlAgentMetrics.actions.fallbackMoveChoices++;
						this.captureDecision({
							recordedAt: new Date().toISOString(),
							perspectivePlayer: perspective,
							requestKind: "move",
							modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
							modelResponse: this.cloneForCapture(modelResponse),
							chosenAction: `move ${possibleMoves[0].slot}`,
							usedFallback: true,
						});
						this.choose(`move ${possibleMoves[0].slot}`);
					} else {
						const fallbackSlot = requestSlotForChoice(availableSwitches[0]);
						if (fallbackSlot) {
							rlAgentMetrics.actions.fallbackMoveTurnSwitchChoices++;
							this.captureDecision({
								recordedAt: new Date().toISOString(),
								perspectivePlayer: perspective,
								requestKind: "move",
								modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
								modelResponse: this.cloneForCapture(modelResponse),
								chosenAction: `switch ${fallbackSlot}`,
								usedFallback: true,
							});
							this.chooseSwitchLikeAction(fallbackSlot);
						} else {
							rlAgentMetrics.actions.passChoices++;
							this.captureDecision({
								recordedAt: new Date().toISOString(),
								perspectivePlayer: perspective,
								requestKind: "move",
								modelRequest: this.cloneForCapture(this.modelClient.lastRequest || modelData),
								modelResponse: this.cloneForCapture(modelResponse),
								chosenAction: "pass",
								usedFallback: true,
							});
							this.choose("pass");
						}
					}
				}
			}
		} finally {
			recordTiming(rlAgentMetrics.decisions, Date.now() - decisionStart);
		}
	}

	

	/**
	 * Sends battle state to Python model
	 */
	private async queryModel(modelData: any): Promise<any> {
		const requestStart = Date.now();
		let succeeded = false;

		try {
			const response = await this.modelClient.query(modelData, data => this.describeErrorSide(data));
			succeeded = true;
			return response;
		} finally {
			recordTiming(rlAgentMetrics.modelRequests, Date.now() - requestStart);
			if (succeeded) rlAgentMetrics.modelRequestSuccesses++;
			else rlAgentMetrics.modelRequestFailures++;
		}
	}

	private describeErrorSide(modelData: AnyObject | null = this.modelClient.lastRequest): string {
		const side = modelData?.side;
		const sideID = side?.id || this.lastRequestSide;
		const sideName = side?.name;
		const sideIDText = sideID ? String(sideID) : "";
		const sideNameText = sideName ? String(sideName) : "";
		if (sideIDText && sideNameText) return `${sideIDText} (${sideNameText})`;
		if (sideID) return String(sideID);
		if (sideName) return String(sideName);
		return "unknown";
	}

	private stringifyForLog(value: any): string {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	private buildModelState(perspective: "p1" | "p2"): {snapshot: AnyObject, stateVector?: number[]} {
		const buildStart = Date.now();
		try {
			const snapshot = this.tracker.getSnapshot();
			return {
				snapshot,
				...(this.requiresStateVector ? {stateVector: this.tracker.encodeState(snapshot, perspective)} : {}),
			};
		} finally {
			recordTiming(rlAgentMetrics.stateVectorBuilds, Date.now() - buildStart);
		}
	}

	private chooseSwitchLikeAction(slot: number) {
		// Revival Blessing target selection is routed through the switch chooser in Side#choose.
		this.choose(`switch ${slot}`);
	}

	private getStableSlot = (player: "p1" | "p2", ident?: string, details?: string) => {
		return this.tracker.getOwnStableSlot(player, ident, details);
	}
	protected chooseTeamPreview(team: AnyObject[]): string {
		return `default`;
	}

	private captureDecision(record: RLAgentDecisionRecord) {
		if (!this.onDecision) return;
		this.onDecision?.(record);
	}

	private cloneForCapture(value: AnyObject | null) {
		if (!this.onDecision) return value;
		if (!value) return null;
		try {
			return JSON.parse(JSON.stringify(value));
		} catch {
			return value;
		}
	}
}
