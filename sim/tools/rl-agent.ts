/**
 * RL Agent Player AI
 * Uses external Python model via HTTP fetch.
 * Assumes:
 *  - 1v1 battles
 *  - No mega, z-move, dynamax, tera
 */

import type { ObjectReadWriteStream } from "../../lib/streams";
import { BattlePlayer } from "../battle-stream";
import type { ChoiceRequest } from "../side";
import { ProtocolStateTracker } from "./protocol-state-tracker";
import {parseBooleanOption, resolveRLModelProfileConfig, type RLModelProfile} from "./rl-model-profiles";
import { RLModelClient } from "./rl-model-client";
import {
	buildLegalMoveOptions,
	buildLegalReviveTargets,
	buildLegalSwitchTargets,
	extractSwitchSlot,
	getPrimaryActivePokemon,
	hasReviveSelectionRequest,
	requestSlotForChoice,
} from "./rl-action-helpers";

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
	private readonly modelClient: RLModelClient;
	private tracker = new ProtocolStateTracker();
	private lastRequestSide: string | undefined;
	constructor(
		playerStream: ObjectReadWriteStream<string>,
		options: {
			endpoint?: string;
			modelID?: string;
			modelProfile?: RLModelProfile;
			allowVoluntarySwitches?: boolean;
		} = {},
		debug = false,
	) {
		super(playerStream, debug);
		const profileConfig = resolveRLModelProfileConfig(
			options.modelProfile ?? process.env.RL_MODEL_PROFILE,
			options.allowVoluntarySwitches ?? parseBooleanOption(process.env.RL_ALLOW_VOLUNTARY_SWITCHES),
		);
		const endpoint = options.endpoint || "http://127.0.0.1:5000/predict";
		const modelID = options.modelID ?? process.env.RL_MODEL_ID;
		this.modelID = modelID;
		this.modelProfile = profileConfig.profile;
		this.allowVoluntarySwitches = profileConfig.allowVoluntarySwitches;
		this.modelClient = new RLModelClient({
			endpoint,
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
		const perspective = request.side.id === 'p1' ? 'p1' : 'p2';
		if (request.wait) return;
		const decisionStart = Date.now();

		try {
			// === FORCE SWITCH ===
			if (request.forceSwitch) {
				rlAgentMetrics.actions.forceSwitchRequests++;
				const pokemon = request.side.pokemon;
				const hasReviveRequest = hasReviveSelectionRequest(pokemon);
				if (hasReviveRequest) rlAgentMetrics.actions.forceSwitchRequestsWithReviveSelection++;
				const legalSwitches = hasReviveRequest ? [] : buildLegalSwitchTargets(request.side.id, pokemon, this.getStableSlot);
				const legalRevives = hasReviveRequest ? buildLegalReviveTargets(request.side.id, pokemon, this.getStableSlot) : [];
				const fallbackTargets = legalRevives.length ? legalRevives : legalSwitches;

				if (!fallbackTargets.length) {
					rlAgentMetrics.actions.passChoices++;
					this.choose("pass");
					return;
				}
				const stateVector = this.buildStateVector(perspective);
				const modelData = {
					...(this.modelID ? {model_id: this.modelID} : {}),
					state_vector: stateVector,
					legal_moves: [],
					legal_switches: legalSwitches,
					legal_revives: legalRevives,
					forceSwitch: request.forceSwitch,
					reviving: hasReviveRequest,
					side: request.side,
				};

				const action = await this.queryModel(modelData);
				const switchSlot = extractSwitchSlot(action);
				if ((action.type === "switch" || action.type === "revive") && switchSlot) {
					if (action.type === "revive") rlAgentMetrics.actions.modelReviveChoices++;
					else rlAgentMetrics.actions.modelForceSwitchChoices++;
					this.chooseSwitchLikeAction(switchSlot);
				} else {
					const fallbackSlot = requestSlotForChoice(fallbackTargets[0]);
					if (fallbackSlot) {
						rlAgentMetrics.actions.fallbackForceSwitchChoices++;
						this.chooseSwitchLikeAction(fallbackSlot);
					} else {
						rlAgentMetrics.actions.passChoices++;
						this.choose("pass");
					}
				}

				return;
			} else if (request.teamPreview) {
				rlAgentMetrics.actions.teamPreviewRequests++;
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

				const availableSwitches = buildLegalSwitchTargets(request.side.id, request.side.pokemon, this.getStableSlot);
				if (availableSwitches.length) rlAgentMetrics.actions.moveTurnRequestsWithSwitchOptions++;
				const canSwitch = this.allowVoluntarySwitches ? availableSwitches : [];
				if (!this.allowVoluntarySwitches && availableSwitches.length) {
					rlAgentMetrics.actions.voluntarySwitchOptionsSuppressed++;
				}
				const stateVector = this.buildStateVector(perspective);
				const modelData = {
					...(this.modelID ? {model_id: this.modelID} : {}),
					state_vector: stateVector,
					legal_moves: possibleMoves,
					legal_switches: canSwitch,
					active: request.active,
					side: request.side,
				};
				
				const modelResponse = await this.queryModel(modelData);
				const moveSlot = modelResponse?.best_move?.slot;
				const switchSlot = extractSwitchSlot(modelResponse);
				if (modelResponse.type === "move" && moveSlot) {
					rlAgentMetrics.actions.modelMoveChoices++;
					this.choose(`move ${moveSlot}`);
				} else if ((modelResponse.type === "switch" || modelResponse.type === "revive") && switchSlot) {
					if (modelResponse.type === "revive") rlAgentMetrics.actions.modelReviveChoices++;
					else rlAgentMetrics.actions.modelVoluntarySwitchChoices++;
					this.chooseSwitchLikeAction(switchSlot);
				} else {
					// safe fallback
					if (possibleMoves.length) {
						rlAgentMetrics.actions.fallbackMoveChoices++;
						this.choose(`move ${possibleMoves[0].slot}`);
					} else {
						const fallbackSlot = requestSlotForChoice(availableSwitches[0]);
						if (fallbackSlot) {
							rlAgentMetrics.actions.fallbackMoveTurnSwitchChoices++;
							this.chooseSwitchLikeAction(fallbackSlot);
						} else {
							rlAgentMetrics.actions.passChoices++;
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
		if (sideID && sideName) return `${sideID} (${sideName})`;
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

	private buildStateVector(perspective: "p1" | "p2"): number[] {
		const buildStart = Date.now();
		try {
			const snapshot = this.tracker.getSnapshot();
			return this.tracker.encodeState(snapshot, perspective);
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
}
