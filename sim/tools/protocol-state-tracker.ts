/**********************************************************************
 * ProtocolStateTracker
 * Reconstructs the public battle snapshot consumed by the Python model.
 **********************************************************************/

import {Dex, toID} from '../dex';
import type {ChoiceRequest, SideRequestData} from '../side';

export type PlayerID = 'p1' | 'p2';

const STAT_ORDER = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;
const STATUS_ORDER = ['brn', 'par', 'psn', 'tox', 'slp', 'frz'] as const;
const WEATHER_ORDER = ['raindance', 'sunnyday', 'sandstorm', 'snow'] as const;
const GLOBAL_CONDITION_ORDER = [
	'electricterrain',
	'grassyterrain',
	'mistyterrain',
	'psychicterrain',
	'trickroom',
] as const;
const SIDE_CONDITION_ORDER = [
	'stealthrock',
	'stickyweb',
	'spikes',
	'toxicspikes',
	'reflect',
	'lightscreen',
	'auroraveil',
	'tailwind',
] as const;

const SIDE_CONDITION_CAPS: Partial<Record<string, number>> = {
	spikes: 3,
	toxicspikes: 2,
};

type StatID = typeof STAT_ORDER[number];
type StatusID = typeof STATUS_ORDER[number];

interface MonState {
	uid: string;
	player: PlayerID;
	name?: string;
	species?: string;
	hp?: number;
	maxHP?: number;
	fainted: boolean;
	status?: StatusID;
	ability?: string;
	item?: string;
	teraType?: string;
	terastallized: boolean;
	publicRevealed: boolean;
	boosts: Record<StatID, number>;
	observedMoves: string[];
}

interface SideState {
	activeUid?: string;
	slots: (string | undefined)[];
	sideConditions: Record<string, number>;
}

interface ParsedCondition {
	hp?: number;
	maxHP?: number;
	status?: StatusID;
	fainted?: boolean;
}

interface SnapshotMon {
	uid: string;
	player: PlayerID;
	species?: string;
	hp?: number;
	max_hp?: number;
	hp_frac?: number;
	status?: StatusID;
	ability?: string;
	item?: string;
	tera_type?: string;
	terastallized: boolean;
	public_revealed: boolean;
	fainted: boolean;
	boosts: Record<StatID, number>;
	observed_moves: string[];
}

interface SnapshotSide {
	active_uid?: string;
	slots: (string | undefined)[];
	side_conditions: Record<string, number>;
}

interface BattleSnapshot {
	turn_index: number;
	field: {
		weather?: string;
		global_conditions: string[];
	};
	p1: SnapshotSide;
	p2: SnapshotSide;
	mons: Record<string, SnapshotMon>;
}

export class ProtocolStateTracker {
	private turnIndex = 0;
	private perspectivePlayer: PlayerID | null = null;
	private revealCounter: Record<PlayerID, number> = {p1: 0, p2: 0};
	private weather?: string;
	private globalConditions = new Set<string>();

	private mons = new Map<string, MonState>();
	private sides: Record<PlayerID, SideState> = {
		p1: {slots: new Array(6).fill(undefined), sideConditions: {}},
		p2: {slots: new Array(6).fill(undefined), sideConditions: {}},
	};

	applyChunk(chunk: string) {
		for (const line of chunk.split('\n')) {
			if (!line.startsWith('|')) continue;
			this.applyLine(line);
		}
	}

	applyRequest(request: ChoiceRequest) {
		if (!this.isPlayerID(request.side.id)) return;
		const player = request.side.id;
		this.perspectivePlayer = player;
		this.hydrateOwnSide(request.side as SideRequestData & {id: PlayerID});
		if (Array.isArray(request.active) && request.active.length && this.sides[player].activeUid) {
			const mon = this.mons.get(this.sides[player].activeUid!);
			const moveEntries = request.active[0]?.moves || [];
			if (mon && Array.isArray(moveEntries)) {
				for (const moveEntry of moveEntries) {
					const moveID = this.normalizeMoveName(moveEntry?.id || moveEntry?.move);
					if (moveID && !mon.observedMoves.includes(moveID)) {
						mon.observedMoves.push(moveID);
					}
				}
				if (request.active[0]?.canTerastallize && !mon.teraType) {
					mon.teraType = request.active[0].canTerastallize;
				}
			}
		}
	}

