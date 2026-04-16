import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function extractClusterBlock(sourceText) {
	const leadIndex = sourceText.indexOf('const clusterCatalog = [');
	if (leadIndex < 0) {
		throw new Error('Unable to locate clusterCatalog in tools/release-stability-lint.mjs');
	}
	const bracketStart = sourceText.indexOf('[', leadIndex);
	let depth = 0;
	for (let cursor = bracketStart; cursor < sourceText.length; cursor++) {
		const token = sourceText[cursor];
		if (token === '[') depth++;
		if (token === ']') {
			depth--;
			if (depth === 0) {
				return sourceText.slice(bracketStart + 1, cursor);
			}
		}
	}
	throw new Error('Unable to extract clusterCatalog block');
}

function extractClusterObjects(clusterBlock) {
	const clusters = [];
	const objectPattern = /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)',\s*match:\s*findingEntry\s*=>\s*([\s\S]*?)\n\t\}/g;
	let matchEntry = objectPattern.exec(clusterBlock);
	while (matchEntry) {
		clusters.push({
			id: matchEntry[1],
			label: matchEntry[2],
			matchSource: matchEntry[3].trim(),
		});
		matchEntry = objectPattern.exec(clusterBlock);
	}
	return clusters;
}

function extractAll(pattern, sourceText, projector) {
	const settled = [];
	let matchEntry = pattern.exec(sourceText);
	while (matchEntry) {
		settled.push(projector(matchEntry));
		matchEntry = pattern.exec(sourceText);
	}
	return settled;
}

function annotateCluster(clusterEntry) {
	return {
		...clusterEntry,
		filePaths: extractAll(/findingEntry\.filePath === '([^']+)'/g, clusterEntry.matchSource, matchEntry => matchEntry[1]),
		lineRanges: extractAll(
			/findingEntry\.line >= (\d+) && findingEntry\.line <= (\d+)/g,
			clusterEntry.matchSource,
			matchEntry => ({startLine: Number(matchEntry[1]), endLine: Number(matchEntry[2])}),
		),
		messageTerms: extractAll(/findingEntry\.message\.includes\('([^']+)'\)/g, clusterEntry.matchSource, matchEntry => matchEntry[1]),
		ruleIds: extractAll(/findingEntry\.ruleId === '([^']+)'/g, clusterEntry.matchSource, matchEntry => matchEntry[1]),
	};
}

export async function loadReleaseLintClusters(options = {}) {
	const rootDir = path.resolve(options.rootDir || process.cwd());
	const lintPath = path.join(rootDir, 'tools', 'release-stability-lint.mjs');
	const lintSource = await fs.readFile(lintPath, 'utf8');
	const clusterBlock = extractClusterBlock(lintSource);
	return extractClusterObjects(clusterBlock).map(annotateCluster);
}

export function resolveBucketAnchors(codeGraph, clusterEntry) {
	const symbolsByFile = new Map();
	for (const symbolEntry of codeGraph.symbols) {
		if (!symbolsByFile.has(symbolEntry.filePath)) symbolsByFile.set(symbolEntry.filePath, []);
		symbolsByFile.get(symbolEntry.filePath).push(symbolEntry);
	}
	const anchorFiles = clusterEntry.filePaths.length ? clusterEntry.filePaths : [];
	return anchorFiles.map(filePath => {
		const fileSymbols = symbolsByFile.get(filePath) || [];
		const symbolAnchors = clusterEntry.lineRanges.length ?
			fileSymbols.filter(symbolEntry => clusterEntry.lineRanges.some(
				lineRange => symbolEntry.startLine <= lineRange.endLine && symbolEntry.endLine >= lineRange.startLine,
			)) :
			fileSymbols.slice(0, 8);
		return {
			filePath,
			lineRanges: clusterEntry.lineRanges,
			symbolAnchors: symbolAnchors.map(symbolEntry => ({
				name: symbolEntry.name,
				kind: symbolEntry.kind,
				startLine: symbolEntry.startLine,
				endLine: symbolEntry.endLine,
			})),
		};
	});
}
