import path from "path";
import process from "process";
import ts from "typescript";

const MUTATING_METHODS = new Set([
	"copyWithin",
	"fill",
	"pop",
	"push",
	"reverse",
	"shift",
	"sort",
	"splice",
	"unshift",
]);

function parseArgs(argv) {
	const options = {
		repoRoot: process.cwd(),
		typesFiles: [],
		targetFiles: [],
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--repo-root") {
			options.repoRoot = path.resolve(argv[++i]);
			continue;
		}
		if (token === "--types") {
			options.typesFiles.push(argv[++i]);
			continue;
		}
		if (token === "--file") {
			options.targetFiles.push(argv[++i]);
			continue;
		}
		if (token === "--json") {
			options.json = true;
			continue;
		}
		if (token === "--help" || token === "-h") {
			options.help = true;
			continue;
		}
		throw new Error(`Unknown argument: ${token}`);
	}
	return options;
}

function printUsage() {
	console.log([
		"Usage:",
		"  node tools/stategraph/index.mjs --types server/model-league/types.ts --file server/model-league/daemon.ts",
		"",
		"Options:",
		"  --repo-root <path>   Override repository root",
		"  --types <path>       Add a TypeScript type file used for durable root extraction",
		"  --file <path>        Add a TypeScript source file for post-await mutation analysis",
		"  --json               Emit JSON instead of the compact text report",
	].join("\n"));
}

function resolveInputPath(repoRoot, inputPath) {
	return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(repoRoot, inputPath);
}

function toRepoPath(repoRoot, filePath) {
	return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function isFunctionLike(node) {
	return ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node);
}

function getNodeLine(sourceFile, node) {
	return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

function isDurableInterfaceName(name) {
	return /(State|Job|Progress)$/.test(name);
}

function classifyDurability(name) {
	if (/WebhookState|DaemonState/.test(name)) return "operational";
	return "persistent";
}

function getPropertyNameText(nameNode) {
	if (!nameNode) return null;
	if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
		return nameNode.text;
	}
	return null;
}

function findInterfaceDeclarations(sourceFile) {
	const interfaces = new Map();
	for (const statement of sourceFile.statements) {
		if (ts.isInterfaceDeclaration(statement)) {
			interfaces.set(statement.name.text, statement);
		}
	}
	return interfaces;
}

function describeTypeNode(typeNode) {
	if (!typeNode) return {kind: "scalar", refName: null, childTypeNode: null};
	if (ts.isArrayTypeNode(typeNode)) {
		return {kind: "array", refName: null, childTypeNode: typeNode.elementType};
	}
	if (ts.isTypeReferenceNode(typeNode)) {
		const refName = ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : typeNode.typeName.getText();
		return {kind: "object", refName, childTypeNode: null};
	}
	if (ts.isTypeLiteralNode(typeNode)) {
		return {kind: "object", refName: null, childTypeNode: typeNode};
	}
	if (ts.isUnionTypeNode(typeNode)) {
		for (const member of typeNode.types) {
			if (member.kind === ts.SyntaxKind.NullKeyword || member.kind === ts.SyntaxKind.UndefinedKeyword) continue;
			return describeTypeNode(member);
		}
	}
	return {kind: "scalar", refName: null, childTypeNode: null};
}

function collectFieldsFromMembers(members, prefix, interfaces, seen, output) {
	for (const member of members) {
		if (!ts.isPropertySignature(member)) continue;
		const fieldName = getPropertyNameText(member.name);
		if (!fieldName) continue;
		const fieldPath = prefix ? `${prefix}.${fieldName}` : fieldName;
		const descriptor = describeTypeNode(member.type);
		output.push({path: fieldPath, kind: descriptor.kind});
		if (descriptor.kind === "object" && descriptor.refName && interfaces.has(descriptor.refName) && !seen.has(descriptor.refName)) {
			seen.add(descriptor.refName);
			collectFieldsFromMembers(interfaces.get(descriptor.refName).members, fieldPath, interfaces, seen, output);
			seen.delete(descriptor.refName);
		} else if (descriptor.childTypeNode && ts.isTypeLiteralNode(descriptor.childTypeNode)) {
			collectFieldsFromMembers(descriptor.childTypeNode.members, fieldPath, interfaces, seen, output);
		} else if (descriptor.kind === "array" && descriptor.childTypeNode) {
			const nested = describeTypeNode(descriptor.childTypeNode);
			if (nested.refName && interfaces.has(nested.refName) && !seen.has(nested.refName)) {
				seen.add(nested.refName);
				collectFieldsFromMembers(interfaces.get(nested.refName).members, `${fieldPath}[]`, interfaces, seen, output);
				seen.delete(nested.refName);
			}
		}
	}
}

