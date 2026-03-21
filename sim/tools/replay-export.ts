import * as fs from "fs";
import * as path from "path";

export type ReplayCaptureMode = "none" | "all" | "wins" | "losses" | "ties";
export type ReplayOutcome = "win" | "loss" | "tie";

export function parseReplayCaptureMode(value: string | undefined): ReplayCaptureMode {
	if (!value) return "none";
	switch (value.trim().toLowerCase()) {
	case "all":
	case "every":
		return "all";
	case "win":
	case "wins":
		return "wins";
	case "loss":
	case "losses":
	case "lose":
		return "losses";
	case "tie":
	case "ties":
	case "draw":
		return "ties";
	default:
		return "none";
	}
}

export function shouldCaptureReplay(mode: ReplayCaptureMode, outcome: ReplayOutcome): boolean {
	switch (mode) {
	case "all":
		return true;
	case "wins":
		return outcome === "win";
	case "losses":
		return outcome === "loss";
	case "ties":
		return outcome === "tie";
	default:
		return false;
	}
}

export function sanitizeReplayFileSegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "battle";
}

function formatBattleLogForHtml(battleLog: string): string {
	return battleLog.replace(/<\/script/gi, "<\\/script");
}

export function saveReplayHtml(options: {
	outputDir: string;
	fileStem: string;
	battleLog: string;
	title?: string;
}): string {
	const outputDir = path.resolve(options.outputDir);
	fs.mkdirSync(outputDir, {recursive: true});

	const filePath = path.join(outputDir, `${options.fileStem}.html`);
	const title = options.title || options.fileStem;
	const replayHtml =
		`<!DOCTYPE html>\n` +
		`<meta charset="utf-8">\n` +
		`<title>${title}</title>\n` +
		`<script type="text/plain" class="battle-log-data">${formatBattleLogForHtml(options.battleLog)}</script>\n` +
		`<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>\n`;
	fs.writeFileSync(filePath, replayHtml);
	return filePath;
}