	getSnapshot(): BattleSnapshot {
		return {
			turn_index: this.turnIndex,
			field: {
				weather: this.weather,
				global_conditions: [...this.globalConditions].sort(),
			},
			p1: {
				active_uid: this.sides.p1.activeUid,
				slots: [...this.sides.p1.slots],
				side_conditions: {...this.sides.p1.sideConditions},
			},
			p2: {
				active_uid: this.sides.p2.activeUid,
				slots: [...this.sides.p2.slots],
				side_conditions: {...this.sides.p2.sideConditions},
			},
			mons: Object.fromEntries(
				[...this.mons.entries()].map(([uid, mon]) => [uid, {
					uid: mon.uid,
					player: mon.player,
					species: mon.species,
					hp: mon.hp,
					max_hp: mon.maxHP,
					hp_frac: this.hpFrac(mon),
					status: mon.status,
					ability: mon.ability,
					item: mon.item,
					tera_type: mon.teraType,
					terastallized: mon.terastallized,
					public_revealed: mon.publicRevealed,
					fainted: mon.fainted,
					boosts: {...mon.boosts},
					observed_moves: [...mon.observedMoves],
				}]),
			) as Record<string, SnapshotMon>,
		};
	}

	getOwnStableSlot(player: PlayerID, ident?: string, details?: string): number | undefined {
		const uid = this.findOwnUID(player, ident, details);
		if (!uid) return undefined;
		const slot = this.sides[player].slots.indexOf(uid);
		return slot >= 0 ? slot + 1 : undefined;
	}

	encodeState(state: BattleSnapshot, perspectivePlayer = this.perspectivePlayer || 'p2'): number[] {
		const other = perspectivePlayer === 'p1' ? 'p2' : 'p1';
		const mons = state.mons;
		const myActive = state[perspectivePlayer].active_uid ? mons[state[perspectivePlayer].active_uid!] : undefined;
		const oppActive = state[other].active_uid ? mons[state[other].active_uid!] : undefined;

		const vec: number[] = [];
		vec.push(...this.monFeatures(myActive, perspectivePlayer));
		vec.push(...this.monFeatures(oppActive, perspectivePlayer));

		for (const uid of state[perspectivePlayer].slots) {
			vec.push(...this.benchSlotFeatures(uid ? mons[uid] : undefined, perspectivePlayer));
		}
		for (const uid of state[other].slots) {
			vec.push(...this.benchSlotFeatures(uid ? mons[uid] : undefined, perspectivePlayer));
		}

		vec.push(...this.fieldFeatures(state));
		vec.push(...this.sideConditionFeatures(state[perspectivePlayer]));
		vec.push(...this.sideConditionFeatures(state[other]));
		vec.push(Math.min(state.turn_index || 0, 50) / 50);

		return vec;
	}

	private applyLine(line: string) {
		const parts = line.split('|').slice(1);
		const type = parts[0];

		switch (type) {
		case 'turn':
			this.turnIndex = parseInt(parts[1]) || this.turnIndex;
			break;
		case 'switch':
		case 'drag':
			this.handleSwitch(parts[1], parts[2], parts[3]);
			break;
		case 'detailschange':
		case 'replace':
			this.handleDetailsChange(parts[1], parts[2], parts[3]);
			break;
		case 'move':
			this.handleMove(parts[1], parts[2], parts[3]);
			break;
		case 'faint':
			this.handleFaint(parts[1]);
			break;
		case '-damage':
		case '-heal':
		case '-sethp':
			this.handleHPChange(parts[1], parts[2]);
			break;
		case '-status':
			this.handleStatus(parts[1], parts[2]);
			break;
		case '-curestatus':
			this.handleCureStatus(parts[1], parts[2]);
			break;
		case '-cureteam':
			this.handleCureTeam(parts[1]);
			break;
		case '-boost':
			this.handleBoost(parts[1], parts[2], parts[3]);
			break;
		case '-unboost':
			this.handleBoost(parts[1], parts[2], `-${parts[3]}`);
			break;
		case '-setboost':
			this.handleSetBoost(parts[1], parts[2], parts[3]);
			break;
		case '-clearboost':
			this.handleClearBoost(parts[1]);
			break;
		case '-clearallboost':
			this.handleClearAllBoost();
			break;
		case '-clearpositiveboost':
			this.handleClearPositiveBoost(parts[1]);
			break;
		case '-clearnegativeboost':
			this.handleClearNegativeBoost(parts[1]);
			break;
		case '-copyboost':
			this.handleCopyBoost(parts[1], parts[2]);
			break;
		case '-swapboost':
			this.handleSwapBoost(parts[1], parts[2], parts[3]);
			break;
		case '-invertboost':
			this.handleInvertBoost(parts[1]);
			break;
		case '-weather':
			this.handleWeather(parts[1]);
			break;
		case '-fieldstart':
			this.handleFieldCondition(parts[1], true);
			break;
		case '-fieldend':
			this.handleFieldCondition(parts[1], false);
			break;
		case '-sidestart':
			this.handleSideCondition(parts[1], parts[2], true);
			break;
		case '-sideend':
			this.handleSideCondition(parts[1], parts[2], false);
			break;
		case '-swapsideconditions':
			this.handleSwapSideConditions();
			break;
		case '-ability':
			this.handleAbility(parts[1], parts[2]);
			break;
		case '-endability':
			this.handleEndAbility(parts[1]);
			break;
		case '-item':
			this.handleItem(parts[1], parts[2], false);
			break;
		case '-enditem':
			this.handleItem(parts[1], parts[2], true);
			break;
		case '-formechange':
			this.handleFormeChange(parts[1], parts[2], parts[3]);
			break;
		case '-terastallize':
			this.handleTerastallize(parts[1], parts[2]);
			break;
		case '-transform':
			this.handleTransform(parts[1], parts[2]);
			break;
		}
	}