function extractDurableRoots(sourceFile, repoRoot) {
	const interfaces = findInterfaceDeclarations(sourceFile);
	const roots = [];
	for (const [name, declaration] of interfaces.entries()) {
		if (!isDurableInterfaceName(name)) continue;
		const fields = [];
		collectFieldsFromMembers(declaration.members, "", interfaces, new Set([name]), fields);
		roots.push({
			rootId: name,
			typeName: name,
			file: toRepoPath(repoRoot, sourceFile.fileName),
			line: getNodeLine(sourceFile, declaration),
			durability: classifyDurability(name),
			fieldCount: fields.length,
			fields,
		});
	}
	return roots;
}

function createProgram(repoRoot) {
	const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
	if (!configPath) {
		throw new Error(`Could not find tsconfig.json from ${repoRoot}`);
	}
	const configText = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configText.error) {
		throw new Error(ts.flattenDiagnosticMessageText(configText.error.messageText, "\n"));
	}
	const parsed = ts.parseJsonConfigFileContent(configText.config, ts.sys, path.dirname(configPath));
	return ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
	});
}

function collectFunctionChildren(rootNode, visitor) {
	function walk(node) {
		if (node !== rootNode && isFunctionLike(node)) return;
		visitor(node);
		ts.forEachChild(node, walk);
	}
	walk(rootNode);
}

function summarizeAwaitExpression(awaitNode) {
	const expression = awaitNode.expression;
	if (ts.isCallExpression(expression)) {
		return expression.expression.getText().slice(0, 60);
	}
	return expression.getText().slice(0, 60);
}

function isSecondaryBoundary(summary) {
	return summary.startsWith("FS(");
}

function findAwaitBoundaries(fnNode, sourceFile) {
	const boundaries = [];
	collectFunctionChildren(fnNode.body, node => {
		if (!ts.isAwaitExpression(node)) return;
		boundaries.push({
			node,
			line: getNodeLine(sourceFile, node),
			summary: summarizeAwaitExpression(node),
			pos: node.getStart(sourceFile),
		});
	});
	boundaries.sort((left, right) => left.pos - right.pos);
	return boundaries;
}

function isAssignmentOperator(kind) {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function getMutationTarget(node) {
	if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
		return {op: "assign", target: node.left};
	}
	if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
		(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
		return {op: "increment", target: node.operand};
	}
	if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
		const methodName = node.expression.name.text;
		if (MUTATING_METHODS.has(methodName)) {
			return {op: methodName, target: node.expression.expression};
		}
	}
	return null;
}

function collectMutations(fnNode, sourceFile) {
	const mutations = [];
	collectFunctionChildren(fnNode.body, node => {
		const mutation = getMutationTarget(node);
		if (!mutation) return;
		mutations.push({
			op: mutation.op,
			target: mutation.target,
			line: getNodeLine(sourceFile, node),
			pos: node.getStart(sourceFile),
			text: mutation.target.getText(sourceFile),
		});
	});
	mutations.sort((left, right) => left.pos - right.pos);
	return mutations;
}

function getTypeNamesFromType(type) {
	if (!type) return [];
	if (type.isUnion()) {
		const aggregate = new Set();
		for (const member of type.types) {
			for (const name of getTypeNamesFromType(member)) aggregate.add(name);
		}
		return [...aggregate];
	}
	const names = new Set();
	if (type.aliasSymbol?.escapedName) names.add(String(type.aliasSymbol.escapedName));
	if (type.symbol?.escapedName) names.add(String(type.symbol.escapedName));
	const aliasSymbol = type.getAliasSymbol?.();
	if (aliasSymbol?.escapedName) names.add(String(aliasSymbol.escapedName));
	return [...names];
}

