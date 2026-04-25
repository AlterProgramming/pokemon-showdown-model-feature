import { Utils } from '../../lib';
import { TeamValidatorAsync } from '../team-validator-async';
import type { AutomatedBattlePlayerOptions, RoomBattlePlayerOptions } from '../room-battle';
import {
	HUMAN_LOCAL_ID,
	loadHumanLeagueContext,
	pickHumanOpponent,
	recordHumanMatch,
	saveHumanMatchReplay,
	type HumanLeagueContext,
} from '../model-league/human-matches';

interface ModelBattleCatalogEntry {
	id?: string;
	name?: string;
	description?: string;
	modelID?: string;
	endpoint?: string;
	modelProfile?: AutomatedBattlePlayerOptions['modelProfile'];
	allowVoluntarySwitches?: boolean;
	formats?: string[];
	team?: string;
	teams?: Record<string, string>;
	botName?: string;
	avatar?: string | number;
}

interface ResolvedModelBattleCatalogEntry {
	id: ID;
	name: string;
	description: string;
	modelID?: string;
	endpoint?: string;
	modelProfile?: AutomatedBattlePlayerOptions['modelProfile'];
	allowVoluntarySwitches?: boolean;
	formats: ID[];
	team?: string;
	teams: Record<ID, string>;
	botName: string;
	avatar: string;
}

const DEFAULT_MODEL_BATTLE_FORMAT = `gen${Dex.gen}randombattle`;
const DEFAULT_MODEL_AVATAR = '169';

function normalizeCatalogEntry(entry: ModelBattleCatalogEntry): ResolvedModelBattleCatalogEntry | null {
	const id = toID(entry.id || entry.modelID || entry.name);
	if (!id) return null;
	const name = entry.name?.trim() || entry.modelID?.trim() || id;
	const formats = (entry.formats?.length ? entry.formats : [DEFAULT_MODEL_BATTLE_FORMAT])
		.map(formatid => Dex.formats.get(formatid))
		.filter(format => format.effectType === 'Format')
		.map(format => format.id);
	if (!formats.length) return null;

	const teams: Record<ID, string> = Object.create(null);
	for (const [formatid, team] of Object.entries(entry.teams || {})) {
		const format = Dex.formats.get(formatid);
		if (format.effectType !== 'Format' || !team) continue;
		teams[format.id] = team;
	}

	return {
		id,
		name,
		description: entry.description?.trim() || '',
		modelID: entry.modelID,
		endpoint: entry.endpoint,
		modelProfile: entry.modelProfile,
		allowVoluntarySwitches: entry.allowVoluntarySwitches,
		formats,
		team: entry.team,
		teams,
		botName: entry.botName?.trim() || name,
		avatar: `${entry.avatar ?? DEFAULT_MODEL_AVATAR}`,
	};
}

function getModelBattleCatalog() {
	const rawCatalog = Array.isArray(Config.modelBattles) ? Config.modelBattles as ModelBattleCatalogEntry[] : [];
	const catalog: ResolvedModelBattleCatalogEntry[] = [];
	const seen = new Set<ID>();
	for (const rawEntry of rawCatalog) {
		const entry = normalizeCatalogEntry(rawEntry);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		catalog.push(entry);
	}
	return catalog;
}

function getModelBattleEntry(id: string) {
	const entryID = toID(id);
	return getModelBattleCatalog().find(entry => entry.id === entryID) || null;
}

function getSupportedFormats(entry: ResolvedModelBattleCatalogEntry) {
	return entry.formats
		.map(formatid => Dex.formats.get(formatid))
		.filter(format => format.effectType === 'Format');
}

function formatNeedsConfiguredTeam(formatid: ID) {
	return !Dex.formats.get(formatid).team;
}

