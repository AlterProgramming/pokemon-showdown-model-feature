/**
 * TurnEventV1 emitter for the RL agent.
 *
 * Observes the PS protocol stream and emits TurnEventV1-shaped dicts that
 * match exactly what `core/TurnEventV1.py::TurnEventV1.to_dict()` produces
 * during training. These dicts are what the Python history encoder was
 * trained to consume, so serving-time encoding matches training distribution.
 *
 * Public surface:
 *   - emitter.applyProtocolLine(line) — called per log line
 *   - emitter.getLastTurnEvents()      — events for the turn that just ended
 *                                        (cleared on next turn|N boundary)
 *   - emitter.reset()                   — new battle
 */
type PlayerID = 'p1' | 'p2';
type TurnEventDict = Record<string, string | number | boolean>;

const EVENT_MOVE = 'move';
const EVENT_SWITCH = 'switch';
const EVENT_DAMAGE = 'damage';
const EVENT_HEAL = 'heal';
const EVENT_STATUS_START = 'status_start';
const EVENT_STATUS_END = 'status_end';
const EVENT_BOOST = 'boost';
const EVENT_UNBOOST = 'unboost';
const EVENT_FAINT = 'faint';
const EVENT_WEATHER = 'weather';
const EVENT_FIELD = 'field';
const EVENT_SIDE_CONDITION = 'side_condition';
const EVENT_FORME_CHANGE = 'forme_change';
const EVENT_TURN_END = 'turn_end';

/** Mirrors core/TurnEventV1.py::hp_delta_to_bin — 5% bins, clipped to [-20, 20]. */
export function hpDeltaToBin(beforeFrac: number | null, afterFrac: number | null): number {
	if (beforeFrac === null && afterFrac === null) return 0;
	if (afterFrac === null) return 0;
	const bf = beforeFrac ?? 0;
	const af = afterFrac ?? 0;
	const delta = af - bf;
	const raw = Math.round(delta / 0.05);
	return Math.max(-20, Math.min(20, raw));
}

/** Drop non-default fields to match to_dict()'s compact output. */
function compact(event: TurnEventDict): TurnEventDict {
	const out: TurnEventDict = { event_type: event.event_type };
	for (const [k, v] of Object.entries(event)) {
		if (k === 'event_type') continue;
		if (typeof v === 'string' && v === '') continue;
		if (typeof v === 'number' && v === 0) continue;
		if (typeof v === 'boolean' && v === false) continue;
		out[k] = v;
	}
	return out;
}

