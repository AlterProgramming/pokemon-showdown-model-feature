// @ts-check

import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import process from 'node:process';
import ts from 'typescript';

const scopeCatalog = {
	release: filePath => {
		const normalizedPath = normalizePath(filePath);
		return (
			normalizedPath === 'server/browser-model-bridge.ts' ||
			normalizedPath === 'server/chat-plugins/model-league.ts' ||
			normalizedPath.startsWith('server/model-league/') ||
			normalizedPath === 'sim/examples/model-vs-model-runner.ts' ||
			normalizedPath === 'sim/examples/statistical-runner.ts' ||
			normalizedPath === 'sim/tools/model-league-runner.ts' ||
			normalizedPath === 'sim/tools/protocol-state-tracker.ts' ||
			normalizedPath === 'sim/tools/replay-export.ts' ||
			normalizedPath === 'sim/tools/rl-action-helpers.ts' ||
			normalizedPath === 'sim/tools/rl-agent.ts' ||
			normalizedPath === 'sim/tools/rl-model-client.ts'
		);
	},
	all: () => true,
};
const riskyIdentifierRoots = new Set([
	'entry',
	'state',
	'checkpoint',
	'progress',
	'job',
	'session',
	'challenger',
	'opponent',
	'teamA',
	'teamB',
	'modelA',
	'modelB',
]);
const riskyNestedRoots = new Set([
	'entry',
	'checkpoint',
	'progress',
	'job',
	'session',
	'challenger',
	'opponent',
	'teamA',
	'teamB',
	'modelA',
	'modelB',
]);
const excludedIdentifierRoots = new Set([
	'request',
	'response',
	'req',
	'res',
	'controller',
	'timer',
	'timeout',
]);
const riskyThisRoots = new Set([
	'state',
	'requestLedger',
	'sessionByRoom',
	'modelServingKindById',
	'debugLogChain',
]);
const defaultBucketManifestPath = path.join(process.cwd(), 'tools/release-buckets.json');
const clusterCatalog = [
	{
		id: 'bridge/ledger-settlement-state-machine',
		label: 'Bridge Ledger Settlement State Machine',
		match: findingEntry => findingEntry.filePath === 'server/browser-model-bridge.ts' && (
			findingEntry.ruleId === 'release/state-mutation-after-async-boundary' ||
			(findingEntry.line >= 900 && findingEntry.line <= 1152)
		),
	},
	{
		id: 'bridge/replay-cursor-log-cohesion',
		label: 'Bridge Replay Cursor And Log Cohesion',
		match: findingEntry => findingEntry.filePath === 'server/browser-model-bridge.ts' && (
			findingEntry.line <= 175 ||
			findingEntry.message.includes('log_source') ||
			findingEntry.message.includes('log_length') ||
			findingEntry.message.includes('appliedUpdateLines')
		),
	},
	{
		id: 'bridge/canonical-request-identity',
		label: 'Bridge Canonical Request Identity',
		match: findingEntry => findingEntry.filePath === 'server/browser-model-bridge.ts' &&
			findingEntry.line >= 352 && findingEntry.line <= 445,
	},
	{
		id: 'bridge/snapshot-reconstruction-boundary',
		label: 'Bridge Snapshot Reconstruction Boundary',
		match: findingEntry => findingEntry.filePath === 'server/browser-model-bridge.ts' && (
			(findingEntry.line >= 458 && findingEntry.line <= 731) ||
			findingEntry.message.includes('ChoiceRequest') ||
			findingEntry.message.includes('BattleSnapshot') ||
			findingEntry.message.includes('battle_state')
		),
	},
	{
		id: 'bridge/action-contract-normalization',
		label: 'Bridge Action Contract Normalization',
		match: findingEntry => findingEntry.filePath === 'server/browser-model-bridge.ts' && (
			(findingEntry.line >= 177 && findingEntry.line <= 333) ||
			findingEntry.message.includes('legal_switches') ||
			findingEntry.message.includes('legal_revives') ||
			findingEntry.message.includes('request.side.id')
		),
	},
	{
		id: 'typing/raw-request-union-boundary',
		label: 'Typing Raw Request Union Boundary',
		match: findingEntry => findingEntry.filePath === 'sim/tools/protocol-state-tracker.ts' || (
			findingEntry.filePath === 'server/browser-model-bridge.ts' &&
			findingEntry.message.includes('ChoiceRequest')
		),
	},
	{
		id: 'typing/perspective-side-projection',
		label: 'Typing Perspective / Side Projection',
		match: findingEntry => (
			findingEntry.filePath === 'sim/tools/rl-agent.ts' &&
			(findingEntry.message.includes('SideID') || findingEntry.message.includes('RLRequestSide'))
		),
	},
	{
		id: 'typing/duplicate-normalization-frontiers',
		label: 'Typing Duplicate Normalization Frontiers',
		match: findingEntry => (
			(findingEntry.filePath === 'sim/tools/rl-agent.ts' && findingEntry.message.includes('disabled')) ||
			(findingEntry.filePath === 'sim/tools/rl-action-helpers.ts' && findingEntry.message.includes('PokemonSwitchRequestData'))
		),
	},
	{
		id: 'typing/rl-projection-shape-drift',
		label: 'Typing RL Projection Shape Drift',
		match: findingEntry => (
			findingEntry.filePath === 'sim/tools/rl-action-helpers.ts' ||
			findingEntry.filePath === 'sim/tools/rl-model-client.ts' ||
			(findingEntry.filePath === 'sim/tools/rl-agent.ts' && findingEntry.ruleId === 'release/ts-diagnostic')
		),
	},
	{
		id: 'daemon/lineage-training-handoff',
		label: 'Daemon Lineage / Training Handoff',
		match: findingEntry => (
			findingEntry.filePath === 'server/model-league/daemon.ts' &&
			findingEntry.line >= 180 && findingEntry.line <= 250
		),
	},
	{
		id: 'daemon/idempotent-ledgers',
		label: 'Daemon Idempotent Ledgers',
		match: findingEntry => (
			(findingEntry.filePath === 'server/model-league/daemon.ts' && findingEntry.line >= 252 && findingEntry.line <= 266) ||
			findingEntry.filePath === 'server/model-league/storage.ts'
		),
	},
	{
		id: 'daemon/operational-truth',
		label: 'Daemon Operational Truth',
		match: findingEntry => (
			(findingEntry.filePath === 'server/model-league/daemon.ts' && findingEntry.line >= 268 && findingEntry.line <= 384) ||
			findingEntry.filePath === 'server/chat-plugins/model-league.ts'
		),
	},
	{
		id: 'daemon/post-runner-settlement',
		label: 'Daemon Post-Runner Settlement',
		match: findingEntry => (
			findingEntry.filePath === 'sim/tools/model-league-runner.ts' ||
			(findingEntry.filePath === 'server/model-league/daemon.ts' && findingEntry.line >= 451 && findingEntry.line <= 600)
		),
	},
	{
		id: 'daemon/boundary-contracts',
		label: 'Daemon Boundary Contracts',
		match: findingEntry => (
			findingEntry.filePath === 'server/model-league/config.ts' ||
			findingEntry.filePath === 'server/model-league/webhooks.ts'
		),
	},
	{
		id: 'transport/serialization-hygiene',
		label: 'Transport / Serialization Hygiene',
		match: findingEntry => findingEntry.ruleId === 'release/no-object-stringify',
	},
];