async function resolveAutomatedTeam(entry: ResolvedModelBattleCatalogEntry, formatid: ID) {
	if (!formatNeedsConfiguredTeam(formatid)) return undefined;
	const configuredTeam = entry.teams[formatid] || entry.team;
	if (!configuredTeam) {
		throw new Chat.ErrorMessage(
			`${entry.name} does not have a configured team for ${Dex.formats.get(formatid).name}.`
		);
	}
	const result = await TeamValidatorAsync.get(formatid).validateTeam(configuredTeam, {
		user: entry.modelID ? toID(entry.modelID) : entry.id,
	});
	if (!result.startsWith('1')) {
		throw new Chat.ErrorMessage(
			`${entry.name}'s configured team is invalid for ${Dex.formats.get(formatid).name}:\n- ` +
			result.slice(1).replace(/\n/g, '\n- ')
		);
	}
	return result.slice(1);
}

function renderRefresh(pageid: string) {
	return (
		`<button class="button" name="send" value="/j ${pageid}" style="float:right">` +
		`<i class="fa fa-refresh"></i> Refresh</button>`
	);
}

function renderModelCard(entry: ResolvedModelBattleCatalogEntry) {
	const formatNames = getSupportedFormats(entry).map(format => format.name);
	let buf = `<div class="infobox">`;
	buf += `<strong>${Utils.escapeHTML(entry.name)}</strong><br />`;
	if (entry.description) {
		buf += `${Utils.escapeHTML(entry.description)}<br />`;
	}
	buf += `Opponent name: ${Utils.escapeHTML(entry.botName)}<br />`;
	buf += `Formats: ${Utils.escapeHTML(formatNames.join(', '))}<br />`;
	buf += `<button class="button notifying" name="send" value="/j view-modelbattle-${entry.id}">Choose</button>`;
	buf += `</div>`;
	return buf;
}

function renderFormatOption(formatid: ID, selected = false) {
	const format = Dex.formats.get(formatid);
	return `<option value="${formatid}"${selected ? ` selected` : ``}>${Utils.escapeHTML(format.name)}</option>`;
}

function getReplayableModelBattle(roomid: string, user: User) {
	const room = Rooms.get(roomid as RoomID);
	if (!room?.battle) {
		throw new Chat.ErrorMessage(`Battle '${roomid}' was not found.`);
	}
	const battle = room.battle;
	if (!battle.ended) {
		throw new Chat.ErrorMessage(`Finish the battle before replaying it.`);
	}
	const automatedPlayer = battle.players.find(player => player.isAutomated && player.automation?.type === 'rl-model');
	if (!automatedPlayer) {
		throw new Chat.ErrorMessage(`That battle is not a replayable model battle.`);
	}
	const humanPlayer = battle.players.find(player => !player.isAutomated && player.id === user.id);
	if (!humanPlayer) {
		throw new Chat.ErrorMessage(`You can only replay your own model battles.`);
	}
	return { battle, room, humanPlayer, automatedPlayer };
}

async function createModelBattle(
	connection: Connection,
	user: User,
	entry: ResolvedModelBattleCatalogEntry,
	formatid: ID,
) {
	const format = Dex.formats.get(formatid, true);
	if (format.effectType !== 'Format') {
		throw new Chat.ErrorMessage(`Format '${formatid}' was not found.`);
	}
	if (!entry.formats.includes(format.id)) {
		throw new Chat.ErrorMessage(`${entry.name} is not configured for ${format.name}.`);
	}
	if (format.playerCount !== 2 || format.gameType !== 'singles') {
		throw new Chat.ErrorMessage(`Model battles currently support only two-player singles formats.`);
	}

	const ready = await Ladders(format.id).prepBattle(connection, 'challenge');
	if (!ready) return null;
	const automatedTeam = await resolveAutomatedTeam(entry, ready.formatid as ID);
	const automatedPlayer: RoomBattlePlayerOptions = {
		user: null,
		name: entry.botName,
		avatar: entry.avatar,
		team: automatedTeam,
		automation: {
			type: 'rl-model',
			endpoint: entry.endpoint,
			modelID: entry.modelID,
			modelProfile: entry.modelProfile,
			allowVoluntarySwitches: entry.allowVoluntarySwitches,
		},
	};
	const room = Rooms.createBattle({
		format: ready.formatid,
		players: [
			{
				user,
				team: ready.settings.team,
				rating: ready.rating,
				hidden: ready.settings.hidden,
				inviteOnly: ready.settings.inviteOnly,
			},
			automatedPlayer,
		],
		rated: false,
		challengeType: 'challenge',
	});
	if (!room) return null;

	room.add(
		`|raw|<div class="broadcast-blue"><strong>${Utils.escapeHTML(user.name)}</strong> is battling ` +
		`<strong>${Utils.escapeHTML(entry.name)}</strong>${entry.description ? `<br />${Utils.escapeHTML(entry.description)}` : ``}</div>`
	).update();
	connection.send(`>view-modelbattle\n|deinit`);
	return room;
}

