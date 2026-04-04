import {loadModelLeagueConfig, resolveModelLeagueConfigPath} from "./config";
import {ModelLeagueDaemon, loadModelLeagueDaemonStatus} from "./daemon";
import {writeControlRequest} from "./storage";
import type {ModelLeagueControlRequest, ModelLeagueControlRequestType} from "./types";

function now() {
	return new Date().toISOString();
}

function randomId(prefix: string) {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseArgs(argv: string[]) {
	const args = [...argv];
	let configPath: string | null = null;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--config" && args[i + 1]) {
			configPath = args[i + 1];
			args.splice(i, 2);
			i -= 1;
		}
	}
	return {configPath, command: args[0] || "status", rest: args.slice(1)};
}

async function queueRequest(configPath: string, type: ModelLeagueControlRequestType, requestedBy: string, modelCheckpointId?: string) {
	const config = loadModelLeagueConfig(configPath);
	const request: ModelLeagueControlRequest = {
		id: randomId(`modelleague-${type}`),
		type,
		createdAt: now(),
		requestedBy,
		...(modelCheckpointId ? {modelCheckpointId} : {}),
	};
	await writeControlRequest(config, request);
	return request;
}

export async function runModelLeagueCLI(argv = process.argv.slice(2)) {
	const {configPath, command, rest} = parseArgs(argv);
	const resolvedConfigPath = resolveModelLeagueConfigPath(
		configPath,
		{preferActive: command !== "start"}
	);
	switch (command) {
	case "start": {
		const daemon = new ModelLeagueDaemon({configPath: resolvedConfigPath});
		process.on("SIGINT", () => void daemon.stop());
		process.on("SIGTERM", () => void daemon.stop());
		await daemon.start();
		return;
	}
	case "pause":
	case "resume":
	case "force-benchmark":
	case "force-snapshot": {
		await queueRequest(resolvedConfigPath, command, "cli");
		console.log(`Queued ${command}.`);
		return;
	}
	case "enqueue-training": {
		const checkpointId = rest[0] || "";
		await queueRequest(resolvedConfigPath, "enqueue-training", "cli", checkpointId || undefined);
		console.log(`Queued enqueue-training${checkpointId ? ` for ${checkpointId}` : ""}.`);
		return;
	}
	case "status": {
		const status = await loadModelLeagueDaemonStatus(resolvedConfigPath);
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	default:
		throw new Error(`Unknown model league command: ${command}`);
	}
}

if (typeof require !== "undefined" && require.main === module) {
	void runModelLeagueCLI().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