const parsePhase = parseCliFlags(process.argv.slice(2));
const branchChangedFiles = parsePhase.scope === 'branch' ? loadChangedFiles(parsePhase.changedFiles) : null;
const bucketOwners = loadBucketOwners(parsePhase.bucketManifestPath || defaultBucketManifestPath);
const discoveryPhase = beginTimedPhase();
const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');

if (!configPath) {
	console.error('release-lint: unable to locate tsconfig.json');
	process.exit(2);
}

const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
if (rawConfig.error) {
	printDiagnostic(rawConfig.error);
	process.exit(2);
}

const parsedConfig = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, path.dirname(configPath));
const scopePredicate = buildScopePredicate(parsePhase.scope, branchChangedFiles);
if (!scopePredicate) {
	console.error(`release-lint: unknown scope "${parsePhase.scope}"`);
	process.exit(2);
}
const discoveryElapsedMs = endTimedPhase(discoveryPhase);

const programPhase = beginTimedPhase();
const releaseProgram = ts.createProgram({
	rootNames: parsedConfig.fileNames,
	options: parsedConfig.options,
	projectReferences: parsedConfig.projectReferences,
});
const releaseChecker = releaseProgram.getTypeChecker();
const programElapsedMs = endTimedPhase(programPhase);

const sourceFrontier = releaseProgram.getSourceFiles()
	.filter(sourceFile => !sourceFile.isDeclarationFile && scopePredicate(sourceFile.fileName));