async function createRepeatedModelBattle(
	connection: Connection,
	user: User,
	entry: ResolvedModelBattleCatalogEntry,
	previousBattle: RoomBattle,
) {
	const format = Dex.formats.get(previousBattle.format, true);
	if (format.effectType !== 'Format') {
		throw new Chat.ErrorMessage(`Format '${previousBattle.format}' was not found.`);
	}
	if (!entry.formats.includes(format.id)) {
		throw new Chat.ErrorMessage(`${entry.name} is not configured for ${format.name}.`);
	}
	if (format.playerCount !== 2 || format.gameType !== 'singles') {
		throw new Chat.ErrorMessage(`Model battles currently support only two-player singles formats.`);
	}
	const humanPlayer = previousBattle.players.find(
		player => !player.isAutomated && player.id === user.id
	);
	const automatedPlayer = previousBattle.players.find(
		player => player.isAutomated && player.automation?.type === 'rl-model'
	);
	if (!humanPlayer || !automatedPlayer) {
		throw new Chat.ErrorMessage(`That battle cannot be replayed as a model battle.`);
	}

	const [humanTeamData, automatedTeamData] = await Promise.all([
		previousBattle.getPlayerTeam(humanPlayer),
		previousBattle.getPlayerTeam(automatedPlayer),
	]);
	if (!humanTeamData || !automatedTeamData) {
		throw new Chat.ErrorMessage(`Could not recover the teams from that battle.`);
	}

	const room = Rooms.createBattle({
		format: previousBattle.format,
		players: [
			{
				user,
				team: Teams.pack(humanTeamData),
			},
			{
				user: null,
				name: entry.botName,
				avatar: entry.avatar,
				team: Teams.pack(automatedTeamData),
				automation: {
					type: 'rl-model',
					endpoint: entry.endpoint,
					modelID: entry.modelID,
					modelProfile: entry.modelProfile,
					allowVoluntarySwitches: entry.allowVoluntarySwitches,
				},
			},
		],
		rated: false,
		challengeType: 'challenge',
	});
	if (!room) return null;

	room.add(
		`|raw|<div class="broadcast-blue"><strong>${Utils.escapeHTML(user.name)}</strong> is replaying the same teams against ` +
		`<strong>${Utils.escapeHTML(entry.name)}</strong>.</div>`
	).update();
	connection.send(`>view-modelbattlerematch-${previousBattle.roomid}\n|deinit`);
	return room;
}

// Active human-league battles, keyed by room id. onBattleEnd uses this to
// route the outcome back to the human-matches state.
interface HumanLeagueMatchContext {
	modelId: string;
	modelName: string;
	modelEndpoint: string | null;
	humanDisplayName: string;
	leagueContext: HumanLeagueContext;
}
const humanLeagueMatches: Map<string, HumanLeagueMatchContext> = new Map();