	private hydrateOwnSide(side: SideRequestData & {id: PlayerID}) {
		const player = side.id;
		this.sides[player].activeUid = undefined;

		for (let i = 0; i < 6; i++) {
			const entry = side.pokemon[i];
			if (!entry) continue;

			const uid = this.findOwnUID(player, entry.ident, entry.details) || this.allocateOwnUID(player);
			if (!uid) continue;

			if (!this.sides[player].slots.includes(uid)) {
				this.registerSlot(player, uid);
			}

			const mon = this.ensureMon(uid, player);
			const refInfo = this.parseMonRef(entry.ident);
			const detailInfo = this.parseDetails(entry.details);
			const parsed = this.parseCondition(entry.condition);

			mon.name = refInfo.name || mon.name;
			mon.species = detailInfo.species || mon.species;
			mon.publicRevealed = true;
			if (parsed.maxHP !== undefined && mon.maxHP === undefined) {
				mon.maxHP = parsed.maxHP;
			}
			this.applyCondition(mon, parsed, {clearStatus: true});
			if (entry.item) {
				const item = Dex.items.get(entry.item).name || entry.item;
				mon.item = item;
			}
			const abilityID = entry.ability || entry.baseAbility;
			if (abilityID) {
				const ability = Dex.abilities.get(abilityID).name || abilityID;
				mon.ability = ability;
			}
			if (entry.teraType) {
				mon.teraType = entry.teraType;
			}
			if (entry.terastallized) {
				mon.terastallized = true;
				mon.teraType = entry.terastallized || mon.teraType;
			}
			if (Array.isArray(entry.moves)) {
				for (const moveName of entry.moves) {
					const moveID = this.normalizeMoveName(moveName);
					if (moveID && !mon.observedMoves.includes(moveID)) {
						mon.observedMoves.push(moveID);
					}
				}
			}
			if (entry.active) {
				this.markActive(player, uid);
			}
		}
	}

	private handleSwitch(ref: string | undefined, details: string | undefined, condition: string | undefined) {
		const player = this.playerFromRef(ref);
		if (!player) return;

		const uid = this.resolveSwitchUID(player, ref, details);
		const mon = this.ensureMon(uid, player);
		const refInfo = this.parseMonRef(ref);
		const detailInfo = this.parseDetails(details);

		mon.name = refInfo.name || mon.name;
		mon.species = detailInfo.species || mon.species;
		mon.publicRevealed = true;
		if (detailInfo.terastallized) {
			mon.terastallized = true;
			mon.teraType = detailInfo.teraType || mon.teraType;
		}
		this.markActive(player, uid);
	}

