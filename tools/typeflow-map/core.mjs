import fs from "fs";
import path from "path";
import {execFileSync} from "child_process";
import ts from "typescript";

function walkUpForFile(seedPath, targetName) {
	let cursorPath = path.resolve(seedPath);
	while (true) {
		const probePath = path.join(cursorPath, targetName);
		if (fs.existsSync(probePath)) return probePath;
		const parentPath = path.dirname(cursorPath);
		if (parentPath === cursorPath) return null;
		cursorPath = parentPath;
	}
}

export function resolveRepoRoot(seedPath = process.cwd()) {
	const tsconfigPath = walkUpForFile(seedPath, "tsconfig.json");
	if (tsconfigPath) return path.dirname(tsconfigPath);
	const packagePath = walkUpForFile(seedPath, "package.json");
	if (packagePath) return path.dirname(packagePath);
	return path.resolve(seedPath);
}

export function loadProgram(repoRoot, explicitTsconfigPath) {
	const tsconfigPath = explicitTsconfigPath || ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json from ${repoRoot}`);
	}
	const configSource = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configSource.error) {
		throw new Error(ts.flattenDiagnosticMessageText(configSource.error.messageText, "\n"));
	}
	const configParse = ts.parseJsonConfigFileContent(configSource.config, ts.sys, path.dirname(tsconfigPath));
	if (configParse.errors.length) {
		throw new Error(configParse.errors.map(issue => ts.flattenDiagnosticMessageText(issue.messageText, "\n")).join("\n"));
	}
	const program = ts.createProgram({
		rootNames: configParse.fileNames,
		options: configParse.options,
		projectReferences: configParse.projectReferences,
	});
	const checker = program.getTypeChecker();
	const repoSourceFiles = program.getSourceFiles().filter(sourceFile => {
		if (sourceFile.isDeclarationFile) return false;
		const normalizedPath = path.resolve(sourceFile.fileName);
		return normalizedPath.startsWith(path.resolve(repoRoot));
	});
	return {program, checker, repoSourceFiles, repoRoot, tsconfigPath, namedTypeCache: new Map()};
}

function normalizeDisplay(text) {
	return text.replace(/\s+/g, " ").trim();
}

function collectTypeDisplayNames(checker, subjectType, frontier = new Set(), settled = new Set()) {
	if (!subjectType || settled.has(subjectType)) return frontier;
	settled.add(subjectType);
	const displayName = normalizeDisplay(checker.typeToString(subjectType));
	if (displayName) frontier.add(displayName);
	const aliasDisplayName = normalizeDisplay(
		checker.typeToString(subjectType, undefined, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.NoTruncation)
	);
	if (aliasDisplayName) frontier.add(aliasDisplayName);
	const aliasName = subjectType.aliasSymbol?.escapedName;
	if (aliasName) frontier.add(String(aliasName));
	const symbolName = subjectType.symbol?.escapedName;
	if (symbolName) frontier.add(String(symbolName));
	if (subjectType.isUnionOrIntersection && subjectType.isUnionOrIntersection()) {
		for (const branchType of subjectType.types) {
			collectTypeDisplayNames(checker, branchType, frontier, settled);
		}
	}
	return frontier;
}

function getNamedType(programState, queryText) {
	if (!queryText) return undefined;
	if (programState.namedTypeCache.has(queryText)) {
		return programState.namedTypeCache.get(queryText);
	}
	const {checker, repoSourceFiles} = programState;
	let resolvedType;
	for (const sourceFile of repoSourceFiles) {
		const frontier = node => {
			if (resolvedType) return;
			if (
				(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) &&
				node.name?.text === queryText
			) {
				resolvedType = checker.getTypeAtLocation(node.name);
				return;
			}
			ts.forEachChild(node, frontier);
		};
		frontier(sourceFile);
		if (resolvedType) break;
	}
	programState.namedTypeCache.set(queryText, resolvedType);
	return resolvedType;
}

function typeMatchesQuery(programState, subjectType, queryText) {
	if (!subjectType || !queryText) return false;
	const {checker} = programState;
	const resolvedType = getNamedType(programState, queryText);
	const frontierFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
	if (resolvedType) {
		if (subjectType.flags & frontierFlags) return false;
		try {
			if (checker.isTypeAssignableTo(subjectType, resolvedType) && checker.isTypeAssignableTo(resolvedType, subjectType)) {
				return true;
			}
		} catch {}
	}
	const queryNeedle = normalizeDisplay(queryText);
	for (const displayName of collectTypeDisplayNames(checker, subjectType)) {
		if (displayName === queryNeedle) return true;
		if (displayName.includes(queryNeedle)) return true;
	}
	return false;
}

function locationInfo(sourceFile, node, repoRoot) {
	const frontier = sourceFile.getLineAndCharacterOfPosition(node.getStart());
	return {
		file: path.relative(repoRoot, sourceFile.fileName).replace(/\\/g, "/"),
		line: frontier.line + 1,
		column: frontier.character + 1,
	};
}

function snippetForNode(node) {
	return normalizeDisplay(node.getText()).slice(0, 220);
}

function getFunctionSymbol(checker, node) {
	if (node.name && ts.isIdentifier(node.name)) {
		const settled = checker.getSymbolAtLocation(node.name);
		return settled && ts.SymbolFlags.Alias & settled.flags ? checker.getAliasedSymbol(settled) : settled;
	}
	if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
		const parentNode = node.parent;
		if (ts.isVariableDeclaration(parentNode) && ts.isIdentifier(parentNode.name)) {
			return checker.getSymbolAtLocation(parentNode.name);
		}
		if (ts.isPropertyAssignment(parentNode) && ts.isIdentifier(parentNode.name)) {
			return checker.getSymbolAtLocation(parentNode.name);
		}
	}
	return undefined;
}

function functionLabel(checker, node) {
	if (node.name && ts.isIdentifier(node.name)) return node.name.text;
	if (ts.isMethodDeclaration(node) && node.name) return node.name.getText();
	if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
		const parentNode = node.parent;
		if (ts.isVariableDeclaration(parentNode) && ts.isIdentifier(parentNode.name)) return parentNode.name.text;
		if (ts.isPropertyAssignment(parentNode) && parentNode.name) return parentNode.name.getText();
	}
	const symbol = getFunctionSymbol(checker, node);
	return symbol?.getName() || "<anonymous>";
}

function getEnclosingFunction(checker, node) {
	let cursorNode = node.parent;
	while (cursorNode) {
		if (
			ts.isFunctionDeclaration(cursorNode) ||
			ts.isMethodDeclaration(cursorNode) ||
			ts.isFunctionExpression(cursorNode) ||
			ts.isArrowFunction(cursorNode)
		) {
			return cursorNode;
		}
		cursorNode = cursorNode.parent;
	}
	return undefined;
}

function declaredTypeForReference(checker, referenceNode) {
	if (!ts.isIdentifier(referenceNode)) return undefined;
	const symbol = checker.getSymbolAtLocation(referenceNode);
	const declarationNode = symbol?.valueDeclaration || symbol?.declarations?.[0];
	if (!symbol || !declarationNode) return undefined;
	try {
		return checker.getTypeOfSymbolAtLocation(symbol, declarationNode);
	} catch {
		return undefined;
	}
}

function isFunctionLikeNode(node) {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node)
	);
}

export function buildFunctionIndex(programState) {
	const {checker, repoSourceFiles, repoRoot} = programState;
	const functionRecords = [];
	const functionBySymbol = new Map();
	const functionByNode = new Map();

	for (const sourceFile of repoSourceFiles) {
		const frontier = node => {
			if (isFunctionLikeNode(node)) {
				const symbol = getFunctionSymbol(checker, node);
				const record = {
					node,
					symbol,
					name: functionLabel(checker, node),
					location: locationInfo(sourceFile, node, repoRoot),
					returnType: normalizeDisplay(
						checker.typeToString(
							checker.getSignatureFromDeclaration(node)?.getReturnType() || checker.getTypeAtLocation(node)
						)
					),
					paramTypes: node.parameters.map(parameter => ({
						name: parameter.name.getText(),
						type: normalizeDisplay(checker.typeToString(checker.getTypeAtLocation(parameter))),
						annotation: parameter.type ? normalizeDisplay(parameter.type.getText()) : "",
					})),
					callers: new Map(),
					callees: new Map(),
				};
				functionRecords.push(record);
				functionByNode.set(node, record);
				if (symbol) functionBySymbol.set(symbol, record);
			}
			ts.forEachChild(node, frontier);
		};
		frontier(sourceFile);
	}

	for (const sourceFile of repoSourceFiles) {
		const frontier = node => {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const callerNode = getEnclosingFunction(checker, node);
				const callerRecord = callerNode ? functionByNode.get(callerNode) : undefined;
				if (callerRecord) {
					const callTarget = checker.getResolvedSignature(node)?.declaration;
					if (callTarget) {
						const targetSymbol = getFunctionSymbol(checker, callTarget);
						const targetRecord = targetSymbol ? functionBySymbol.get(targetSymbol) : undefined;
						if (targetRecord) {
							const callSite = locationInfo(sourceFile, node, repoRoot);
							callerRecord.callees.set(targetRecord.name + "@" + callSite.file + ":" + callSite.line, {
								name: targetRecord.name,
								location: targetRecord.location,
								callSite,
							});
							targetRecord.callers.set(callerRecord.name + "@" + callSite.file + ":" + callSite.line, {
								name: callerRecord.name,
								location: callerRecord.location,
								callSite,
							});
						}
					}
				}
			}
			ts.forEachChild(node, frontier);
		};
		frontier(sourceFile);
	}

	return functionRecords.map(record => ({
		...record,
		callers: [...record.callers.values()],
		callees: [...record.callees.values()],
	}));
}

export function queryUnionFieldAccess(programState, query) {
	const {checker, repoSourceFiles, repoRoot} = programState;
	const findings = [];

	for (const sourceFile of repoSourceFiles) {
		const frontier = node => {
			const isPropertyNode = ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain?.(node);
			if (isPropertyNode && node.name?.text === query.field) {
				const baseType = checker.getTypeAtLocation(node.expression);
				const declaredType = declaredTypeForReference(checker, node.expression);
				if (
					typeMatchesQuery(programState, baseType, query.type) ||
					typeMatchesQuery(programState, declaredType, query.type)
				) {
					const enclosingNode = getEnclosingFunction(checker, node);
					findings.push({
						kind: "field-access",
						...locationInfo(sourceFile, node, repoRoot),
						functionName: enclosingNode ? functionLabel(checker, enclosingNode) : "<top-level>",
						accessText: snippetForNode(node),
						baseText: snippetForNode(node.expression),
						baseType: normalizeDisplay(checker.typeToString(baseType)),
						declaredType: declaredType ? normalizeDisplay(checker.typeToString(declaredType)) : undefined,
					});
				}
			}
			ts.forEachChild(node, frontier);
		};
		frontier(sourceFile);
	}

	return findings;
}

function pushNarrowingFinding(findings, sourceFile, node, repoRoot, checker, extra) {
	const enclosingNode = getEnclosingFunction(checker, node);
	findings.push({
		...locationInfo(sourceFile, node, repoRoot),
		functionName: enclosingNode ? functionLabel(checker, enclosingNode) : "<top-level>",
		snippet: snippetForNode(node),
		...extra,
	});
}

export function queryNarrowingSites(programState, query) {
	const {checker, repoSourceFiles, repoRoot} = programState;
	const findings = [];

	for (const sourceFile of repoSourceFiles) {
		const frontier = node => {
			if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
				const sourceType = checker.getTypeAtLocation(node.expression);
				const targetType = checker.getTypeFromTypeNode(node.type);
				if (typeMatchesQuery(programState, sourceType, query.from) && typeMatchesQuery(programState, targetType, query.to)) {
					pushNarrowingFinding(findings, sourceFile, node, repoRoot, checker, {
						kind: "assertion",
						sourceType: normalizeDisplay(checker.typeToString(sourceType)),
						targetType: normalizeDisplay(checker.typeToString(targetType)),
						assignable: checker.isTypeAssignableTo(sourceType, targetType),
					});
				}
			}

			if (ts.isVariableDeclaration(node) && node.initializer && node.type) {
				const sourceType = checker.getTypeAtLocation(node.initializer);
				const targetType = checker.getTypeFromTypeNode(node.type);
				if (typeMatchesQuery(programState, sourceType, query.from) && typeMatchesQuery(programState, targetType, query.to)) {
					pushNarrowingFinding(findings, sourceFile, node, repoRoot, checker, {
						kind: "typed-variable",
						sourceType: normalizeDisplay(checker.typeToString(sourceType)),
						targetType: normalizeDisplay(checker.typeToString(targetType)),
						assignable: checker.isTypeAssignableTo(sourceType, targetType),
					});
				}
			}

			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const sourceType = checker.getTypeAtLocation(node.right);
				const targetType = checker.getTypeAtLocation(node.left);
				if (typeMatchesQuery(programState, sourceType, query.from) && typeMatchesQuery(programState, targetType, query.to)) {
					pushNarrowingFinding(findings, sourceFile, node, repoRoot, checker, {
						kind: "assignment",
						sourceType: normalizeDisplay(checker.typeToString(sourceType)),
						targetType: normalizeDisplay(checker.typeToString(targetType)),
						assignable: checker.isTypeAssignableTo(sourceType, targetType),
					});
				}
			}

			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const signature = checker.getResolvedSignature(node);
				if (signature) {
					const parameterList = signature.getParameters();
					const argList = node.arguments || [];
					for (let idx = 0; idx < argList.length; idx++) {
						const argNode = argList[idx];
						const paramSymbol = parameterList[Math.min(idx, parameterList.length - 1)];
						if (!argNode || !paramSymbol) continue;
						const sourceType = checker.getTypeAtLocation(argNode);
						const declarationNode = paramSymbol.valueDeclaration || paramSymbol.declarations?.[0];
						if (!declarationNode) continue;
						const targetType = checker.getTypeOfSymbolAtLocation(paramSymbol, declarationNode);
						if (typeMatchesQuery(programState, sourceType, query.from) && typeMatchesQuery(programState, targetType, query.to)) {
							pushNarrowingFinding(findings, sourceFile, node, repoRoot, checker, {
								kind: "call-arg",
								sourceType: normalizeDisplay(checker.typeToString(sourceType)),
								targetType: normalizeDisplay(checker.typeToString(targetType)),
								assignable: checker.isTypeAssignableTo(sourceType, targetType),
								parameterName: paramSymbol.getName(),
							});
						}
					}
				}
			}

			ts.forEachChild(node, frontier);
		};
		frontier(sourceFile);
	}

	return findings;
}

export function querySeams(programState, query) {
	const functionIndex = buildFunctionIndex(programState);
	return functionIndex
		.filter(record => {
			const fromHit = !query.from || record.paramTypes.some(parameter =>
				parameter.type.includes(query.from) || parameter.annotation.includes(query.from)
			);
			const toHit = !query.to || record.returnType.includes(query.to);
			return fromHit && toHit;
		})
		.map(record => ({
			name: record.name,
			...record.location,
			returnType: record.returnType,
			paramTypes: record.paramTypes,
			callers: record.callers,
			callees: record.callees,
		}));
}

function branchName(repoRoot) {
	try {
		const gitPath = path.join(repoRoot, ".git");
		let headPath = path.join(gitPath, "HEAD");
		if (fs.existsSync(gitPath) && fs.statSync(gitPath).isFile()) {
			const pointerText = fs.readFileSync(gitPath, "utf8").trim();
			const pointerMatch = pointerText.match(/^gitdir:\s*(.+)$/i);
			if (pointerMatch) {
				headPath = path.join(path.resolve(repoRoot, pointerMatch[1]), "HEAD");
			}
		}
		const headText = fs.readFileSync(headPath, "utf8").trim();
		const headMatch = headText.match(/^ref:\s+refs\/heads\/(.+)$/);
		if (headMatch) return headMatch[1];
		if (headText) return "detached";
	} catch {}
	for (const binaryName of ["git", "git.exe"]) {
		try {
			return execFileSync(binaryName, ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {encoding: "utf8"}).trim() || "detached";
		} catch {}
	}
	return "unknown-branch";
}

function sanitizeFragment(text) {
	return String(text).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "query";
}

export function saveArtifact(programState, commandName, query, payload) {
	const repoRoot = programState.repoRoot;
	const laneName = sanitizeFragment(branchName(repoRoot));
	const artifactRoot = path.join(repoRoot, "tools", "typeflow-map", "artifacts", laneName);
	fs.mkdirSync(artifactRoot, {recursive: true});
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const queryLabel = Object.entries(query)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}-${sanitizeFragment(value)}`)
		.join("__");
	const artifactPath = path.join(artifactRoot, `${stamp}__${sanitizeFragment(commandName)}__${queryLabel}.json`);
	const artifactBody = {
		savedAt: new Date().toISOString(),
		command: commandName,
		query,
		resultCount: Array.isArray(payload) ? payload.length : undefined,
		payload,
	};
	fs.writeFileSync(artifactPath, JSON.stringify(artifactBody, null, 2));
	return path.relative(repoRoot, artifactPath).replace(/\\/g, "/");
}

