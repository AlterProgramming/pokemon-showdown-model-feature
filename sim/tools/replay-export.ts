import * as fs from "fs";
import * as path from "path";

export type ReplayCaptureMode = "none" | "all" | "wins" | "losses" | "ties";
export type ReplayOutcome = "win" | "loss" | "tie";
export type ReplayTileStatus = "waiting" | "running" | "completed" | "failed";

export type ReplayDashboardTile = {
	slot: number;
	label?: string;
	title: string;
	subtitle?: string;
	fileName: string;
	status: ReplayTileStatus;
};

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

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function ensureOutputDir(outputDir: string): string {
	const resolved = path.resolve(outputDir);
	fs.mkdirSync(resolved, {recursive: true});
	return resolved;
}

function buildReplayHtml(options: {
	title: string;
	battleLog: string;
	live?: boolean;
	refreshSeconds?: number;
	statusLabel?: string;
	autoplayMuted?: boolean;
}): string {
	const title = escapeHtml(options.title);
	const refreshMeta = options.live && options.refreshSeconds ?
		`<meta http-equiv="refresh" content="${options.refreshSeconds}">\n` : "";
	const status = options.statusLabel ? `<div class="status">${escapeHtml(options.statusLabel)}</div>\n` : "";
	const preEmbedMuteScript = options.autoplayMuted ? (
		`<script>\n` +
		`(function () {\n` +
		`  function applyMutedPrefs() {\n` +
		`    try {\n` +
		`      for (const key of ['showdown_prefs', 'showdown_prefs_beta']) {\n` +
		`        let prefs = {};\n` +
		`        try {\n` +
		`          prefs = JSON.parse(localStorage.getItem(key) || '{}') || {};\n` +
		`        } catch {}\n` +
		`        prefs.mute = true;\n` +
		`        prefs.musicvolume = 0;\n` +
		`        prefs.effectvolume = 0;\n` +
		`        prefs.bgmvolume = 0;\n` +
		`        localStorage.setItem(key, JSON.stringify(prefs));\n` +
		`      }\n` +
		`    } catch {}\n` +
		`  }\n` +
		`  function muteMedia(media) {\n` +
		`    if (!media) return media;\n` +
		`    try { media.muted = true; } catch {}\n` +
		`    try { media.defaultMuted = true; } catch {}\n` +
		`    try { media.volume = 0; } catch {}\n` +
		`    return media;\n` +
		`  }\n` +
		`  applyMutedPrefs();\n` +
		`  const NativeAudio = window.Audio;\n` +
		`  if (typeof NativeAudio === 'function') {\n` +
		`    const WrappedAudio = function (...args) {\n` +
		`      return muteMedia(new NativeAudio(...args));\n` +
		`    };\n` +
		`    WrappedAudio.prototype = NativeAudio.prototype;\n` +
		`    Object.setPrototypeOf(WrappedAudio, NativeAudio);\n` +
		`    window.Audio = WrappedAudio;\n` +
		`  }\n` +
		`  const originalPlay = HTMLMediaElement.prototype.play;\n` +
		`  HTMLMediaElement.prototype.play = function (...args) {\n` +
		`    muteMedia(this);\n` +
		`    applyMutedPrefs();\n` +
		`    return originalPlay.apply(this, args);\n` +
		`  };\n` +
		`  const observer = new MutationObserver(function () {\n` +
		`    applyMutedPrefs();\n` +
		`    for (const media of document.querySelectorAll('audio, video')) muteMedia(media);\n` +
		`  });\n` +
		`  observer.observe(document.documentElement, {subtree: true, childList: true});\n` +
		`  window.__psReplayMuteMedia = muteMedia;\n` +
		`  window.__psReplayApplyMutedPrefs = applyMutedPrefs;\n` +
		`})();\n` +
		`</script>\n`
	) : "";
	const autoplayScript = options.autoplayMuted ? (
		`<script>\n` +
		`(function () {\n` +
		`  const PLAY_PATTERN = /(play|start|resume)/i;\n` +
		`  const PAUSE_PATTERN = /(pause|stop)/i;\n` +
		`  function muteMedia() {\n` +
		`    if (window.__psReplayApplyMutedPrefs) window.__psReplayApplyMutedPrefs();\n` +
		`    for (const media of document.querySelectorAll('audio, video')) {\n` +
		`      if (window.__psReplayMuteMedia) window.__psReplayMuteMedia(media);\n` +
		`      else {\n` +
		`        media.muted = true;\n` +
		`        media.volume = 0;\n` +
		`      }\n` +
		`    }\n` +
		`  }\n` +
		`  function buttonLabel(button) {\n` +
		`    return [button.name, button.value, button.title, button.textContent, button.getAttribute('aria-label')].filter(Boolean).join(' ');\n` +
		`  }\n` +
		`  function isVisible(element) {\n` +
		`    return !!(element && element.isConnected && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));\n` +
		`  }\n` +
		`  function hasPauseState() {\n` +
		`    for (const button of document.querySelectorAll('button, input[type=\"button\"], input[type=\"submit\"]')) {\n` +
		`      if (!isVisible(button)) continue;\n` +
		`      if (PAUSE_PATTERN.test(buttonLabel(button))) return true;\n` +
		`    }\n` +
		`    return false;\n` +
		`  }\n` +
		`  function findPlayButton() {\n` +
		`    for (const button of document.querySelectorAll('button, input[type=\"button\"], input[type=\"submit\"]')) {\n` +
		`      if (!isVisible(button)) continue;\n` +
		`      const label = buttonLabel(button);\n` +
		`      if (PLAY_PATTERN.test(label) && !PAUSE_PATTERN.test(label)) return button;\n` +
		`    }\n` +
		`    return null;\n` +
		`  }\n` +
		`  let autoplayDone = false;\n` +
		`  function attemptAutoplay() {\n` +
		`    muteMedia();\n` +
		`    if (autoplayDone || hasPauseState()) {\n` +
		`      autoplayDone = true;\n` +
		`      return true;\n` +
		`    }\n` +
		`    const playButton = findPlayButton();\n` +
		`    if (!playButton) return false;\n` +
		`    playButton.click();\n` +
		`    muteMedia();\n` +
		`    autoplayDone = true;\n` +
		`    return true;\n` +
		`  }\n` +
		`  const interval = setInterval(function () {\n` +
		`    if (attemptAutoplay()) clearInterval(interval);\n` +
		`  }, 500);\n` +
		`  setTimeout(function () { clearInterval(interval); muteMedia(); }, 30000);\n` +
		`  window.addEventListener('load', attemptAutoplay);\n` +
		`  document.addEventListener('readystatechange', attemptAutoplay);\n` +
		`})();\n` +
		`</script>\n`
	) : "";
	const body = options.battleLog.trim() ?
		`<script type="text/plain" class="battle-log-data">${formatBattleLogForHtml(options.battleLog)}</script>\n` +
		preEmbedMuteScript +
		`<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>\n` +
		autoplayScript :
		`<main class="placeholder">\n` +
		`<h1>${title}</h1>\n` +
		`<p>Waiting for battle log...</p>\n` +
		`</main>\n`;
	return (
		`<!DOCTYPE html>\n` +
		`<meta charset="utf-8">\n` +
		refreshMeta +
		`<title>${title}</title>\n` +
		`<style>\n` +
		`body { margin: 0; font: 14px/1.4 Verdana, sans-serif; background: #f6f7fb; color: #1b2330; }\n` +
		`.status { padding: 6px 10px; background: #fff4cc; border-bottom: 1px solid #e7d791; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }\n` +
		`.placeholder { min-height: 100vh; display: grid; place-content: center; gap: 8px; text-align: center; }\n` +
		`.placeholder h1 { margin: 0; font-size: 20px; }\n` +
		`.placeholder p { margin: 0; color: #58657a; }\n` +
		`</style>\n` +
		status +
		body
	);
}