	private handleDetailsChange(ref: string | undefined, details: string | undefined, condition: string | undefined) {
		const uid = this.resolveActiveUID(ref, details, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		const refInfo = this.parseMonRef(ref);
		const detailInfo = this.parseDetails(details);

		mon.name = refInfo.name || mon.name;
		mon.species = detailInfo.species || mon.species;
		mon.publicRevealed = true;
		if (detailInfo.terastallized) {
			mon.terastallized = true;
			mon.teraType = detailInfo.teraType || mon.teraType;
		}
	}

	private handleMove(ref: string | undefined, moveName: string | undefined, targetRef: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (uid) {
			const mon = this.mons.get(uid)!;
			mon.publicRevealed = true;
			const moveID = this.normalizeMoveName(moveName);
			if (moveID && !mon.observedMoves.includes(moveID)) {
				mon.observedMoves.push(moveID);
			}
		}

		const actorPlayer = this.playerFromRef(ref);
		const targetPlayer = this.playerFromRef(targetRef);
		if (targetPlayer && targetPlayer !== actorPlayer) {
			const targetUID = this.resolveActiveUID(targetRef, undefined, true);
			if (targetUID) {
				this.mons.get(targetUID)!.publicRevealed = true;
			}
		}
	}

	private handleHPChange(ref: string | undefined, condition: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		mon.publicRevealed = true;
		this.applyCondition(mon, this.parseCondition(condition));
	}

	private handleFaint(ref: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		mon.fainted = true;
		mon.hp = 0;
		mon.publicRevealed = true;
		this.sides[mon.player].activeUid = undefined;
	}

	private handleStatus(ref: string | undefined, statusText: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		const status = this.normalizeStatus(statusText);
		if (!uid || !status) return;
		const mon = this.mons.get(uid)!;
		mon.status = status;
		mon.publicRevealed = true;
	}

	private handleCureStatus(ref: string | undefined, statusText: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		const status = this.normalizeStatus(statusText);
		if (!status || mon.status === status) mon.status = undefined;
	}

	private handleCureTeam(ref: string | undefined) {
		const player = this.playerFromRef(ref);
		if (!player) return;
		for (const uid of this.sides[player].slots) {
			if (!uid) continue;
			this.mons.get(uid)!.status = undefined;
		}
	}

	private handleBoost(ref: string | undefined, statText: string | undefined, amountText: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		const stat = this.normalizeStat(statText);
		const amount = parseInt(amountText || '');
		if (!uid || !stat || Number.isNaN(amount)) return;
		const mon = this.mons.get(uid)!;
		mon.publicRevealed = true;
		mon.boosts[stat] = this.clampBoost(mon.boosts[stat] + amount);
	}

	private handleSetBoost(ref: string | undefined, statText: string | undefined, amountText: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		const stat = this.normalizeStat(statText);
		const amount = parseInt(amountText || '');
		if (!uid || !stat || Number.isNaN(amount)) return;
		const mon = this.mons.get(uid)!;
		mon.publicRevealed = true;
		mon.boosts[stat] = this.clampBoost(amount);
	}

	private handleClearBoost(ref: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		this.mons.get(uid)!.boosts = this.emptyBoosts();
	}

	private handleClearAllBoost() {
		for (const mon of this.mons.values()) {
			mon.boosts = this.emptyBoosts();
		}
	}

	private handleClearPositiveBoost(ref: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const boosts = this.mons.get(uid)!.boosts;
		for (const stat of STAT_ORDER) {
			if (boosts[stat] > 0) boosts[stat] = 0;
		}
	}

	private handleClearNegativeBoost(ref: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const boosts = this.mons.get(uid)!.boosts;
		for (const stat of STAT_ORDER) {
			if (boosts[stat] < 0) boosts[stat] = 0;
		}
	}

	private handleCopyBoost(sourceRef: string | undefined, targetRef: string | undefined) {
		const sourceUID = this.resolveActiveUID(sourceRef, undefined, true);
		const targetUID = this.resolveActiveUID(targetRef, undefined, true);
		if (!sourceUID || !targetUID) return;
		this.mons.get(targetUID)!.boosts = {...this.mons.get(sourceUID)!.boosts};
	}

	private handleSwapBoost(sourceRef: string | undefined, targetRef: string | undefined, statsText: string | undefined) {
		const sourceUID = this.resolveActiveUID(sourceRef, undefined, true);
		const targetUID = this.resolveActiveUID(targetRef, undefined, true);
		if (!sourceUID || !targetUID) return;
		const source = this.mons.get(sourceUID)!;
		const target = this.mons.get(targetUID)!;
		for (const stat of (statsText || '').split(',').map(text => this.normalizeStat(text.trim())).filter(Boolean) as StatID[]) {
			[source.boosts[stat], target.boosts[stat]] = [target.boosts[stat], source.boosts[stat]];
		}
	}

	private handleInvertBoost(ref: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const boosts = this.mons.get(uid)!.boosts;
		for (const stat of STAT_ORDER) {
			boosts[stat] = this.clampBoost(-boosts[stat]);
		}
	}

	private handleWeather(weatherText: string | undefined) {
		const weather = this.normalizeEffectName(weatherText);
		if (!weather) return;
		this.weather = weather === 'none' ? undefined : weather;
	}

	private handleFieldCondition(conditionText: string | undefined, add: boolean) {
		const condition = this.normalizeEffectName(conditionText);
		if (!condition) return;
		if (add) {
			this.globalConditions.add(condition);
		} else {
			this.globalConditions.delete(condition);
		}
	}

	private handleSideCondition(sideText: string | undefined, conditionText: string | undefined, add: boolean) {
		const player = this.playerFromRef(sideText);
		const condition = this.normalizeEffectName(conditionText);
		if (!player || !condition) return;

		if (!add) {
			delete this.sides[player].sideConditions[condition];
			return;
		}

		const cap = SIDE_CONDITION_CAPS[condition];
		const nextValue = (this.sides[player].sideConditions[condition] || 0) + 1;
		this.sides[player].sideConditions[condition] = cap ? Math.min(nextValue, cap) : nextValue;
	}

	private handleSwapSideConditions() {
		[this.sides.p1.sideConditions, this.sides.p2.sideConditions] = [
			this.sides.p2.sideConditions,
			this.sides.p1.sideConditions,
		];
	}

	private handleAbility(ref: string | undefined, abilityText: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		const ability = this.stripEffectPrefix(abilityText);
		if (!uid || !ability) return;
		const mon = this.mons.get(uid)!;
		mon.ability = ability;
		mon.publicRevealed = true;
	}

	private handleEndAbility(ref: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		this.mons.get(uid)!.ability = undefined;
	}

	private handleItem(ref: string | undefined, itemText: string | undefined, consumed: boolean) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		mon.publicRevealed = true;
		if (consumed) {
			mon.item = undefined;
			return;
		}
		const item = this.stripEffectPrefix(itemText);
		if (item) mon.item = item;
	}

