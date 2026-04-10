import type {SideRequestData} from '../side';

export type RLRequestSide = 'p1' | 'p2';

export type RLChoiceTarget = {
	slot: number;
	request_slot: number;
	ident: string;
	details: string;
	condition: string;
	active: boolean;
	fainted: boolean;
	reviving: boolean;
};

export type RLMoveOption = {
	slot: number;
	move: string;
	id: string;
	disabled: boolean;
};

type StableSlotResolver = (player: RLRequestSide, ident?: string, details?: string) => number | undefined;
type RLChoicePokemon = {
	ident: string;
	details: string;
	condition: string;
	active?: boolean;
	reviving?: boolean;
};
type RLMoveRequest = {
	moves?: {
		move: string;
		id: string;
		disabled?: string | boolean;
	}[];
};

function buildChoiceTargets(
	player: RLRequestSide,
	team: RLChoicePokemon[],
	resolveStableSlot: StableSlotResolver,
	predicate: (target: RLChoiceTarget) => boolean,
) {
	return team
		.map((pokemon, i) => ({
			slot: resolveStableSlot(player, pokemon.ident, pokemon.details) || i + 1,
			request_slot: i + 1,
			ident: pokemon.ident,
			details: pokemon.details,
			condition: pokemon.condition,
			active: !!pokemon.active,
			fainted: pokemon.condition.endsWith(' fnt'),
			reviving: !!pokemon.reviving,
		}))
		.filter(target => predicate(target));
}

export function getPrimaryActivePokemon(team: SideRequestData['pokemon']) {
	return team.find(pokemon => !!pokemon.active) || team[0];
}

export function hasReviveSelectionRequest(team: SideRequestData['pokemon']) {
	return team.some(pokemon => !!pokemon.active && !!pokemon.reviving);
}

export function buildLegalSwitchTargets(
	player: RLRequestSide,
	team: SideRequestData['pokemon'],
	resolveStableSlot: StableSlotResolver,
): RLChoiceTarget[] {
	return buildChoiceTargets(
		player,
		team,
		resolveStableSlot,
		target => !target.active && !target.fainted,
	);
}

export function buildLegalReviveTargets(
	player: RLRequestSide,
	team: SideRequestData['pokemon'],
	resolveStableSlot: StableSlotResolver,
): RLChoiceTarget[] {
	return buildChoiceTargets(
		player,
		team,
		resolveStableSlot,
		target => target.fainted,
	);
}

export function buildLegalMoveOptions(active: RLMoveRequest) {
	return (active.moves || [])
		.map((move, i) => ({
			slot: i + 1,
			move: move.move,
			id: move.id,
			disabled: !!move.disabled,
		}))
		.filter(move => !move.disabled);
}

export function requestSlotForChoice(choice: Partial<RLChoiceTarget> | undefined): number | undefined {
	return choice?.request_slot ?? choice?.slot;
}

export function extractSwitchSlot(modelResponse: AnyObject | undefined): number | undefined {
	return requestSlotForChoice(modelResponse?.best_switch) ??
		requestSlotForChoice(modelResponse?.best_revive) ??
		modelResponse?.slot ??
		modelResponse?.best_switch?.slot ??
		modelResponse?.best_revive?.slot;
}