function buildChainCandidates(expression) {
	const chain = [];
	let cursor = expression;
	while (cursor) {
		chain.push(cursor);
		if (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
			cursor = cursor.expression;
			continue;
		}
		break;
	}
	return chain;
}

function describeRootForTarget(checker, target, rootNames, sourceFile) {
	const chain = buildChainCandidates(target);
	for (const candidate of chain) {
		const type = checker.getTypeAtLocation(candidate);
		const typeNames = getTypeNamesFromType(type);
		const matched = typeNames.find(typeName => rootNames.has(typeName));
		if (!matched) continue;
		return {
			rootId: matched,
			rootType: matched,
			rootAccess: candidate.getText(sourceFile),
		};
	}
	const text = target.getText(sourceFile);
	if (text.startsWith("this.state")) {
		return {
			rootId: "ModelLeagueState",
			rootType: "ModelLeagueState",
			rootAccess: "this.state",
		};
	}
	return {
		rootId: "unknown",
		rootType: "unknown",
		rootAccess: chain[chain.length - 1]?.getText(sourceFile) || text,
	};
}

function computeFieldPath(targetText, rootAccess) {
	if (targetText === rootAccess) return "(self)";
	if (targetText.startsWith(`${rootAccess}.`)) return targetText.slice(rootAccess.length + 1);
	if (targetText.startsWith(`${rootAccess}[`)) return targetText.slice(rootAccess.length);
	return targetText;
}

function findDeclarationBeforeBoundary(checker, target, boundaryPos) {
	const symbol = checker.getSymbolAtLocation(target);
	if (!symbol?.valueDeclaration) return "unknown";
	return symbol.valueDeclaration.pos < boundaryPos ? "captured-pre-await" : "local-post-await";
}

function getFunctionName(fnNode) {
	if (fnNode.name && ts.isIdentifier(fnNode.name)) return fnNode.name.text;
	if (ts.isMethodDeclaration(fnNode) && ts.isIdentifier(fnNode.name)) return fnNode.name.text;
	if (ts.isVariableDeclaration(fnNode.parent) && ts.isIdentifier(fnNode.parent.name)) return fnNode.parent.name.text;
	return "<anonymous>";
}