const diagnosticsPhase = beginTimedPhase();
const scopedDiagnosticMap = new Map();
for (const sourceNode of sourceFrontier) {
	for (const diagnosticEntry of [
		...releaseProgram.getSyntacticDiagnostics(sourceNode),
		...releaseProgram.getSemanticDiagnostics(sourceNode),
		...releaseProgram.getDeclarationDiagnostics(sourceNode),
	]) {
		const diagnosticKey = [
			diagnosticEntry.file?.fileName ?? '',
			diagnosticEntry.start ?? -1,
			diagnosticEntry.length ?? -1,
			diagnosticEntry.code,
			ts.flattenDiagnosticMessageText(diagnosticEntry.messageText, '\n'),
		].join('::');
		scopedDiagnosticMap.set(diagnosticKey, diagnosticEntry);
	}
}
const scopedDiagnostics = [...scopedDiagnosticMap.values()];
const diagnosticsElapsedMs = endTimedPhase(diagnosticsPhase);

const traversalPhase = beginTimedPhase();
const customFindings = [];
let settledNodeCount = 0;
let settledLineCount = 0;

for (const sourceNode of sourceFrontier) {
	settledLineCount += sourceNode.getLineAndCharacterOfPosition(sourceNode.end).line + 1;
	const fileContext = {
		checker: releaseChecker,
		findings: customFindings,
		sourceFile: sourceNode,
	};
	const traverseNode = currentNode => {
		settledNodeCount++;
		inspectPromiseExecutorReturn(fileContext, currentNode);
		inspectAsyncWithoutAwait(fileContext, currentNode);
		inspectTemplateObjectStringify(fileContext, currentNode);
		inspectStateMutationAfterAsyncBoundary(fileContext, currentNode);
		ts.forEachChild(currentNode, traverseNode);
	};
	_jsiiTraverser(sourceNode, traverseNode);
}
const traversalElapsedMs = endTimedPhase(traversalPhase);

const totalPhaseMs = discoveryElapsedMs + programElapsedMs + diagnosticsElapsedMs + traversalElapsedMs;
const heapUsedMb = Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
const diagnosticFindings = scopedDiagnostics.map(diagnosticEntry => convertDiagnosticToFinding(diagnosticEntry));
const combinedFindings = [...diagnosticFindings, ...customFindings]
	.map(annotateFindingCluster)
	.sort(compareFindings);

printSummary({
	discoveryElapsedMs,
	programElapsedMs,
	diagnosticsElapsedMs,
	traversalElapsedMs,
	totalPhaseMs,
	heapUsedMb,
	scope: parsePhase.scope,
	changedFileCount: branchChangedFiles?.length ?? 0,
	fileCount: sourceFrontier.length,
	settledLineCount,
	settledNodeCount,
	findings: combinedFindings,
	limit: parsePhase.limit,
	bucketOwners,
});

if (combinedFindings.length) {
	process.exit(1);
}

function parseCliFlags(argv) {
	let scope = 'release';
	let limit = 40;
	let bucketManifestPath;
	let changedFiles;

	for (let cursorIndex = 0; cursorIndex < argv.length; cursorIndex++) {
		const currentFlag = argv[cursorIndex];
		if (currentFlag === '--scope') {
			scope = argv[cursorIndex + 1] ?? scope;
			cursorIndex++;
			continue;
		}
		if (currentFlag === '--limit') {
			const parsedLimit = Number(argv[cursorIndex + 1]);
			if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
				limit = parsedLimit;
			}
			cursorIndex++;
			continue;
		}
		if (currentFlag === '--bucket-manifest') {
			bucketManifestPath = argv[cursorIndex + 1] ?? bucketManifestPath;
			cursorIndex++;
			continue;
		}
		if (currentFlag === '--changed-files') {
			changedFiles = argv[cursorIndex + 1] ?? changedFiles;
			cursorIndex++;
			continue;
		}
	}

	return {scope, limit, bucketManifestPath, changedFiles};
}

