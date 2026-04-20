#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
	console.log(`Usage: node scripts/sync-upstream.mjs [options]

Fetches the configured upstream branch and merges it into the current branch.

Options:
  --remote <name>       Git remote to sync from (default: upstream)
  --branch <name>       Remote branch to sync from (default: master)
  --local-ref <ref>     Local ref to report from (default: HEAD)
  --no-fetch            Skip the fetch step explicitly
  -h, --help            Show this help
`);
}

function parseArgs(argv) {
	const out = {
		remote: 'upstream',
		branch: 'master',
		localRef: 'HEAD',
		fetch: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
			return argv[++i];
		};
		if (arg === '-h' || arg === '--help') {
			out.help = true;
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
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
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

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		usage();
		return;
	}

	const remoteUrl = runGit(['remote', 'get-url', args.remote]).trim();
	const upstreamRef = `${args.remote}/${args.branch}`;

	console.log('Pokémon Showdown upstream sync');
	console.log(`Local ref:    ${args.localRef}`);
	console.log(`Upstream ref:  ${upstreamRef}`);
	console.log(`Remote URL:    ${remoteUrl}`);

	if (args.fetch) {
		runGit(['fetch', '--prune', args.remote, args.branch], { stdio: 'inherit' });
	}

	const [ahead, behind] = runGit(['rev-list', '--left-right', '--count', `${args.localRef}...${upstreamRef}`]).trim().split(/\s+/).map(Number);
	console.log(`Ahead/behind:  ${ahead}/${behind}`);

	if (behind === 0) {
		console.log('Status: already synced');
		return;
	}

	runGit(['merge', '--no-ff', '--no-edit', upstreamRef], { stdio: 'inherit' });
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
