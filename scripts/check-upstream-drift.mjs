#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
	console.log(`Usage: node scripts/check-upstream-drift.mjs [options]

Checks how far the local branch has drifted from an upstream ref.

Options:
  --remote <name>        Git remote to inspect (default: upstream)
  --branch <name>        Remote branch to compare (default: master)
  --local-ref <ref>      Local ref to compare from (default: HEAD)
  --upstream-ref <ref>   Fully qualified upstream ref to compare against
                         (default: <remote>/<branch>)
  --fetch                Fetch the remote branch before comparing
  --no-fetch             Skip the fetch step explicitly
  --max-commits <n>      Max commits to show per side (default: 10)
  -h, --help             Show this help
`);
}

function parseArgs(argv) {
	const out = {
		remote: 'upstream',
		branch: 'master',
		localRef: 'HEAD',
		upstreamRef: '',
		fetch: false,
		maxCommits: 10,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
			return argv[++i];
		};
		if (arg === '-h' || arg === '--help') {
			out.help = true;
		} else if (arg === '--fetch') {
			out.fetch = true;
		} else if (arg === '--no-fetch') {
			out.fetch = false;
		} else if (arg === '--remote') {
			out.remote = next();
		} else if (arg.startsWith('--remote=')) {
			out.remote = arg.slice('--remote='.length);
		} else if (arg === '--branch') {
			out.branch = next();
		} else if (arg.startsWith('--branch=')) {
			out.branch = arg.slice('--branch='.length);
		} else if (arg === '--local-ref') {
			out.localRef = next();
		} else if (arg.startsWith('--local-ref=')) {
			out.localRef = arg.slice('--local-ref='.length);
		} else if (arg === '--upstream-ref') {
			out.upstreamRef = next();
		} else if (arg.startsWith('--upstream-ref=')) {
			out.upstreamRef = arg.slice('--upstream-ref='.length);
		} else if (arg === '--max-commits') {
			out.maxCommits = Number(next());
		} else if (arg.startsWith('--max-commits=')) {
			out.maxCommits = Number(arg.slice('--max-commits='.length));
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!Number.isInteger(out.maxCommits) || out.maxCommits < 0) {
		throw new Error('--max-commits must be a non-negative integer');
	}
	if (!out.upstreamRef) out.upstreamRef = `${out.remote}/${out.branch}`;
	return out;
}

function runGit(args, options = {}) {
	return execFileSync('git', args, {
		cwd: repoRoot,
		encoding: 'utf8',
		maxBuffer: 1024 * 1024,
		...options,
	});
}

function runGitOrNull(args, options = {}) {
	try {
		return runGit(args, options);
	} catch (error) {
		return null;
	}
}

function splitLines(text) {
	return text.trim().length ? text.trim().split('\n') : [];
}

function printSection(title, lines) {
	if (!lines.length) return;
	console.log('');
	console.log(title);
	for (const line of lines) console.log(`  ${line}`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		usage();
		return;
	}

	let remoteUrl = runGitOrNull(['remote', 'get-url', args.remote]);
	if (remoteUrl === null) {
		console.log(`No '${args.remote}' remote is configured.`);
		console.log('Add it with: git remote add upstream https://github.com/smogon/pokemon-showdown.git');
		process.exitCode = 1;
		return;
	}
	remoteUrl = remoteUrl.trim();

	if (args.fetch) {
		try {
			runGit(['fetch', '--prune', args.remote, args.branch], { stdio: 'inherit' });
		} catch (error) {
			console.error(`Failed to fetch ${args.remote}/${args.branch}`);
			process.exitCode = 1;
			return;
		}
	}

	const refCheck = runGitOrNull(['rev-parse', '--verify', `${args.upstreamRef}^{commit}`]);
	if (refCheck === null) {
		console.log(`Upstream ref '${args.upstreamRef}' is not available locally.`);
		console.log('Run again with --fetch after adding the upstream remote, or point --upstream-ref at a local remote-tracking ref.');
		process.exitCode = 1;
		return;
	}

	const counts = runGit(['rev-list', '--left-right', '--count', `${args.localRef}...${args.upstreamRef}`]).trim().split(/\s+/);
	const ahead = Number(counts[0]);
	const behind = Number(counts[1]);

	console.log('Pokémon Showdown upstream drift');
	console.log(`Local ref:    ${args.localRef}`);
	console.log(`Upstream ref:  ${args.upstreamRef}`);
	console.log(`Remote URL:    ${remoteUrl}`);
	console.log(`Ahead/behind:  ${ahead}/${behind}`);

	if (ahead === 0 && behind === 0) {
		console.log('Status: synced');
		return;
	}

	console.log(`Status: ${behind ? `behind by ${behind}` : 'up to date'}${ahead ? `, ahead by ${ahead}` : ''}`);

	const upstreamOnly = splitLines(runGit(['log', '--oneline', '--decorate', `--max-count=${args.maxCommits}`, `${args.localRef}..${args.upstreamRef}`]));
	const localOnly = splitLines(runGit(['log', '--oneline', '--decorate', `--max-count=${args.maxCommits}`, `${args.upstreamRef}..${args.localRef}`]));

	printSection(`Upstream-only commits${upstreamOnly.length ? ` (showing up to ${args.maxCommits})` : ''}`, upstreamOnly.length ? upstreamOnly : ['None']);
	printSection(`Local-only commits${localOnly.length ? ` (showing up to ${args.maxCommits})` : ''}`, localOnly.length ? localOnly : ['None']);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