export function saveReplayHtml(options: {
	outputDir: string;
	fileStem: string;
	battleLog: string;
	title?: string;
	live?: boolean;
	refreshSeconds?: number;
	statusLabel?: string;
	autoplayMuted?: boolean;
}): string {
	const outputDir = ensureOutputDir(options.outputDir);

	const filePath = path.join(outputDir, `${options.fileStem}.html`);
	const title = options.title || options.fileStem;
	const replayHtml = buildReplayHtml({
		title,
		battleLog: options.battleLog,
		live: options.live,
		refreshSeconds: options.refreshSeconds,
		statusLabel: options.statusLabel,
		autoplayMuted: options.autoplayMuted,
	});
	fs.writeFileSync(filePath, replayHtml);
	return filePath;
}

export function saveReplayDashboardHtml(options: {
	outputDir: string;
	fileName: string;
	title: string;
	tiles: ReplayDashboardTile[];
	refreshSeconds?: number;
}): string {
	const outputDir = ensureOutputDir(options.outputDir);
	const filePath = path.join(outputDir, options.fileName);
	const manifestFileName = options.fileName.replace(/\.html?$/i, "") + ".data.js";
	const manifestPath = path.join(outputDir, manifestFileName);
	const manifestPayload = JSON.stringify({
		title: options.title,
		tiles: options.tiles,
	});
	const pollMs = Math.max(1000, Math.round((options.refreshSeconds || 2) * 1000));
	const html =
		`<!DOCTYPE html>\n` +
		`<meta charset="utf-8">\n` +
		`<title>${escapeHtml(options.title)}</title>\n` +
		`<style>\n` +
		`:root { color-scheme: light; }\n` +
		`body { margin: 0; padding: 18px; font: 13px/1.4 Verdana, sans-serif; background: linear-gradient(180deg, #edf2fa, #f7f9fc); color: #182133; }\n` +
		`h1 { margin: 0 0 4px; font-size: 24px; font-weight: 700; }\n` +
		`.lede { margin: 0 0 14px; color: #6a768a; font-size: 12px; }\n` +
		`.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 10px; align-items: start; }\n` +
		`.tile { background: rgba(255, 255, 255, 0.68); border-radius: 14px; overflow: hidden; backdrop-filter: blur(6px); }\n` +
		`.tile header { padding: 8px 10px 6px; }\n` +
		`.tile h2 { margin: 2px 0 0; font-size: 14px; font-weight: 600; }\n` +
		`.tile p { margin: 3px 0 0; color: #687487; font-size: 11px; }\n` +
		`.eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #708097; }\n` +
		`.status-running .eyebrow { color: #0f766e; }\n` +
		`.status-completed .eyebrow { color: #2563eb; }\n` +
		`.status-failed .eyebrow { color: #b42318; }\n` +
		`.status-waiting .eyebrow { color: #7a5d00; }\n` +
		`.empty { padding: 24px; border-radius: 14px; background: rgba(255,255,255,0.58); }\n` +
		`.empty h2 { margin: 0 0 6px; font-size: 16px; }\n` +
		`.empty p { margin: 0; color: #667388; }\n` +
		`iframe { display: block; width: 100%; height: 420px; border: 0; background: #fff; border-radius: 12px; }\n` +
		`</style>\n` +
		`<body>\n` +
		`<h1>${escapeHtml(options.title)}</h1>\n` +
		`<p class="lede">Open this file in a browser during a benchmark run and completed games will be added to the grid automatically.</p>\n` +
		`<section class="grid" id="grid"></section>\n` +
		`<script>\n` +
		`const manifestFileName = ${JSON.stringify(manifestFileName)};\n` +
		`const pollMs = ${pollMs};\n` +
		`const grid = document.getElementById('grid');\n` +
		`const rendered = new Set();\n` +
		`function renderEmpty() {\n` +
		`  if (rendered.size || document.querySelector('.empty')) return;\n` +
		`  const empty = document.createElement('article');\n` +
		`  empty.className = 'empty';\n` +
		`  empty.innerHTML = '<h2>No completed replays yet</h2><p>Keep this page open during the benchmark run and finished games will appear here automatically.</p>';\n` +
		`  grid.appendChild(empty);\n` +
		`}\n` +
		`function clearEmpty() {\n` +
		`  const empty = document.querySelector('.empty');\n` +
		`  if (empty) empty.remove();\n` +
		`}\n` +
		`function appendTile(tile) {\n` +
		`  const key = tile.fileName;\n` +
		`  if (rendered.has(key)) return;\n` +
		`  rendered.add(key);\n` +
		`  clearEmpty();\n` +
		`  const article = document.createElement('article');\n` +
		`  article.className = 'tile status-' + tile.status;\n` +
		`  const header = document.createElement('header');\n` +
		`  const eyebrow = document.createElement('div');\n` +
		`  eyebrow.className = 'eyebrow';\n` +
		`  eyebrow.textContent = (tile.label || ('Slot ' + tile.slot)) + ' | ' + tile.status;\n` +
		`  const title = document.createElement('h2');\n` +
		`  title.textContent = tile.title;\n` +
		`  header.appendChild(eyebrow);\n` +
		`  header.appendChild(title);\n` +
		`  if (tile.subtitle) {\n` +
		`    const subtitle = document.createElement('p');\n` +
		`    subtitle.textContent = tile.subtitle;\n` +
		`    header.appendChild(subtitle);\n` +
		`  }\n` +
		`  const frame = document.createElement('iframe');\n` +
		`  frame.src = encodeURI(tile.fileName);\n` +
		`  frame.loading = 'lazy';\n` +
		`  article.appendChild(header);\n` +
		`  article.appendChild(frame);\n` +
		`  grid.appendChild(article);\n` +
		`}\n` +
		`function applyManifest(data) {\n` +
		`  if (!data || !Array.isArray(data.tiles)) {\n` +
		`    renderEmpty();\n` +
		`    return;\n` +
		`  }\n` +
		`  if (data.title) document.title = data.title;\n` +
		`  for (const tile of data.tiles) appendTile(tile);\n` +
		`  if (!data.tiles.length) renderEmpty();\n` +
		`}\n` +
		`function loadManifest() {\n` +
		`  const prior = document.getElementById('replay-grid-manifest');\n` +
		`  if (prior) prior.remove();\n` +
		`  const script = document.createElement('script');\n` +
		`  script.id = 'replay-grid-manifest';\n` +
		`  script.src = manifestFileName + '?t=' + Date.now();\n` +
		`  script.onload = () => applyManifest(window.__replayGridManifest || null);\n` +
		`  script.onerror = renderEmpty;\n` +
		`  document.body.appendChild(script);\n` +
		`}\n` +
		`renderEmpty();\n` +
		`loadManifest();\n` +
		`setInterval(loadManifest, pollMs);\n` +
		`</script>\n` +
		`</body>\n`;
	fs.writeFileSync(manifestPath, `window.__replayGridManifest = ${manifestPayload};\n`);
	fs.writeFileSync(filePath, html);
	return filePath;
}
