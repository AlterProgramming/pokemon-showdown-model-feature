#!/usr/bin/env node

import {
	loadProgram,
	queryNarrowingSites,
	querySeams,
	queryUnionFieldAccess,
	renderText,
	resolveRepoRoot,
	saveArtifact,
} from "./core.mjs";

function parseArgs(argv) {
	const routeName = argv[0];
	const options = {};
	for (let idx = 1; idx < argv.length; idx++) {
		const token = argv[idx];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const nextToken = argv[idx + 1];
		if (!nextToken || nextToken.startsWith("--")) {
			options[key] = true;
			continue;
		}
		options[key] = nextToken;
		idx++;
	}
	return {routeName, options};
}

function usage() {
	return [
		"Usage:",
		"  node tools/typeflow-map/index.mjs field-sites --type ChoiceRequest --field active",
		"  node tools/typeflow-map/index.mjs narrowing-sites --from SideID --to PlayerID",
		"  node tools/typeflow-map/index.mjs seams --from SideRequestData --to RLChoiceTarget",
		"",
		"Flags:",
		"  --root <repo-root>     Override repo root discovery",
		"  --json                 Emit JSON",
		"  --save                 Save branch-local artifact under tools/typeflow-map/artifacts/",
	].join("\n");
}

function requireOption(options, key) {
	const value = options[key];
	if (!value || value === true) {
		throw new Error(`Missing required --${key}`);
	}
	return String(value);
}

async function main() {
	const {routeName, options} = parseArgs(process.argv.slice(2));
	if (!routeName || routeName === "help" || routeName === "--help") {
		console.log(usage());
		process.exit(0);
	}

	const repoRoot = resolveRepoRoot(options.root ? String(options.root) : process.cwd());
	const programState = loadProgram(repoRoot);
	let payload;
	let query;

	if (routeName === "field-sites") {
		query = {
			type: requireOption(options, "type"),
			field: requireOption(options, "field"),
		};
		payload = queryUnionFieldAccess(programState, query);
	} else if (routeName === "narrowing-sites") {
		query = {
			from: requireOption(options, "from"),
			to: requireOption(options, "to"),
		};
		payload = queryNarrowingSites(programState, query);
	} else if (routeName === "seams") {
		query = {
			from: requireOption(options, "from"),
			to: requireOption(options, "to"),
		};
		payload = querySeams(programState, query);
	} else {
		throw new Error(`Unknown command: ${routeName}`);
	}

	let artifactPath;
	if (options.save) {
		artifactPath = saveArtifact(programState, routeName, query, payload);
	}

	if (options.json) {
		console.log(JSON.stringify({
			command: routeName,
			query,
			count: Array.isArray(payload) ? payload.length : undefined,
			artifactPath,
			payload,
		}, null, 2));
		return;
	}

	console.log(renderText(routeName, query, payload));
	if (artifactPath) console.log(`artifact=${artifactPath}`);
}

main().catch(error => {
	console.error(error?.stack || String(error));
	process.exit(1);
});