function modelLeagueEntryAsCatalog(model: {
	id: string; name: string; modelID?: string; endpoint?: string;
	modelProfile?: AutomatedBattlePlayerOptions['modelProfile']; allowVoluntarySwitches?: boolean;
}): ResolvedModelBattleCatalogEntry {
	return {
		id: toID(model.id),
		name: model.name,
		description: '',
		modelID: model.modelID,
		endpoint: model.endpoint,
		modelProfile: model.modelProfile,
		allowVoluntarySwitches: model.allowVoluntarySwitches,
		formats: [toID('gen9randombattle')],
		teams: Object.create(null),
		botName: model.name,
		avatar: DEFAULT_MODEL_AVATAR,
	};
}

export async function createHumanLeagueBattle(connection: Connection, user: User) {
	if (!user.named) {
		connection.popup(`You must choose a username before entering the league.`);
		return null;
	}
	let leagueContext: HumanLeagueContext;
	try {
		leagueContext = loadHumanLeagueContext();
	} catch (err: any) {
		connection.popup(`Could not load model-league config: ${err?.message || err}`);
		return null;
	}
	const { config, state } = leagueContext;
	const opponent = await pickHumanOpponent(state.humanRating.elo, config, state);
	if (!opponent) {
		connection.popup(
			`No model opponents are reachable right now. Start the Flask model server (flask_api_multi.py) and try again.`
		);
		return null;
	}
	const formatid = toID('gen9randombattle');
	const entry = modelLeagueEntryAsCatalog(opponent);
	const room = await createModelBattle(connection, user, entry, formatid);
	if (!room) return null;
	humanLeagueMatches.set(room.roomid, {
		modelId: opponent.id,
		modelName: opponent.name,
		modelEndpoint: opponent.endpoint ?? null,
		humanDisplayName: user.name,
		leagueContext,
	});
	room.add(
		`|raw|<div class="broadcast-green"><strong>League match</strong>: ` +
		`${Utils.escapeHTML(user.name)} (ELO ${Math.round(state.humanRating.elo)}) ` +
		`vs <strong>${Utils.escapeHTML(opponent.name)}</strong>.</div>`
	).update();
	return room;
}

export const commands: Chat.ChatCommands = {
	findmatch: 'leaguebattle',
	async leaguebattle(target, room, user, connection) {
		if (!connection) throw new Chat.ErrorMessage(`You need a connection to start a league match.`);
		await createHumanLeagueBattle(connection, user);
	},
	leaguebattlehelp: [
		`/leaguebattle - Enter the model league rotation: matched against an active model near your ELO in gen9randombattle.`,
		`/findmatch - Alias for /leaguebattle.`,
	],
	playmodel: 'modelbattle',
	modelbattle: {
		''(target) {
			const modelid = toID(target);
			return this.parse(`/j view-modelbattle${modelid ? `-${modelid}` : ``}`);
		},
		async start(target, room, user, connection) {
			if (!connection) throw new Chat.ErrorMessage(`You need a connection to start a model battle.`);
			if (!user.named) {
				connection.popup(`You must choose a username before battling a model.`);
				return;
			}
			const [rawModelID, rawFormat] = target.split(',').map(part => part.trim());
			const entry = getModelBattleEntry(rawModelID);
			if (!entry) throw new Chat.ErrorMessage(`Model '${rawModelID}' is not configured.`);
			const formatid = Dex.formats.get(rawFormat || entry.formats[0]).id;
			if (!formatid) throw new Chat.ErrorMessage(`Format '${rawFormat}' was not found.`);
			const battleRoom = await createModelBattle(connection, user, entry, formatid);
			if (!battleRoom) return;
		},
		async replay(target, room, user, connection) {
			if (!connection) throw new Chat.ErrorMessage(`You need a connection to replay a model battle.`);
			if (!user.named) {
				connection.popup(`You must choose a username before replaying a model battle.`);
				return;
			}
			const [rawRoomID, rawModelID] = target.split(',').map(part => part.trim());
			if (!rawRoomID) throw new Chat.ErrorMessage(`Specify which battle to replay.`);
			const entry = getModelBattleEntry(rawModelID);
			if (!entry) throw new Chat.ErrorMessage(`Model '${rawModelID}' is not configured.`);
			const { battle } = getReplayableModelBattle(rawRoomID, user);
			const replayRoom = await createRepeatedModelBattle(connection, user, entry, battle);
			if (!replayRoom) return;
		},
		help() {
			return this.parse('/help modelbattle');
		},
	},
	modelbattlehelp: [
		`/modelbattle - Open the model battle page.`,
		`/modelbattle start [model], [format] - Start a battle against a configured model opponent.`,
		`/modelbattle replay [battle room], [model] - Replay a finished model battle with the same teams against another model.`,
	],
};

