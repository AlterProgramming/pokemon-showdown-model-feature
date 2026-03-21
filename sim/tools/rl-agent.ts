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
	private readonly endpoint: string;
	private readonly modelID: string | undefined;
	private readonly modelProfile: RLModelProfile;
	private readonly allowVoluntarySwitches: boolean;
	private tracker = new ProtocolStateTracker();
	private lastModelData: AnyObject | null = null;
	private lastModelResponse: AnyObject | null = null;
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
		this.endpoint = options.endpoint || "http://127.0.0.1:5000/predict";
		this.modelID = options.modelID ?? process.env.RL_MODEL_ID;
		this.modelProfile = profileConfig.profile;
		this.allowVoluntarySwitches = profileConfig.allowVoluntarySwitches;
	}
	override receive(chunk: string): void {
		this.tracker.applyChunk(chunk);
		super.receive(chunk);
	}

	override receiveError(error: Error) {
		if (error.message.startsWith("[Unavailable choice]")) return;
		if (error.message.startsWith("[Invalid choice]")) {
			console.error("Last model decision payload:");
			console.error(this.stringifyForLog(this.lastModelData));
			console.error("Last model decision response:");
			console.error(this.stringifyForLog(this.lastModelResponse));
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
				const hasReviveRequest = this.hasReviveSelectionRequest(pokemon);
				if (hasReviveRequest) rlAgentMetrics.actions.forceSwitchRequestsWithReviveSelection++;
				const legalSwitches = hasReviveRequest ? [] : this.buildLegalSwitchTargets(request.side.id, pokemon);
				const legalRevives = hasReviveRequest ? this.buildLegalReviveTargets(request.side.id, pokemon) : [];
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
				const switchSlot = this.extractSwitchSlot(action);
				if ((action.type === "switch" || action.type === "revive") && switchSlot) {
					if (action.type === "revive") rlAgentMetrics.actions.modelReviveChoices++;
					else rlAgentMetrics.actions.modelForceSwitchChoices++;
					this.chooseSwitchLikeAction(switchSlot);
				} else {
					const fallbackSlot = this.requestSlotForChoice(fallbackTargets[0]);
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
				const pokemon = this.getPrimaryActivePokemon(request.side.pokemon);

				if (!pokemon || pokemon.condition.endsWith(" fnt")) {
					rlAgentMetrics.actions.passChoices++;
					this.choose("pass");
					return;
				}

				const possibleMoves = active.moves
					.map((m: any, i: number) => ({
						slot: i + 1,
						move: m.move,
						id: m.id,
						disabled: m.disabled,
					}))
					.filter((m: any) => !m.disabled);

				const availableSwitches = this.buildLegalSwitchTargets(request.side.id, request.side.pokemon);
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
				const switchSlot = this.extractSwitchSlot(modelResponse);
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
						const fallbackSlot = this.requestSlotForChoice(availableSwitches[0]);
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
		let responseStatus: number | undefined;
		let responseStatusText: string | undefined;
		let responseBody: string | undefined;
		const requestStart = Date.now();
		let succeeded = false;

		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(modelData),
			});

			responseStatus = response.status;
			responseStatusText = response.statusText;
			responseBody = await response.text();

			if (!response.ok) {
				throw new Error(`Model request failed: ${response.status}`);
			}

			try {
				const parsedResponse = responseBody ? JSON.parse(responseBody) : null;
				this.lastModelData = modelData;
				this.lastModelResponse = parsedResponse;
				succeeded = true;
				return parsedResponse;
			} catch {
				throw new Error("Model response was not valid JSON.");
			}
		} catch (error) {
			this.logModelExchange(modelData, responseStatus, responseStatusText, responseBody);
			throw error;
		} finally {
			recordTiming(rlAgentMetrics.modelRequests, Date.now() - requestStart);
			if (succeeded) rlAgentMetrics.modelRequestSuccesses++;
			else rlAgentMetrics.modelRequestFailures++;
		}
	}

	private logModelExchange(
		modelData: any,
		responseStatus?: number,
		responseStatusText?: string,
		responseBody?: string,
	) {
		console.error("Model exchange failed.");
		if (this.modelID) console.error(`Model ID: ${this.modelID}`);
		console.error(`Model profile: ${this.modelProfile}`);
		console.error(`Endpoint: ${this.endpoint}`);
		console.error("Request payload:");
		console.error(this.stringifyForLog(modelData));
		if (responseStatus !== undefined) {
			console.error(`Response status: ${responseStatus} ${responseStatusText || ""}`.trim());
		} else {
			console.error("Response status: unavailable");
		}
		console.error("Response body:");
		console.error(responseBody && responseBody.length ? responseBody : "<empty>");
		console.error(`Error side: ${this.describeErrorSide(modelData)}`);
	}

	private describeErrorSide(modelData: AnyObject | null = this.lastModelData): string {
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

	private getPrimaryActivePokemon(team: AnyObject[]): AnyObject | undefined {
		return team.find(pokemon => !!pokemon.active) || team[0];
	}

	private hasReviveSelectionRequest(team: AnyObject[]): boolean {
		return team.some(pokemon => !!pokemon.active && !!pokemon.reviving);
	}

	private buildLegalSwitchTargets(player: "p1" | "p2", team: AnyObject[]): AnyObject[] {
		return team
			.map((pokemon, i) => ({
				slot: this.tracker.getOwnStableSlot(player, pokemon.ident, pokemon.details) || i + 1,
				request_slot: i + 1,
				ident: pokemon.ident,
				details: pokemon.details,
				condition: pokemon.condition,
				active: !!pokemon.active,
				fainted: pokemon.condition.endsWith(" fnt"),
				reviving: !!pokemon.reviving,
				canSwitch: !pokemon.active && !pokemon.condition.endsWith(" fnt"),
			}))
			.filter(target => target.canSwitch);
	}

	private buildLegalReviveTargets(player: "p1" | "p2", team: AnyObject[]): AnyObject[] {
		return team
			.map((pokemon, i) => ({
				slot: this.tracker.getOwnStableSlot(player, pokemon.ident, pokemon.details) || i + 1,
				request_slot: i + 1,
				ident: pokemon.ident,
				details: pokemon.details,
				condition: pokemon.condition,
				active: !!pokemon.active,
				fainted: pokemon.condition.endsWith(" fnt"),
				reviving: !!pokemon.reviving,
				canRevive: pokemon.condition.endsWith(" fnt"),
			}))
			.filter(target => target.canRevive);
	}

	private chooseSwitchLikeAction(slot: number) {
		// Revival Blessing target selection is routed through the switch chooser in Side#choose.
		this.choose(`switch ${slot}`);
	}

	private requestSlotForChoice(choice: AnyObject | undefined): number | undefined {
		return choice?.request_slot ?? choice?.slot;
	}

	private extractSwitchSlot(modelResponse: any): number | undefined {
		return this.requestSlotForChoice(modelResponse?.best_switch) ??
			this.requestSlotForChoice(modelResponse?.best_revive) ??
			modelResponse?.slot ??
			modelResponse?.best_switch?.slot ??
			modelResponse?.best_revive?.slot;
	}
	protected chooseTeamPreview(team: AnyObject[]): string {
		return `default`;
	}
}