	private handleFormeChange(ref: string | undefined, speciesText: string | undefined, condition: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		mon.publicRevealed = true;
		mon.species = this.stripEffectPrefix(speciesText) || mon.species;
	}

	private handleTerastallize(ref: string | undefined, teraType: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const mon = this.mons.get(uid)!;
		mon.publicRevealed = true;
		mon.terastallized = true;
		mon.teraType = teraType || mon.teraType;
	}

	private handleTransform(ref: string | undefined, speciesText: string | undefined) {
		const uid = this.resolveActiveUID(ref, undefined, true);
		if (!uid) return;
		const species = this.stripEffectPrefix(speciesText);
		if (species) this.mons.get(uid)!.species = species;
	}

	private resolveSwitchUID(player: PlayerID, ref: string | undefined, details: string | undefined): string {
		if (player === this.perspectivePlayer) {
			const ownUID = this.findOwnUID(player, ref, details);
			if (ownUID) return ownUID;
		}

		const refInfo = this.parseMonRef(ref);
		const detailInfo = this.parseDetails(details);
		const existing = this.findKnownUID(player, refInfo.name, detailInfo.species);
		if (existing) return existing;

		const uid = this.createRevealUID(player);
		this.registerSlot(player, uid);
		return uid;
	}

	private resolveActiveUID(ref: string | undefined, details: string | undefined, createIfMissing: boolean): string | undefined {
		const player = this.playerFromRef(ref);
		if (!player) return undefined;

		let uid = this.sides[player].activeUid;
		if (!uid && player === this.perspectivePlayer) {
			uid = this.findOwnUID(player, ref, details);
		}
		if (!uid) {
			const refInfo = this.parseMonRef(ref);
			const detailInfo = this.parseDetails(details);
			uid = this.findKnownUID(player, refInfo.name, detailInfo.species);
		}
		if (!uid && createIfMissing) {
			uid = player === this.perspectivePlayer ? this.findOwnUID(player, ref, details) : undefined;
			uid = uid || this.createRevealUID(player);
		}
		if (!uid) return undefined;

		const mon = this.ensureMon(uid, player);
		const refInfo = this.parseMonRef(ref);
		const detailInfo = this.parseDetails(details);
		mon.name = refInfo.name || mon.name;
		mon.species = detailInfo.species || mon.species;
		if (detailInfo.terastallized) {
			mon.terastallized = true;
			mon.teraType = detailInfo.teraType || mon.teraType;
		}
		this.markActive(player, uid);
		return uid;
	}