export const pages: Chat.PageTable = {
	modelbattle(query, user) {
		if (!user.named) return Rooms.RETRY_AFTER_LOGIN;
		this.title = '[Model Battles]';
		const catalog = getModelBattleCatalog();
		const selectedID = toID(query.join('-'));
		const selected = selectedID ? catalog.find(entry => entry.id === selectedID) || null : null;
		let buf = `<div class="pad ladder"><h2>Battle a trained model</h2>${renderRefresh(this.pageid)}<hr />`;

		if (!catalog.length) {
			buf += `<div class="message-error">No model battle catalog is configured. Add entries to <code>Config.modelBattles</code> to enable this page.</div>`;
			buf += `</div>`;
			return buf;
		}

		if (!selected) {
			buf += `<p>Select which configured model you want to battle.</p>`;
			buf += catalog.map(renderModelCard).join('<br />');
			buf += `</div>`;
			return buf;
		}

		const formats = getSupportedFormats(selected);
		const defaultFormat = formats[0];
		buf += `<a class="button" href="/view-modelbattle">Back to models</a><br /><br />`;
		buf += `<div class="infobox">`;
		buf += `<strong>${Utils.escapeHTML(selected.name)}</strong><br />`;
		if (selected.description) {
			buf += `${Utils.escapeHTML(selected.description)}<br />`;
		}
		buf += `Opponent name: ${Utils.escapeHTML(selected.botName)}<br />`;
		buf += `Human side validation uses your normal battle team selection for the chosen format.<br />`;
		buf += `Formats without built-in random team generation require the model to have a configured team in <code>Config.modelBattles</code>.`;
		buf += `</div><br />`;
		buf += `<form data-submitsend="/modelbattle start ${selected.id},{format}">`;
		buf += `<strong>Format</strong><br />`;
		buf += `<select name="format">`;
		buf += formats.map((format, index) => renderFormatOption(format.id, index === 0)).join('');
		buf += `</select><br /><br />`;
		if (defaultFormat && formatNeedsConfiguredTeam(defaultFormat.id)) {
			buf += `<small>Tip: make sure your current team matches ${Utils.escapeHTML(defaultFormat.name)} before starting.</small><br /><br />`;
		}
		buf += `<button class="button notifying" type="submit">Start battle</button>`;
		buf += `</form></div>`;
		return buf;
	},
	modelbattlerematch(query, user) {
		if (!user.named) return Rooms.RETRY_AFTER_LOGIN;
		const roomid = query.join('-');
		this.title = '[Model Battle Replay]';
		const { battle, automatedPlayer } = getReplayableModelBattle(roomid, user);
		const format = Dex.formats.get(battle.format, true);
		const catalog = getModelBattleCatalog().filter(entry => entry.formats.includes(format.id));
		let buf = `<div class="pad ladder"><h2>Replay with the same teams</h2>${renderRefresh(this.pageid)}<hr />`;

		buf += `<div class="infobox">`;
		buf += `Battle: <a href="/${battle.roomid}">${Utils.escapeHTML(battle.room.title)}</a><br />`;
		buf += `Format: ${Utils.escapeHTML(format.name)}<br />`;
		buf += `Current model: ${Utils.escapeHTML(automatedPlayer.name)}<br />`;
		buf += `The new battle will reuse both exact team compositions from the finished battle.`;
		buf += `</div><br />`;

		if (!catalog.length) {
			buf += `<div class="message-error">No configured models support ${Utils.escapeHTML(format.name)}.</div>`;
			buf += `</div>`;
			return buf;
		}

		for (const entry of catalog) {
			buf += `<div class="infobox">`;
			buf += `<strong>${Utils.escapeHTML(entry.name)}</strong><br />`;
			if (entry.description) {
				buf += `${Utils.escapeHTML(entry.description)}<br />`;
			}
			buf += `Opponent name: ${Utils.escapeHTML(entry.botName)}<br />`;
			buf += `<button class="button notifying" name="send" value="/modelbattle replay ${battle.roomid}, ${entry.id}">Start rematch</button>`;
			buf += `</div><br />`;
		}

		buf += `</div>`;
		return buf;
	},
};