function beginTimedPhase() {
	return performance.now();
}

function endTimedPhase(startedAt) {
	return Math.round((performance.now() - startedAt) * 10) / 10;
}

function normalizePath(filePath) {
	return path.relative(process.cwd(), filePath).replaceAll('\\', '/');
}

function buildScopePredicate(scopeName, branchChangedFiles) {
	if (scopeName === 'branch') {
		const settledChangedFiles = new Set((branchChangedFiles || []).map(normalizePath));
		return filePath => settledChangedFiles.has(normalizePath(filePath));
	}
	return scopeCatalog[scopeName];
}

function loadChangedFiles(explicitChangedFiles) {
	if (explicitChangedFiles) {
		return explicitChangedFiles
			.split(';')
			.map(filePath => filePath.trim())
			.filter(Boolean);
	}
	try {
		const rawStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
			encoding: 'utf8',
		});
		return rawStatus
			.split(/\r?\n/)
			.map(line => line.slice(3).trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function loadBucketOwners(manifestPath) {
	try {
		const rawManifest = readFileSync(manifestPath, 'utf8');
		const parsedManifest = JSON.parse(rawManifest);
		return parsedManifest && typeof parsedManifest === 'object' && !Array.isArray(parsedManifest) ? parsedManifest : {};
	} catch {
		return {};
	}
}

function _jsiiTraverser(rootNode, visitor) {
	visitor(rootNode);
}

function convertDiagnosticToFinding(diagnosticEntry) {
	const sourceFile = diagnosticEntry.file;
	const startPosition = diagnosticEntry.start ?? 0;
	const {line, character} = sourceFile.getLineAndCharacterOfPosition(startPosition);
	return {
		ruleId: 'release/ts-diagnostic',
		message: ts.flattenDiagnosticMessageText(diagnosticEntry.messageText, '\n'),
		filePath: normalizePath(sourceFile.fileName),
		line: line + 1,
		column: character + 1,
		severity: 'error',
	};
}

function compareFindings(leftFinding, rightFinding) {
	return (
		leftFinding.filePath.localeCompare(rightFinding.filePath) ||
		leftFinding.line - rightFinding.line ||
		leftFinding.column - rightFinding.column ||
		leftFinding.ruleId.localeCompare(rightFinding.ruleId)
	);
}

function annotateFindingCluster(findingEntry) {
	const frontierCluster = resolveFindingCluster(findingEntry);
	return {
		...findingEntry,
		clusterId: frontierCluster.id,
		clusterLabel: frontierCluster.label,
	};
}

function resolveFindingCluster(findingEntry) {
	for (const frontierCluster of clusterCatalog) {
		if (frontierCluster.match(findingEntry)) return frontierCluster;
	}
	return {
		id: 'uncategorized',
		label: 'Uncategorized',
	};
}

function inspectPromiseExecutorReturn(fileContext, currentNode) {
	if (!ts.isNewExpression(currentNode)) return;
	if (!ts.isIdentifier(currentNode.expression) || currentNode.expression.text !== 'Promise') return;
	const firstArgument = currentNode.arguments?.[0];
	if (!firstArgument || (!ts.isArrowFunction(firstArgument) && !ts.isFunctionExpression(firstArgument))) return;
	if (!ts.isBlock(firstArgument.body)) return;

	for (const statementNode of firstArgument.body.statements) {
		if (!ts.isReturnStatement(statementNode) || !statementNode.expression) continue;
		pushFinding(fileContext.findings, fileContext.sourceFile, statementNode.expression, {
			ruleId: 'release/no-promise-executor-return',
			message: 'Promise executor returns are ignored. Resolve or reject explicitly instead.',
		});
	}
}

function inspectAsyncWithoutAwait(fileContext, currentNode) {
	if (!hasAsyncModifier(currentNode)) return;
	if (
		!ts.isFunctionDeclaration(currentNode) &&
		!ts.isFunctionExpression(currentNode) &&
		!ts.isArrowFunction(currentNode) &&
		!ts.isMethodDeclaration(currentNode)
	) {
		return;
	}
	if (!currentNode.body || !ts.isBlock(currentNode.body)) return;
	if (blockContainsAwait(currentNode.body)) return;

	const functionName = resolveFunctionName(currentNode);
	pushFinding(fileContext.findings, fileContext.sourceFile, currentNode, {
		ruleId: 'release/no-async-without-await',
		message: `Async ${functionName} has no await. Remove async or add the awaited boundary explicitly.`,
	});
}

function inspectTemplateObjectStringify(fileContext, currentNode) {
	if (!ts.isTemplateSpan(currentNode)) return;
	const expressionType = fileContext.checker.getTypeAtLocation(currentNode.expression);
	if (!isObjectLikeType(expressionType)) return;

	pushFinding(fileContext.findings, fileContext.sourceFile, currentNode.expression, {
		ruleId: 'release/no-object-stringify',
		message: 'Object-like value is interpolated into a template string. Serialize or narrow it first.',
	});
}

function inspectStateMutationAfterAsyncBoundary(fileContext, currentNode) {
	if (!isAsyncFunctionNode(currentNode)) return;
	if (!currentNode.body || !ts.isBlock(currentNode.body)) return;

	const boundaryNodes = collectAwaitBoundaries(currentNode.body);
	if (!boundaryNodes.length) return;

	const firstBoundaryNode = boundaryNodes[0];
	const reportedKeys = new Set();
	const inspectNode = settledNode => {
		if (
			settledNode !== currentNode.body &&
			(ts.isFunctionDeclaration(settledNode) ||
				ts.isFunctionExpression(settledNode) ||
				ts.isArrowFunction(settledNode) ||
				ts.isMethodDeclaration(settledNode))
		) {
			return;
		}

		const writeTarget = resolveMutationTarget(settledNode);
		if (!writeTarget) {
			ts.forEachChild(settledNode, inspectNode);
			return;
		}
		if (writeTarget.getStart(fileContext.sourceFile) <= firstBoundaryNode.getStart(fileContext.sourceFile)) {
			ts.forEachChild(settledNode, inspectNode);
			return;
		}

		const riskyRoot = classifyRiskyMutationRoot(fileContext, writeTarget, firstBoundaryNode);
		if (!riskyRoot) {
			ts.forEachChild(settledNode, inspectNode);
			return;
		}

		const reportKey = `${riskyRoot.rootLabel}:${writeTarget.getStart(fileContext.sourceFile)}`;
		if (!reportedKeys.has(reportKey)) {
			reportedKeys.add(reportKey);
			pushFinding(fileContext.findings, fileContext.sourceFile, writeTarget, {
				ruleId: 'release/state-mutation-after-async-boundary',
				message: `High-confidence state mutation after async boundary on ${riskyRoot.rootLabel}. Re-read, validate, or version-guard before mutating.`,
			});
		}

		ts.forEachChild(settledNode, inspectNode);
	};

	ts.forEachChild(currentNode.body, inspectNode);
}

function hasAsyncModifier(node) {
	return Boolean(node.modifiers?.some(modifierNode => modifierNode.kind === ts.SyntaxKind.AsyncKeyword));
}

function isAsyncFunctionNode(currentNode) {
	return hasAsyncModifier(currentNode) && (
		ts.isFunctionDeclaration(currentNode) ||
		ts.isFunctionExpression(currentNode) ||
		ts.isArrowFunction(currentNode) ||
		ts.isMethodDeclaration(currentNode)
	);
}

function blockContainsAwait(rootBlock) {
	let discoveredAwait = false;
	const inspectNode = currentNode => {
		if (discoveredAwait) return;
		if (
			currentNode !== rootBlock &&
			(ts.isFunctionDeclaration(currentNode) ||
				ts.isFunctionExpression(currentNode) ||
				ts.isArrowFunction(currentNode) ||
				ts.isMethodDeclaration(currentNode))
		) {
			return;
		}
		if (isAsyncBoundaryNode(currentNode)) {
			discoveredAwait = true;
			return;
		}
		ts.forEachChild(currentNode, inspectNode);
	};
	ts.forEachChild(rootBlock, inspectNode);
	return discoveredAwait;
}

function collectAwaitBoundaries(rootBlock) {
	const boundaryNodes = [];
	const inspectNode = currentNode => {
		if (
			currentNode !== rootBlock &&
			(ts.isFunctionDeclaration(currentNode) ||
				ts.isFunctionExpression(currentNode) ||
				ts.isArrowFunction(currentNode) ||
				ts.isMethodDeclaration(currentNode))
		) {
			return;
		}
		if (isAsyncBoundaryNode(currentNode)) {
			boundaryNodes.push(currentNode);
			return;
		}
		ts.forEachChild(currentNode, inspectNode);
	};
	ts.forEachChild(rootBlock, inspectNode);
	return boundaryNodes.sort((leftNode, rightNode) => leftNode.getStart() - rightNode.getStart());
}

function isAsyncBoundaryNode(currentNode) {
	return ts.isAwaitExpression(currentNode) ||
		(ts.isForOfStatement(currentNode) && !!currentNode.awaitModifier);
}

function resolveMutationTarget(currentNode) {
	if (ts.isBinaryExpression(currentNode) && isAssignmentOperator(currentNode.operatorToken.kind)) {
		return extractMemberMutationRoot(currentNode.left);
	}
	if ((ts.isPrefixUnaryExpression(currentNode) || ts.isPostfixUnaryExpression(currentNode)) &&
		(currentNode.operator === ts.SyntaxKind.PlusPlusToken || currentNode.operator === ts.SyntaxKind.MinusMinusToken)) {
		return extractMemberMutationRoot(currentNode.operand);
	}
	return null;
}

function isAssignmentOperator(operatorKind) {
	return operatorKind >= ts.SyntaxKind.FirstAssignment && operatorKind <= ts.SyntaxKind.LastAssignment;
}

function extractMemberMutationRoot(targetNode) {
	if (ts.isPropertyAccessExpression(targetNode) || ts.isElementAccessExpression(targetNode)) {
		return targetNode;
	}
	return null;
}

function classifyRiskyMutationRoot(fileContext, writeTarget, firstBoundaryNode) {
	const rootDescriptor = describeMutationRoot(writeTarget);
	if (!rootDescriptor) return null;
	if (rootDescriptor.kind === 'identifier') {
		if (excludedIdentifierRoots.has(rootDescriptor.rootName)) return null;
		if (!looksLikeSharedIdentifierRoot(fileContext, rootDescriptor, firstBoundaryNode, writeTarget)) return null;
		return {
			rootLabel: rootDescriptor.rootLabel,
		};
	}
	if (rootDescriptor.kind === 'this-property') {
		if (!riskyThisRoots.has(rootDescriptor.rootName)) return null;
		return {
			rootLabel: `this.${rootDescriptor.rootName}`,
		};
	}
	return null;
}

function describeMutationRoot(writeTarget) {
	const pathSegments = collectMutationPathSegments(writeTarget);
	if (!pathSegments.length) return null;
	if (pathSegments[0].kind === 'this' && pathSegments[1]?.kind === 'property') {
		return {
			kind: 'this-property',
			rootName: pathSegments[1].name,
		};
	}
	if (pathSegments[0].kind !== 'identifier') return null;

	const frontierName = pathSegments[0].name;
	const reweightedRoot = pathSegments[1]?.kind === 'property' && riskyNestedRoots.has(pathSegments[1].name) ?
		pathSegments[1].name :
		null;

	return {
		kind: 'identifier',
		rootName: frontierName,
		rootNode: pathSegments[0].node,
		rootLabel: reweightedRoot ? `${frontierName}.${reweightedRoot}` : frontierName,
		nestedRiskName: reweightedRoot,
	};
}

function collectMutationPathSegments(writeTarget) {
	const pathSegments = [];
	let frontierNode = writeTarget;
	while (ts.isPropertyAccessExpression(frontierNode) || ts.isElementAccessExpression(frontierNode)) {
		if (ts.isPropertyAccessExpression(frontierNode)) {
			pathSegments.unshift({
				kind: 'property',
				name: frontierNode.name.text,
			});
		} else if (ts.isStringLiteral(frontierNode.argumentExpression)) {
			pathSegments.unshift({
				kind: 'property',
				name: frontierNode.argumentExpression.text,
			});
		}
		if (frontierNode.expression.kind === ts.SyntaxKind.ThisKeyword) {
			pathSegments.unshift({kind: 'this'});
			return pathSegments;
		}
		if (ts.isIdentifier(frontierNode.expression)) {
			pathSegments.unshift({
				kind: 'identifier',
				name: frontierNode.expression.text,
				node: frontierNode.expression,
			});
			return pathSegments;
		}
		frontierNode = frontierNode.expression;
	}
	return [];
}

function looksLikeSharedIdentifierRoot(fileContext, rootDescriptor, firstBoundaryNode, writeTarget) {
	if (!riskyIdentifierRoots.has(rootDescriptor.rootName) && !rootDescriptor.nestedRiskName) {
		return false;
	}
	const rootType = fileContext.checker.getTypeAtLocation(rootDescriptor.rootNode);
	if (!isObjectLikeType(rootType)) return false;
	return wasRootEstablishedBeforeBoundary(fileContext, rootDescriptor.rootNode, firstBoundaryNode, writeTarget);
}

function wasRootEstablishedBeforeBoundary(fileContext, rootNode, firstBoundaryNode, writeTarget) {
	const rootSymbol = fileContext.checker.getSymbolAtLocation(rootNode);
	const rootDeclaration = rootSymbol?.valueDeclaration ?? rootSymbol?.declarations?.[0];
	if (!rootDeclaration) return false;

	if (ts.isParameter(rootDeclaration)) {
		return rootDeclaration.getStart(fileContext.sourceFile) < firstBoundaryNode.getStart(fileContext.sourceFile);
	}

	if (!ts.isVariableDeclaration(rootDeclaration) || !ts.isIdentifier(rootDeclaration.name)) {
		return false;
	}
	if (rootDeclaration.getStart(fileContext.sourceFile) > firstBoundaryNode.getStart(fileContext.sourceFile)) {
		return false;
	}
	if (!rootDeclaration.initializer) return false;
	if (!isSharedSourceInitializer(rootDeclaration.initializer)) return false;
	if (rootDeclaration.initializer.getStart(fileContext.sourceFile) > writeTarget.getStart(fileContext.sourceFile)) {
		return false;
	}
	return true;
}

function isSharedSourceInitializer(initializerNode) {
	return (
		ts.isCallExpression(initializerNode) ||
		ts.isPropertyAccessExpression(initializerNode) ||
		ts.isElementAccessExpression(initializerNode) ||
		ts.isIdentifier(initializerNode) ||
		ts.isAwaitExpression(initializerNode)
	);
}

function resolveFunctionName(currentNode) {
	if ('name' in currentNode && currentNode.name) {
		if (ts.isIdentifier(currentNode.name)) return `function "${currentNode.name.text}"`;
		if (ts.isStringLiteral(currentNode.name)) return `function "${currentNode.name.text}"`;
	}
	return 'function';
}

function isObjectLikeType(currentType) {
	if (!currentType) return false;
	if (currentType.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike)) {
		return false;
	}
	if (currentType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.VoidLike)) {
		return false;
	}
	if (currentType.flags & ts.TypeFlags.Union) {
		return currentType.types.some(isObjectLikeType);
	}
	return Boolean(
		currentType.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Any | ts.TypeFlags.Unknown)
	);
}