function normalizeID(value: string | undefined): string {
	if (!value) return '';
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripEffectPrefix(value: string | undefined): string {
	if (!value) return '';
	const idx = value.indexOf(':');
	return idx >= 0 ? value.slice(idx + 1).trim() : value.trim();
}

function playerFromRef(ref: string | undefined): PlayerID | '' {
	if (!ref) return '';
	const m = ref.match(/^(p[12])/);
	return (m?.[1] as PlayerID) ?? '';
}

function playerFromSideText(side: string | undefined): PlayerID | '' {
	if (!side) return '';
	const m = side.match(/^(p[12])/);
	return (m?.[1] as PlayerID) ?? '';
}

function parseHpCondition(cond: string | undefined): number | null {
	if (!cond) return null;
	if (cond.startsWith('0 fnt') || cond === '0') return 0;
	const m = cond.match(/^(\d+)\/(\d+)/);
	if (!m) return null;
	const cur = parseInt(m[1], 10);
	const max = parseInt(m[2], 10);
	if (!max) return null;
	return cur / max;
}

function parseSpeciesFromDetails(details: string | undefined): string {
	if (!details) return '';
	const first = details.split(',')[0] || '';
	return normalizeID(first);
}

export class TurnEventV1Emitter {
	private currentTurnEvents: TurnEventDict[] = [];
	private lastCompletedTurnEvents: TurnEventDict[] = [];
	// uid (e.g. "p1a") → last known hp fraction. Used to compute hp_delta_bin.
	private hpByActive: Map<string, number> = new Map();
	// Track ever-seen species per side to derive slot_index on switch.
	private sideSlots: Map<PlayerID, string[]> = new Map([['p1', []], ['p2', []]]);

	reset(): void {
		this.currentTurnEvents = [];
		this.lastCompletedTurnEvents = [];
		this.hpByActive.clear();
		this.sideSlots = new Map([['p1', []], ['p2', []]]);
	}

	/** Events for the most recently completed turn. Cleared on turn boundary. */
	getLastTurnEvents(): TurnEventDict[] {
		return this.lastCompletedTurnEvents.slice();
	}

	applyProtocolLine(line: string): void {
		if (!line.startsWith('|')) return;
		const parts = line.split('|').slice(1);
		const type = parts[0];

		switch (type) {
		case 'turn':
			this.closeCurrentTurn();
			break;
		case 'switch':
		case 'drag': {
			const actor = playerFromRef(parts[1]);
			if (!actor) break;
			const species = parseSpeciesFromDetails(parts[2]);
			if (!species) break;
			let slots = this.sideSlots.get(actor)!;
			let slotIndex = slots.indexOf(species);
			if (slotIndex < 0) {
				slots.push(species);
				slotIndex = slots.length - 1;
			}
			// Training uses 1-based slot indices.
			this.emit({
				event_type: EVENT_SWITCH,
				actor_side: actor,
				species_id: species,
				slot_index: slotIndex + 1,
			});
			const hp = parseHpCondition(parts[3]);
			if (hp !== null) this.hpByActive.set(this.activeKey(actor), hp);
			break;
		}
		case 'move': {
			const actor = playerFromRef(parts[1]);
			const target = playerFromRef(parts[3]);
			if (!actor) break;
			this.emit({
				event_type: EVENT_MOVE,
				actor_side: actor,
				target_side: target,
				move_id: normalizeID(parts[2]),
			});
			break;
		}
		case 'faint': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			this.emit({ event_type: EVENT_FAINT, target_side: target });
			// Active slot will be cleared by the next switch.
			break;
		}
		case '-damage':
		case '-heal':
		case '-sethp': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			const key = this.activeKey(target);
			const before = this.hpByActive.has(key) ? this.hpByActive.get(key)! : null;
			const after = parseHpCondition(parts[2]);
			if (after !== null) this.hpByActive.set(key, after);
			const bin = hpDeltaToBin(before, after);
			const isHeal = type === '-heal' || (after !== null && before !== null && after > before);
			this.emit({
				event_type: isHeal ? EVENT_HEAL : EVENT_DAMAGE,
				target_side: target,
				hp_delta_bin: bin,
			});
			break;
		}
		case '-status': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			this.emit({
				event_type: EVENT_STATUS_START,
				target_side: target,
				status: normalizeID(parts[2]),
			});
			break;
		}
		case '-curestatus': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			this.emit({
				event_type: EVENT_STATUS_END,
				target_side: target,
				status: normalizeID(parts[2]),
			});
			break;
		}
		case '-boost':
		case '-unboost': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			const delta = parseInt(parts[3] || '0', 10) || 0;
			this.emit({
				event_type: type === '-unboost' ? EVENT_UNBOOST : EVENT_BOOST,
				target_side: target,
				boost_stat: normalizeID(parts[2]),
				boost_delta: type === '-unboost' ? -Math.abs(delta) : Math.abs(delta),
			});
			break;
		}
		case '-weather': {
			this.emit({
				event_type: EVENT_WEATHER,
				weather: normalizeID(parts[1]),
			});
			break;
		}
		case '-fieldstart':
		case '-fieldend': {
			this.emit({
				event_type: EVENT_FIELD,
				terrain: normalizeID(stripEffectPrefix(parts[1])),
				is_removal: type === '-fieldend',
			});
			break;
		}
		case '-sidestart':
		case '-sideend': {
			const actor = playerFromSideText(parts[1]);
			if (!actor) break;
			this.emit({
				event_type: EVENT_SIDE_CONDITION,
				actor_side: actor,
				side_condition: normalizeID(stripEffectPrefix(parts[2])),
				is_removal: type === '-sideend',
			});
			break;
		}
		case '-terastallize': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			this.emit({
				event_type: EVENT_FORME_CHANGE,
				target_side: target,
				forme_change_kind: 'tera',
				status: normalizeID(parts[2]),  // reused field per TurnEventV1 docstring
			});
			break;
		}
		case 'detailschange':
		case 'replace':
		case '-formechange': {
			const target = playerFromRef(parts[1]);
			if (!target) break;
			const species = parseSpeciesFromDetails(parts[2]);
			if (!species) break;
			this.emit({
				event_type: EVENT_FORME_CHANGE,
				target_side: target,
				forme_change_kind: 'species',
				species_id: species,
			});
			break;
		}
		default:
			break;
		}
	}

	/** One active mon per side; use a stable key. */
	private activeKey(side: PlayerID | ''): string {
		return side ? `${side}-active` : '';
	}

	private emit(ev: TurnEventDict): void {
		this.currentTurnEvents.push(compact(ev));
	}

	private closeCurrentTurn(): void {
		this.currentTurnEvents.push({ event_type: EVENT_TURN_END });
		this.lastCompletedTurnEvents = this.currentTurnEvents;
		this.currentTurnEvents = [];
	}
}
