#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const artifactRootName = 'tools/branch-artifacts/state';

main();

function main() {
	const {command, flags} = parseArgs(process.argv.slice(2));
	if (!command || command === 'help') {
		printHelp();
		process.exit(command ? 0 : 2);
	}

	const repoRoot = resolveRepoRoot(flags.root);
	const repoName = flags.repo || path.basename(repoRoot);
	const branchName = flags.branch || resolveGitBranch(repoRoot);
	const taskId = flags.task || flags['task-id'] || 'branch-artifacts';
	const artifactPath = resolveArtifactPath(repoRoot, repoName, branchName, taskId, flags.artifact || flags.path);

	switch (command) {
	case 'init':
		writeArtifact(artifactPath, buildArtifact({
			repo: repoName,
			branch: branchName,
			taskId,
			owner: flags.owner || 'unknown',
			status: flags.status || 'active',
			topology: loadJsonInput(flags.topology, flags['topology-file'], []),
			seams: loadJsonInput(flags.seams, flags['seams-file'], []),
			openRisks: loadJsonInput(flags['open-risks'] ?? flags.openRisks, flags['open-risks-file'] ?? flags.openRisksFile, []),
			validatedCommits: loadJsonInput(flags['validated-commits'] ?? flags.validatedCommits, flags['validated-commits-file'] ?? flags.validatedCommitsFile, []),
			feedback: loadJsonInput(flags.feedback, flags['feedback-file'], []),
		}));
		printArtifactSummary(artifactPath, loadArtifact(artifactPath));
		return;
	case 'update':
		writeArtifact(artifactPath, mergeArtifact(loadArtifact(artifactPath), loadJsonInput(flags.data || flags.patch, flags['data-file'] || flags['patch-file'], {})));
		printArtifactSummary(artifactPath, loadArtifact(artifactPath));
		return;
	case 'load':
		console.log(JSON.stringify(loadArtifact(artifactPath), null, 2));
		return;
	default:
		console.error(`branch-artifacts: unknown command "${command}"`);
		printHelp();
		process.exit(2);
	}
}

function resolveRepoRoot(startDir) {
	let cursor = path.resolve(startDir || process.cwd());
	while (true) {
		if (fs.existsSync(path.join(cursor, '.git'))) return cursor;
		const parent = path.dirname(cursor);
		if (parent === cursor) return process.cwd();
		cursor = parent;
	}
}

