import process from 'node:process';
import {buildCodeGraph} from './graph.mjs';
import {loadReleaseLintClusters, resolveBucketAnchors} from './clusters.mjs';

function parseCli(argv) {
	const [command, ...rest] = argv;
	const options = {json: false};
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (token === '--json') {
			options.json = true;
			continue;
		}
		if (token.startsWith('--')) {
			options[token.slice(2)] = rest[index + 1];
			index++;
		}
	}
	return {command, options};
}

function printJson(value) {
	console.log(JSON.stringify(value, null, 2));
}

function printList(label, values) {
	console.log(`${label}:`);
	if (!values.length) {
		console.log('  (none)');
		return;
	}
	for (const value of values) {
		console.log(`  ${value}`);
	}
}

function normalizeSymbolFilter(rawValue) {
	return String(rawValue || '').trim();
}

function symbolMatchesQuery(symbolName, queryName) {
	return symbolName === queryName || symbolName.endsWith(`.${queryName}`);
}

function buildContactsView(codeGraph, filePath) {
	const imports = codeGraph.importsByFile[filePath] || [];
	const importedBy = codeGraph.importedByFile[filePath] || [];
	const fileSymbols = codeGraph.symbols
		.filter(symbolEntry => symbolEntry.filePath === filePath)
		.map(symbolEntry => `${symbolEntry.name} (${symbolEntry.startLine}-${symbolEntry.endLine})`);
	const outboundCalls = codeGraph.calls
		.filter(callEntry => callEntry.callerFilePath === filePath)
		.map(callEntry => ({
			target: callEntry.targetFilePath ? `${callEntry.targetFilePath}:${callEntry.targetName}` : callEntry.targetName,
			line: callEntry.callerLine,
		}));
	const uniqueOutbound = [...new Map(outboundCalls.map(callEntry => [`${callEntry.target}:${callEntry.line}`, callEntry])).values()];
	return {
		filePath,
		imports,
		importedBy,
		symbols: fileSymbols,
		outboundCalls: uniqueOutbound,
	};
}

function renderContactsView(view) {
	console.log(`file: ${view.filePath}`);
	printList(
		'imports',
		view.imports.map(importEntry => `${importEntry.targetPath}${importEntry.typeOnly ? ' [type]' : ''}`),
	);
	printList('imported_by', view.importedBy);
	printList('symbols', view.symbols);
	printList(
		'outbound_calls',
		view.outboundCalls.map(callEntry => `${callEntry.target} @${callEntry.line}`),
	);
}

function buildCallersView(codeGraph, symbolName, filePath) {
	const symbolFrontier = codeGraph.symbols.filter(symbolEntry => {
		if (!symbolMatchesQuery(symbolEntry.name, symbolName)) return false;
		return filePath ? symbolEntry.filePath === filePath : true;
	});
	const targetKeys = new Set(symbolFrontier.map(symbolEntry => symbolEntry.key));
	const callers = codeGraph.calls.filter(callEntry => {
		if (targetKeys.size && callEntry.targetFilePath && callEntry.targetStartLine !== null) {
			return [...targetKeys].some(targetKey => targetKey.startsWith(`${callEntry.targetFilePath}:`) &&
				(targetKey.endsWith(`:${callEntry.targetName}`) || targetKey.endsWith(`:${symbolName}`)));
		}
		return symbolMatchesQuery(callEntry.targetName, symbolName) || callEntry.simpleName === symbolName;
	});
	return {
		symbolName,
		filePath: filePath || null,
		targets: symbolFrontier,
		callers: callers.map(callEntry => ({
			caller: callEntry.callerName,
			filePath: callEntry.callerFilePath,
			line: callEntry.callerLine,
			callText: callEntry.callText,
		})),
	};
}

function renderCallersView(view) {
	console.log(`symbol: ${view.symbolName}`);
	if (view.filePath) console.log(`file: ${view.filePath}`);
	printList(
		'targets',
		view.targets.map(targetEntry => `${targetEntry.filePath}:${targetEntry.name} (${targetEntry.startLine}-${targetEntry.endLine})`),
	);
	printList(
		'callers',
		view.callers.map(callerEntry => `${callerEntry.filePath}:${callerEntry.caller} @${callerEntry.line} -> ${callerEntry.callText}`),
	);
}

function renderBucketView(bucketView) {
	console.log(`bucket: ${bucketView.id}`);
	console.log(`label: ${bucketView.label}`);
	printList('files', bucketView.filePaths);
	printList(
		'line_ranges',
		bucketView.lineRanges.map(lineRange => `${lineRange.startLine}-${lineRange.endLine}`),
	);
	printList('rule_ids', bucketView.ruleIds);
	printList('message_terms', bucketView.messageTerms);
	console.log('anchors:');
	if (!bucketView.anchors.length) {
		console.log('  (none)');
		return;
	}
	for (const anchorEntry of bucketView.anchors) {
		console.log(`  ${anchorEntry.filePath}`);
		if (!anchorEntry.symbolAnchors.length) {
			console.log('    symbols: (none)');
			continue;
		}
		for (const symbolEntry of anchorEntry.symbolAnchors) {
			console.log(`    ${symbolEntry.name} (${symbolEntry.startLine}-${symbolEntry.endLine})`);
		}
	}
}

function printUsage() {
	console.log('Usage: node tools/codegraph/cli.mjs <contacts|callers|bucket|clusters> [options]');
	console.log('  contacts --file <repo-relative-path> [--json]');
	console.log('  callers --symbol <name> [--file <repo-relative-path>] [--json]');
	console.log('  bucket --id <cluster-id> [--json]');
	console.log('  clusters [--json]');
}

async function main() {
	const {command, options} = parseCli(process.argv.slice(2));
	if (!command) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	if (command === 'clusters') {
		const clusters = await loadReleaseLintClusters();
		if (options.json) {
			printJson(clusters);
		} else {
			for (const clusterEntry of clusters) {
				console.log(`${clusterEntry.id}: ${clusterEntry.label}`);
			}
		}
		return;
	}

	const codeGraph = buildCodeGraph();
	if (command === 'contacts') {
		const filePath = String(options.file || '').trim();
		if (!filePath) {
			throw new Error('contacts requires --file');
		}
		const contactsView = buildContactsView(codeGraph, filePath);
		if (options.json) {
			printJson(contactsView);
		} else {
			renderContactsView(contactsView);
		}
		return;
	}

	if (command === 'callers') {
		const symbolName = normalizeSymbolFilter(options.symbol);
		if (!symbolName) {
			throw new Error('callers requires --symbol');
		}
		const callersView = buildCallersView(codeGraph, symbolName, options.file ? String(options.file).trim() : '');
		if (options.json) {
			printJson(callersView);
		} else {
			renderCallersView(callersView);
		}
		return;
	}

	if (command === 'bucket') {
		const bucketId = String(options.id || '').trim();
		if (!bucketId) {
			throw new Error('bucket requires --id');
		}
		const clusters = await loadReleaseLintClusters();
		const bucketEntry = clusters.find(clusterEntry => clusterEntry.id === bucketId);
		if (!bucketEntry) {
			throw new Error(`Unknown bucket "${bucketId}"`);
		}
		const bucketView = {
			...bucketEntry,
			anchors: resolveBucketAnchors(codeGraph, bucketEntry),
		};
		if (options.json) {
			printJson(bucketView);
		} else {
			renderBucketView(bucketView);
		}
		return;
	}

	throw new Error(`Unknown command "${command}"`);
}

main().catch(error => {
	console.error(`codegraph: ${error.message || error}`);
	process.exitCode = 1;
});