function pushFinding(findings, sourceFile, targetNode, findingSeed) {
	const {line, character} = sourceFile.getLineAndCharacterOfPosition(targetNode.getStart(sourceFile));
	findings.push({
		...findingSeed,
		filePath: normalizePath(sourceFile.fileName),
		line: line + 1,
		column: character + 1,
		severity: 'error',
	});
}

function printSummary(summaryPhase) {
	console.log('Release Stability Lint');
	console.log(`scope: ${summaryPhase.scope}`);
	if (summaryPhase.scope === 'branch') {
		console.log(`changed_files: ${summaryPhase.changedFileCount}`);
	}
	console.log(`files: ${summaryPhase.fileCount}`);
	console.log(`lines: ${summaryPhase.settledLineCount}`);
	console.log(`nodes: ${summaryPhase.settledNodeCount}`);
	console.log(`heap_mb: ${summaryPhase.heapUsedMb}`);
	console.log('timing_ms:');
	console.log(`  discovery: ${summaryPhase.discoveryElapsedMs}`);
	console.log(`  program: ${summaryPhase.programElapsedMs}`);
	console.log(`  diagnostics: ${summaryPhase.diagnosticsElapsedMs}`);
	console.log(`  traversal: ${summaryPhase.traversalElapsedMs}`);
	console.log(`  total: ${summaryPhase.totalPhaseMs}`);

	if (summaryPhase.scope === 'branch') {
		console.log('branch_summary:');
		console.log(`  changed_files: ${summaryPhase.changedFileCount}`);
		console.log(`  scoped_files: ${summaryPhase.fileCount}`);
	}

	if (!summaryPhase.findings.length) {
		console.log('findings: clean');
		return;
	}

	const histogram = new Map();
	const clusterHistogram = new Map();
	for (const findingEntry of summaryPhase.findings) {
		histogram.set(findingEntry.ruleId, (histogram.get(findingEntry.ruleId) ?? 0) + 1);
		const settledCluster = clusterHistogram.get(findingEntry.clusterId) ?? {
			label: findingEntry.clusterLabel,
			count: 0,
			files: new Set(),
		};
		settledCluster.count++;
		settledCluster.files.add(findingEntry.filePath);
		clusterHistogram.set(findingEntry.clusterId, settledCluster);
	}

	console.log('finding_counts:');
	for (const [ruleId, count] of [...histogram.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1])) {
		console.log(`  ${ruleId}: ${count}`);
	}
	console.log('cluster_counts:');
	for (const [clusterId, settledCluster] of [...clusterHistogram.entries()]
		.sort((leftEntry, rightEntry) => rightEntry[1].count - leftEntry[1].count || leftEntry[0].localeCompare(rightEntry[0]))) {
		const ownerEntry = summaryPhase.bucketOwners?.[clusterId];
		const ownerLabel = ownerEntry?.owner ? ` owner=${ownerEntry.owner}` : '';
		console.log(`  ${clusterId}: ${settledCluster.count} (${settledCluster.files.size} files)${ownerLabel}`);
	}

	if (summaryPhase.scope === 'branch') {
		const ownerHistogram = new Map();
		for (const [clusterId, settledCluster] of clusterHistogram.entries()) {
			const owner = summaryPhase.bucketOwners?.[clusterId]?.owner ?? 'unowned';
			ownerHistogram.set(owner, (ownerHistogram.get(owner) ?? 0) + settledCluster.count);
		}

		console.log('owner_counts:');
		for (const [owner, count] of [...ownerHistogram.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1] || leftEntry[0].localeCompare(rightEntry[0]))) {
			console.log(`  ${owner}: ${count}`);
		}

		console.log('top_buckets:');
		for (const [clusterId, settledCluster] of [...clusterHistogram.entries()]
			.sort((leftEntry, rightEntry) => rightEntry[1].count - leftEntry[1].count || leftEntry[0].localeCompare(rightEntry[0]))
			.slice(0, 5)) {
			const ownerEntry = summaryPhase.bucketOwners?.[clusterId];
			const ownerLabel = ownerEntry?.owner ? ` owner=${ownerEntry.owner}` : '';
			const actionLabel = ownerEntry?.nextAction ? ` next=${ownerEntry.nextAction}` : '';
			console.log(`  ${clusterId}: ${settledCluster.count}${ownerLabel}${actionLabel}`);
		}
	}

	console.log(`findings_showing: ${Math.min(summaryPhase.limit, summaryPhase.findings.length)} of ${summaryPhase.findings.length}`);
	for (const findingEntry of summaryPhase.findings.slice(0, summaryPhase.limit)) {
		console.log(
			`${findingEntry.severity} ${findingEntry.ruleId} [${findingEntry.clusterId}] ` +
			`${findingEntry.filePath}:${findingEntry.line}:${findingEntry.column} ${findingEntry.message}`
		);
	}
}

function printDiagnostic(diagnosticEntry) {
	console.error(ts.flattenDiagnosticMessageText(diagnosticEntry.messageText, '\n'));
}