	private findOwnUID(player: PlayerID, ref: string | undefined, details: string | undefined): string | undefined {
		const refInfo = this.parseMonRef(ref);
		const detailInfo = this.parseDetails(details);

		for (const uid of this.sides[player].slots) {
			if (!uid) continue;
			const mon = this.ensureMon(uid, player);
			if (refInfo.name && mon.name && this.normalizeName(mon.name) === this.normalizeName(refInfo.name)) {
				return uid;
			}
		}
		if (detailInfo.species) {
			const matches = this.sides[player].slots
				.filter(Boolean)
				.filter(uid => {
					const mon = this.mons.get(uid!);
					return !!mon?.species && this.normalizeName(mon.species) === this.normalizeName(detailInfo.species!);
				}) as string[];
			if (matches.length === 1) return matches[0];
		}
		return undefined;
	}

	private findKnownUID(player: PlayerID, name?: string, species?: string): string | undefined {
		if (name) {
			const matches = [...this.mons.values()]
				.filter(mon => mon.player === player && mon.name && this.normalizeName(mon.name) === this.normalizeName(name));
			if (matches.length === 1) return matches[0].uid;
		}
		if (species) {
			const matches = [...this.mons.values()]
				.filter(mon => mon.player === player && mon.species && this.normalizeName(mon.species) === this.normalizeName(species));
			if (matches.length === 1) return matches[0].uid;
		}
		return undefined;
	}

	private markActive(player: PlayerID, uid: string) {
		this.registerSlot(player, uid);
		this.sides[player].activeUid = uid;
	}

	private registerSlot(player: PlayerID, uid: string) {
		if (this.sides[player].slots.includes(uid)) return;
		const index = this.sides[player].slots.findIndex(slot => !slot);
		if (index >= 0) this.sides[player].slots[index] = uid;
	}

	private ensureMon(uid: string, player: PlayerID): MonState {
		let mon = this.mons.get(uid);
		if (mon) return mon;
		mon = {
			uid,
			player,
			fainted: false,
			terastallized: false,
			publicRevealed: player === this.perspectivePlayer,
			boosts: this.emptyBoosts(),
			observedMoves: [],
		};
		this.mons.set(uid, mon);
		return mon;
	}

	private emptyBoosts(): Record<StatID, number> {
		return Object.fromEntries(STAT_ORDER.map(stat => [stat, 0])) as Record<StatID, number>;
	}

	private createRevealUID(player: PlayerID) {
		this.revealCounter[player]++;
		return `${player}:revealed${this.revealCounter[player]}`;
	}

	private selfSlotUID(player: PlayerID, slot: number) {
		return `${player}:slot${slot + 1}`;
	}

	private allocateOwnUID(player: PlayerID) {
		for (let i = 0; i < this.sides[player].slots.length; i++) {
			const existing = this.sides[player].slots[i];
			if (existing) continue;
			const uid = this.selfSlotUID(player, i);
			this.sides[player].slots[i] = uid;
			return uid;
		}
		return undefined;
	}

	private parseMonRef(ref?: string) {
		const text = (ref || '').trim();
		const colon = text.indexOf(':');
		if (colon < 0) return {player: this.playerFromRef(text), name: undefined};
		return {
			player: this.playerFromRef(text),
			name: text.slice(colon + 1).trim() || undefined,
		};
	}

	private parseDetails(details?: string) {
		const parts = (details || '').split(',').map(part => part.trim()).filter(Boolean);
		const info = {
			species: parts[0] || undefined,
			teraType: undefined as string | undefined,
			terastallized: false,
		};
		for (const part of parts.slice(1)) {
			if (part.toLowerCase().startsWith('tera:')) {
				info.terastallized = true;
				info.teraType = part.slice(5).trim() || undefined;
			}
		}
		return info;
	}