function analyzeFile(program, filePath, roots, repoRoot) {
	const checker = program.getTypeChecker();
	const sourceFile = program.getSourceFile(filePath);
	if (!sourceFile) throw new Error(`Source file not found in program: ${filePath}`);
	const rootNames = new Set(roots.map(root => root.typeName));
	const settlements = [];

	function visit(node) {
		if (!isFunctionLike(node) || !node.body) {
			ts.forEachChild(node, visit);
			return;
		}
		const boundaries = findAwaitBoundaries(node, sourceFile);
		const mutations = collectMutations(node, sourceFile);
		if (!boundaries.length || !mutations.length) {
			return;
		}
		const fnName = getFunctionName(node);
		const blockMap = new Map();
		for (const mutation of mutations) {
			const preceding = boundaries.filter(entry => entry.pos < mutation.pos);
			const boundary = [...preceding].reverse().find(entry => !isSecondaryBoundary(entry.summary)) ||
				preceding[preceding.length - 1];
			if (!boundary) continue;
			const rootDescriptor = describeRootForTarget(checker, mutation.target, rootNames, sourceFile);
			if (rootDescriptor.rootId === "unknown") continue;
			const fieldPath = computeFieldPath(mutation.text, rootDescriptor.rootAccess);
			const sourceKind = rootDescriptor.rootAccess.startsWith("this.state") ?
				"direct-state-access" :
				findDeclarationBeforeBoundary(checker, mutation.target, boundary.pos);
			const blockId = `${fnName}:await@${boundary.line}:${boundary.summary}`;
			if (!blockMap.has(blockId)) {
				blockMap.set(blockId, {
					blockId,
					file: toRepoPath(repoRoot, filePath),
					functionName: fnName,
					startLine: boundary.line,
					trigger: boundary.summary,
					roots: new Map(),
				});
			}
			const block = blockMap.get(blockId);
			if (!block.roots.has(rootDescriptor.rootId)) {
				block.roots.set(rootDescriptor.rootId, {
					rootId: rootDescriptor.rootId,
					rootType: rootDescriptor.rootType,
					accesses: new Set(),
					fields: new Map(),
					sourceKinds: new Set(),
				});
			}
			const rootGroup = block.roots.get(rootDescriptor.rootId);
			rootGroup.accesses.add(rootDescriptor.rootAccess);
			rootGroup.sourceKinds.add(sourceKind);
			if (!rootGroup.fields.has(fieldPath)) {
				rootGroup.fields.set(fieldPath, {ops: new Set(), count: 0});
			}
			const fieldGroup = rootGroup.fields.get(fieldPath);
			fieldGroup.ops.add(mutation.op);
			fieldGroup.count++;
		}
		for (const block of blockMap.values()) {
			const rootsOut = [];
			for (const root of block.roots.values()) {
				const fieldsOut = [];
				for (const [fieldPath, entry] of root.fields.entries()) {
					fieldsOut.push({
						fieldPath,
						count: entry.count,
						ops: [...entry.ops].sort(),
					});
				}
				fieldsOut.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));
				rootsOut.push({
					rootId: root.rootId,
					rootType: root.rootType,
					accesses: [...root.accesses].sort(),
					sourceKinds: [...root.sourceKinds].sort(),
					fields: fieldsOut,
				});
			}
			rootsOut.sort((left, right) => left.rootId.localeCompare(right.rootId));
			settlements.push({
				blockId: block.blockId,
				file: block.file,
				functionName: block.functionName,
				startLine: block.startLine,
				trigger: block.trigger,
				roots: rootsOut,
			});
		}
	}

	visit(sourceFile);
	settlements.sort((left, right) => left.startLine - right.startLine);
	return {
		file: toRepoPath(repoRoot, filePath),
		settlements,
	};
}

function renderText(report) {
	const lines = [];
	lines.push("stategraph report");
	lines.push("");
	lines.push("durable roots:");
	for (const root of report.roots) {
		lines.push(`- ${root.typeName} [${root.durability}] fields=${root.fieldCount} (${root.file}:${root.line})`);
	}
	for (const fileReport of report.files) {
		lines.push("");
		lines.push(`file: ${fileReport.file}`);
		if (!fileReport.settlements.length) {
			lines.push("  no post-await mutations found");
			continue;
		}
		for (const block of fileReport.settlements) {
			lines.push(`  settlement: ${block.functionName} @${block.startLine} after ${block.trigger}`);
			for (const root of block.roots) {
				lines.push(`    root: ${root.rootId} via ${root.accesses.join(", ")}`);
				for (const field of root.fields) {
					lines.push(`      - ${field.fieldPath} [${field.ops.join(",")}] x${field.count}`);
				}
			}
		}
	}
	return lines.join("\n");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}
	if (!options.typesFiles.length) {
		options.typesFiles.push("server/model-league/types.ts");
	}
	if (!options.targetFiles.length) {
		throw new Error("At least one --file target is required.");
	}
	const repoRoot = path.resolve(options.repoRoot);
	const program = createProgram(repoRoot);
	const rootMap = new Map();
	for (const inputPath of options.typesFiles) {
		const resolved = resolveInputPath(repoRoot, inputPath);
		const sourceFile = program.getSourceFile(resolved);
		if (!sourceFile) throw new Error(`Type file not found in program: ${resolved}`);
		for (const root of extractDurableRoots(sourceFile, repoRoot)) {
			rootMap.set(root.typeName, root);
		}
	}
	const roots = [...rootMap.values()].sort((left, right) => left.typeName.localeCompare(right.typeName));
	const files = options.targetFiles.map(targetPath =>
		analyzeFile(program, resolveInputPath(repoRoot, targetPath), roots, repoRoot)
	);
	const report = {repoRoot, roots, files};
	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(renderText(report));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