export function renderText(commandName, query, payload) {
	const headerBits = Object.entries(query)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}=${value}`);
	const lines = [`${commandName} ${headerBits.join(" ")}`];
	if (!Array.isArray(payload) || !payload.length) {
		lines.push("count=0");
		return lines.join("\n");
	}
	lines.push(`count=${payload.length}`);
	for (const entry of payload) {
		const head = `${entry.file}:${entry.line}:${entry.column} ${entry.functionName || entry.name || "<unknown>"}`;
		lines.push(`- ${head}`);
		if (entry.kind) lines.push(`  kind=${entry.kind}`);
		if (entry.baseType) lines.push(`  baseType=${entry.baseType}`);
		if (entry.declaredType) lines.push(`  declaredType=${entry.declaredType}`);
		if (entry.sourceType || entry.targetType) {
			lines.push(`  flow=${entry.sourceType || "?"} -> ${entry.targetType || "?"} assignable=${entry.assignable}`);
		}
		if (entry.paramTypes) {
			lines.push(`  params=${entry.paramTypes.map(parameter => `${parameter.name}:${parameter.type}${parameter.annotation ? ` [${parameter.annotation}]` : ""}`).join(", ")}`);
		}
		if (entry.returnType) lines.push(`  return=${entry.returnType}`);
		if (entry.callers?.length) {
			lines.push(`  callers=${entry.callers.map(caller => `${caller.name}@${caller.callSite.file}:${caller.callSite.line}`).join("; ")}`);
		}
		if (entry.accessText) lines.push(`  access=${entry.accessText}`);
		if (entry.snippet) lines.push(`  snippet=${entry.snippet}`);
	}
	return lines.join("\n");
}