function resolveGitBranch(repoRoot) {
	const gitDir = resolveGitDir(repoRoot);
	if (!gitDir) return 'unknown-branch';
	try {
		const headContent = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
		if (headContent.startsWith('ref: ')) {
			const refName = headContent.slice(5).replace(/^refs\/heads\//, '');
			return refName || 'unknown-branch';
		}
		return headContent.slice(0, 7) || 'detached-head';
	} catch {
		return 'unknown-branch';
	}
}

function resolveGitDir(repoRoot) {
	const gitEntry = path.join(repoRoot, '.git');
	if (fs.existsSync(gitEntry) && fs.statSync(gitEntry).isDirectory()) return gitEntry;
	if (!fs.existsSync(gitEntry)) return null;
	try {
		const gitPointer = fs.readFileSync(gitEntry, 'utf8').trim();
		const match = /^gitdir:\s*(.+)$/i.exec(gitPointer);
		if (!match) return null;
		return path.resolve(repoRoot, match[1]);
	} catch {
		return null;
	}
}

function resolveArtifactPath(repoRoot, repoName, branchName, taskId, explicitPath) {
	if (explicitPath) {
		return path.isAbsolute(explicitPath) ? explicitPath : path.join(repoRoot, explicitPath);
	}
	return path.join(repoRoot, artifactRootName, slugify(repoName), slugify(branchName), `${slugify(taskId)}.json`);
}

function buildArtifact({
	repo,
	branch,
	taskId,
	owner,
	status,
	topology,
	seams,
	openRisks,
	validatedCommits,
	feedback,
}) {
	const timestamp = new Date().toISOString();
	return normalizeArtifact({
		version: 1,
		repo,
		branch,
		taskId,
		owner,
		status,
		topology,
		seams,
		openRisks,
		validatedCommits,
		feedback,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
}

function loadArtifact(filePath) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`branch-artifacts: artifact not found at ${filePath}`);
	}
	return normalizeArtifact(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeArtifact(filePath, artifact) {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, `${JSON.stringify(normalizeArtifact(artifact), null, 2)}\n`);
}

function mergeArtifact(baseArtifact, patch) {
	const merged = normalizeArtifact({
		...baseArtifact,
		...patch,
		topology: mergeArray(baseArtifact.topology, patch.topology, item => stableKey(item, ['node', 'role'])),
		seams: mergeArray(baseArtifact.seams, patch.seams, item => stableKey(item, ['from', 'to', 'contract'])),
		openRisks: mergeArray(baseArtifact.openRisks, patch.openRisks, item => String(item)),
		validatedCommits: mergeArray(baseArtifact.validatedCommits, patch.validatedCommits, item => stableKey(item, ['sha', 'message'])),
		feedback: mergeArray(baseArtifact.feedback, patch.feedback, item => stableKey(item, ['from', 'note', 'at'])),
	});
	merged.updatedAt = new Date().toISOString();
	return merged;
}

function normalizeArtifact(rawArtifact) {
	return {
		version: 1,
		repo: String(rawArtifact.repo || 'unknown'),
		branch: String(rawArtifact.branch || 'unknown'),
		taskId: String(rawArtifact.taskId || 'unknown'),
		owner: String(rawArtifact.owner || 'unknown'),
		status: String(rawArtifact.status || 'active'),
		topology: normalizeObjectArray(rawArtifact.topology),
		seams: normalizeObjectArray(rawArtifact.seams),
		openRisks: normalizeStringArray(rawArtifact.openRisks),
		validatedCommits: normalizeObjectArray(rawArtifact.validatedCommits),
		feedback: normalizeObjectArray(rawArtifact.feedback),
		createdAt: String(rawArtifact.createdAt || new Date().toISOString()),
		updatedAt: String(rawArtifact.updatedAt || new Date().toISOString()),
	};
}

function normalizeObjectArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter(entry => entry && typeof entry === 'object').map(entry => ({...entry}));
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(entry => String(entry).trim()).filter(Boolean))];
}

function mergeArray(baseItems, patchItems, keyFn) {
	const settled = [];
	const seen = new Set();
	for (const item of [...(Array.isArray(baseItems) ? baseItems : []), ...(Array.isArray(patchItems) ? patchItems : [])]) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		settled.push(item);
	}
	return settled;
}

function stableKey(item, keys) {
	return keys.map(key => String(item?.[key] ?? '')).join('|');
}

function parseJsonFlag(value, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== 'string' || !value.trim()) return fallback;
	return JSON.parse(value);
}

function loadJsonInput(value, filePath, fallback) {
	if (filePath) {
		const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
		return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
	}
	return parseJsonFlag(value, fallback);
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith('--')) continue;
		const key = token.slice(2);
		const next = rest[i + 1];
		if (next && !next.startsWith('--')) {
			flags[key] = next;
			i++;
		} else {
			flags[key] = 'true';
		}
	}
	return {command, flags};
}

function printArtifactSummary(artifactPath, artifact) {
	console.log(JSON.stringify({
		path: artifactPath,
		repo: artifact.repo,
		branch: artifact.branch,
		taskId: artifact.taskId,
		owner: artifact.owner,
		status: artifact.status,
		topology: artifact.topology.length,
		seams: artifact.seams.length,
		openRisks: artifact.openRisks.length,
		validatedCommits: artifact.validatedCommits.length,
		feedback: artifact.feedback.length,
	}, null, 2));
}

function printHelp() {
	console.log([
		'branch-artifacts usage:',
		'  node tools/branch-artifacts/branch-artifacts.mjs init  --task <id> [--owner <name>] [--repo <name>] [--branch <name>] [--artifact <path>] [--topology JSON] [--seams JSON] [--open-risks JSON] [--validated-commits JSON] [--feedback JSON]',
		'  node tools/branch-artifacts/branch-artifacts.mjs update --artifact <path> --data JSON',
		'  node tools/branch-artifacts/branch-artifacts.mjs load   --artifact <path>',
	].join('\n'));
}

function slugify(value) {
	return String(value || 'unknown')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		|| 'unknown';
}