	private parseCondition(condition?: string): ParsedCondition {
		const parsed: ParsedCondition = {};
		const tokens = (condition || '').trim().split(/\s+/).filter(Boolean);
		if (!tokens.length) return parsed;

		const hpPart = tokens[0];
		if (hpPart.includes('/')) {
			const [hpText, maxText] = hpPart.split('/');
			const hp = parseInt(hpText);
			const maxHP = parseInt(maxText);
			if (!Number.isNaN(hp)) parsed.hp = hp;
			if (!Number.isNaN(maxHP)) parsed.maxHP = maxHP;
		} else {
			const hp = parseInt(hpPart);
			if (!Number.isNaN(hp)) parsed.hp = hp;
		}

		for (const token of tokens.slice(1)) {
			if (token === 'fnt') {
				parsed.fainted = true;
				parsed.hp = 0;
				break;
			}
			const status = this.normalizeStatus(token);
			if (status) {
				parsed.status = status;
				break;
			}
		}
		if (parsed.hp === 0) parsed.fainted = true;
		return parsed;
	}

	private applyCondition(mon: MonState, parsed: ParsedCondition, options: {clearStatus?: boolean} = {}) {
		if (parsed.maxHP !== undefined) mon.maxHP = parsed.maxHP;
		if (parsed.hp !== undefined) {
			mon.hp = parsed.hp;
			mon.fainted = parsed.hp <= 0;
		}
		if (parsed.fainted) {
			mon.fainted = true;
			mon.hp = 0;
		}
		if (parsed.status !== undefined) {
			mon.status = parsed.status;
		} else if (options.clearStatus) {
			mon.status = undefined;
		}
	}

	private hpFrac(mon: MonState) {
		if (mon.hp === undefined || mon.maxHP === undefined || mon.maxHP <= 0) return undefined;
		return Math.max(0, Math.min(1, mon.hp / mon.maxHP));
	}

	private playerFromRef(ref?: string): PlayerID | undefined {
		const match = /^(p[12])(?:[a-z])?:/i.exec((ref || '').trim());
		if (match) return match[1].toLowerCase() as PlayerID;
		if (this.isPlayerID((ref || '').trim() as PlayerID)) return (ref || '').trim() as PlayerID;
		const sideMatch = /^(p[12])\b/i.exec((ref || '').trim());
		return sideMatch ? sideMatch[1].toLowerCase() as PlayerID : undefined;
	}

	private isPlayerID(value?: string): value is PlayerID {
		return value === 'p1' || value === 'p2';
	}

	private normalizeStatus(value?: string): StatusID | undefined {
		const status = toID(value || '') as StatusID;
		return STATUS_ORDER.includes(status) ? status : undefined;
	}

	private normalizeStat(value?: string): StatID | undefined {
		const stat = toID(value || '') as StatID;
		return STAT_ORDER.includes(stat) ? stat : undefined;
	}

	private normalizeEffectName(value?: string): string | undefined {
		const stripped = this.stripEffectPrefix(value);
		if (!stripped) return undefined;
		return toID(stripped) || undefined;
	}

	private normalizeMoveName(value?: string): string | undefined {
		const text = (value || '').trim();
		if (!text) return undefined;
		return text.toLowerCase().replace(/\s+/g, '');
	}

	private normalizeName(value?: string): string | undefined {
		const text = (value || '').trim();
		return text ? text.toLowerCase() : undefined;
	}

	private stripEffectPrefix(value?: string): string | undefined {
		const text = (value || '').trim();
		if (!text) return undefined;
		const colon = text.indexOf(':');
		if (colon >= 0) {
			const prefix = text.slice(0, colon).trim().toLowerCase();
			if (prefix === 'move' || prefix === 'ability' || prefix === 'item') {
				return text.slice(colon + 1).trim() || undefined;
			}
		}
		return text;
	}

	private clampBoost(value: number) {
		return Math.max(-6, Math.min(6, value));
	}

	private oneHot<T extends string>(value: string | undefined, choices: readonly T[]) {
		return choices.map(choice => (value === choice ? 1 : 0));
	}

	private monVisibleToPlayer(mon: SnapshotMon | undefined, perspectivePlayer: PlayerID) {
		if (!mon) return false;
		return mon.player === perspectivePlayer || !!mon.public_revealed;
	}

