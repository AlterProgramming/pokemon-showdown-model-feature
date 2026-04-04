import type {
	ModelLeagueConfig,
	ModelLeagueRatingEntry,
	ModelLeagueState,
} from "./types";

type MatchScore = 1 | 0 | 0.5;

export function createRatingEntry(id: string, name: string, initialElo: number): ModelLeagueRatingEntry {
	return {
		id,
		name,
		elo: initialElo,
		wins: 0,
		losses: 0,
		ties: 0,
		totalMatches: 0,
		lastUpdatedAt: null,
		lastOpponentId: null,
	};
}

export function ensureRatingEntries(state: ModelLeagueState, config: ModelLeagueConfig) {
	const existingModelIds = new Set(state.modelRatings.map(entry => entry.id));
	for (const checkpoint of state.checkpoints) {
		if (!existingModelIds.has(checkpoint.id)) {
			state.modelRatings.push(createRatingEntry(checkpoint.id, checkpoint.name, config.ratings.initialElo));
			existingModelIds.add(checkpoint.id);
		}
	}
	const existingTeamIds = new Set(state.teamRatings.map(entry => entry.id));
	for (const team of state.teams) {
		if (!existingTeamIds.has(team.id)) {
			state.teamRatings.push(createRatingEntry(team.id, team.name, config.ratings.initialElo));
			existingTeamIds.add(team.id);
		}
	}
}

export function getRatingEntry(entries: ModelLeagueRatingEntry[], id: string, name: string, initialElo: number) {
	let entry = entries.find(candidate => candidate.id === id);
	if (!entry) {
		entry = createRatingEntry(id, name, initialElo);
		entries.push(entry);
	}
	return entry;
}

function calculateElo(oldElo: number, score: number, foeElo: number, minElo: number) {
	let k = 50;
	if (oldElo < 1200) {
		if (score < 0.5) {
			k = 10 + (oldElo - 1000) * 40 / 200;
		} else if (score > 0.5) {
			k = 90 - (oldElo - 1000) * 40 / 200;
		}
	} else if (oldElo > 1350 && oldElo <= 1600) {
		k = 40;
	} else {
		k = 32;
	}

	const expected = 1 / (1 + 10 ** ((foeElo - oldElo) / 400));
	return Math.max(oldElo + k * (score - expected), minElo);
}

function updateEntry(entry: ModelLeagueRatingEntry, score: MatchScore, foeElo: number, minElo: number, now: string, foeId: string) {
	const before = entry.elo;
	entry.elo = calculateElo(entry.elo, score, foeElo, minElo);
	entry.totalMatches++;
	if (score === 1) entry.wins++;
	else if (score === 0) entry.losses++;
	else entry.ties++;
	entry.lastUpdatedAt = now;
	entry.lastOpponentId = foeId;
	return {before, after: entry.elo};
}

export function applyRatingMatch(options: {
	entries: ModelLeagueRatingEntry[];
	idA: string;
	nameA: string;
	idB: string;
	nameB: string;
	scoreA: MatchScore;
	now: string;
	config: ModelLeagueConfig;
}) {
	const {entries, idA, nameA, idB, nameB, scoreA, now, config} = options;
	const entryA = getRatingEntry(entries, idA, nameA, config.ratings.initialElo);
	const entryB = getRatingEntry(entries, idB, nameB, config.ratings.initialElo);
	const scoreB = (1 - scoreA) as MatchScore;
	const beforeA = entryA.elo;
	const beforeB = entryB.elo;
	updateEntry(entryA, scoreA, beforeB, config.ratings.minElo, now, idB);
	updateEntry(entryB, scoreB, beforeA, config.ratings.minElo, now, idA);
	return {
		beforeA,
		afterA: entryA.elo,
		beforeB,
		afterB: entryB.elo,
	};
}

export function sortRatings(entries: ModelLeagueRatingEntry[]) {
	entries.sort((a, b) => {
		if (b.elo !== a.elo) return b.elo - a.elo;
		if (b.wins !== a.wins) return b.wins - a.wins;
		return a.id.localeCompare(b.id);
	});
}