export const handlers: Chat.Handlers = {
	onBattleEnd(battle, winner) {
		const automatedPlayer = battle.players.find(player => player.isAutomated && player.automation?.type === 'rl-model');
		if (!automatedPlayer) return;
		battle.room.add(
			`|raw|<div class="broadcast-blue"><strong>Replay this battle with the same teams?</strong><br />` +
			`<button class="button notifying" name="send" value="/j view-modelbattlerematch-${battle.roomid}">Choose a model</button></div>`
		).update();

		// If this was a human-league match, record the result.
		const leagueMatch = humanLeagueMatches.get(battle.roomid);
		if (!leagueMatch) return;
		humanLeagueMatches.delete(battle.roomid);

		const humanPlayer = battle.players.find(player => !player.isAutomated);
		if (!humanPlayer) return;
		const humanId = toID(humanPlayer.name);
		const modelPlayerId = toID(automatedPlayer.name);
		let outcome: 'human' | 'model' | 'tie';
		if (!winner) outcome = 'tie';
		else if (winner === humanId) outcome = 'human';
		else if (winner === modelPlayerId) outcome = 'model';
		else outcome = 'tie';

		try {
			const record = recordHumanMatch({
				context: leagueMatch.leagueContext,
				roomId: battle.roomid,
				modelId: leagueMatch.modelId,
				modelName: leagueMatch.modelName,
				modelEndpoint: leagueMatch.modelEndpoint,
				winner: outcome,
				humanDisplayName: leagueMatch.humanDisplayName,
				turns: battle.turn ?? null,
			});
			try {
				saveHumanMatchReplay({
					config: leagueMatch.leagueContext.config,
					roomId: battle.roomid,
					record,
					battleLog: (battle.room.log?.log || []).slice(),
				});
			} catch (replayErr: any) {
				battle.room.add(
					`|raw|<div class="message-error">(replay save failed: ${Utils.escapeHTML(replayErr?.message || String(replayErr))}; ELO already recorded)</div>`
				).update();
			}
			const delta = Math.round(record.humanEloAfter - record.humanEloBefore);
			const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
			battle.room.add(
				`|raw|<div class="broadcast-green"><strong>League result</strong>: ` +
				`${Utils.escapeHTML(leagueMatch.humanDisplayName)} ${outcome === 'human' ? 'won' : outcome === 'tie' ? 'tied' : 'lost'} ` +
				`vs ${Utils.escapeHTML(leagueMatch.modelName)}. ` +
				`ELO ${Math.round(record.humanEloBefore)} → <strong>${Math.round(record.humanEloAfter)}</strong> (${deltaStr}).</div>`
			).update();
		} catch (err: any) {
			battle.room.add(
				`|raw|<div class="message-error">Failed to record league match: ${Utils.escapeHTML(err?.message || String(err))}</div>`
			).update();
		}
	},
};

// Silence linter: HUMAN_LOCAL_ID re-exported for any future consumers wanting
// to filter by the stable human identity.
export { HUMAN_LOCAL_ID };