	private visibleSpecies(mon: SnapshotMon | undefined, perspectivePlayer: PlayerID) {
		return this.monVisibleToPlayer(mon, perspectivePlayer) ? mon?.species : undefined;
	}

	private visibleStatus(mon: SnapshotMon | undefined, perspectivePlayer: PlayerID) {
		return this.monVisibleToPlayer(mon, perspectivePlayer) ? mon?.status : undefined;
	}

	private visibleObservedMoves(mon: SnapshotMon | undefined, perspectivePlayer: PlayerID) {
		return this.monVisibleToPlayer(mon, perspectivePlayer) ? (mon?.observed_moves || []) : [];
	}

	private monFeatures(mon: SnapshotMon | undefined, perspectivePlayer: PlayerID) {
		const moveHashDim = 64;
		const speciesHashDim = 32;
		if (!mon) {
			return new Array(7 + STAT_ORDER.length + STATUS_ORDER.length + moveHashDim + speciesHashDim).fill(0);
		}

		const hpFrac = mon.hp_frac ?? 0;
		const hpKnown = mon.hp_frac !== undefined ? 1 : 0;
		const fainted = mon.fainted ? 1 : 0;
		const visibleFlag = this.monVisibleToPlayer(mon, perspectivePlayer) ? 1 : 0;
		const terastallized = mon.terastallized ? 1 : 0;
		const abilityKnown = mon.ability ? 1 : 0;
		const itemKnown = mon.item ? 1 : 0;
		const boostVec = STAT_ORDER.map(stat => mon.boosts?.[stat] ?? 0);
		const statusVec = this.oneHot(this.visibleStatus(mon, perspectivePlayer), STATUS_ORDER);
		const moveVec = this.hashedMoveBag(this.visibleObservedMoves(mon, perspectivePlayer), moveHashDim);
		const speciesVec = this.hashedSpecies(this.visibleSpecies(mon, perspectivePlayer), speciesHashDim);

		return [
			hpFrac,
			hpKnown,
			fainted,
			visibleFlag,
			terastallized,
			abilityKnown,
			itemKnown,
			...boostVec,
			...statusVec,
			...moveVec,
			...speciesVec,
		];
	}

	private benchSlotFeatures(mon: SnapshotMon | undefined, perspectivePlayer: PlayerID) {
		const speciesHashDim = 16;
		if (!mon) {
			return new Array(5 + STATUS_ORDER.length + speciesHashDim).fill(0);
		}

		const revealed = this.monVisibleToPlayer(mon, perspectivePlayer) ? 1 : 0;
		const fainted = mon.fainted ? 1 : 0;
		const hpKnown = mon.hp_frac !== undefined ? 1 : 0;
		const hpFrac = mon.hp_frac ?? 0;
		const terastallized = mon.terastallized ? 1 : 0;
		const statusVec = this.oneHot(this.visibleStatus(mon, perspectivePlayer), STATUS_ORDER);
		const speciesVec = this.hashedSpecies(this.visibleSpecies(mon, perspectivePlayer), speciesHashDim);

		return [revealed, fainted, hpKnown, hpFrac, terastallized, ...statusVec, ...speciesVec];
	}

	private fieldFeatures(state: BattleSnapshot) {
		const weatherVec = this.oneHot(state.field.weather, WEATHER_ORDER);
		const activeConditions = new Set(state.field.global_conditions || []);
		const globalVec = GLOBAL_CONDITION_ORDER.map(condition => (activeConditions.has(condition) ? 1 : 0));
		return [...weatherVec, ...globalVec];
	}

	private sideConditionFeatures(side: SnapshotSide) {
		return SIDE_CONDITION_ORDER.map(condition => {
			const cap = SIDE_CONDITION_CAPS[condition] || 1;
			return Math.min(side.side_conditions[condition] || 0, cap) / cap;
		});
	}

	private stableHash(text: string) {
		let hash = 2166136261 >>> 0;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 16777619) >>> 0;
		}
		return hash >>> 0;
	}

	private hashedMoveBag(moveIDs: string[], dim: number) {
		const vec = new Array(dim).fill(0);
		for (const moveID of moveIDs) {
			vec[this.stableHash(moveID) % dim] = 1;
		}
		return vec;
	}

	private hashedSpecies(species: string | undefined, dim: number) {
		const vec = new Array(dim).fill(0);
		if (!species) return vec;
		vec[this.stableHash(species) % dim] = 1;
		return vec;
	}
}
