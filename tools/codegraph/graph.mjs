import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

function normalizePath(rootDir, filePath) {
	return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function isTsSourceFile(sourceFile, rootDir) {
	if (sourceFile.isDeclarationFile) return false;
	const normalizedPath = normalizePath(rootDir, sourceFile.fileName);
	return /\.(cts|mts|ts|tsx)$/.test(normalizedPath);
}

function buildProgram(rootDir) {
	const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json');
	if (!configPath) {
		throw new Error('Unable to locate tsconfig.json');
	}
	const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
	if (rawConfig.error) {
		throw new Error(ts.flattenDiagnosticMessageText(rawConfig.error.messageText, '\n'));
	}
	const parsedConfig = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, path.dirname(configPath));
	return {
		parsedConfig,
		program: ts.createProgram({
			rootNames: parsedConfig.fileNames,
			options: parsedConfig.options,
			projectReferences: parsedConfig.projectReferences,
		}),
	};
}

function lineOf(sourceFile, position) {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function isFunctionLike(node) {
	return ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node);
}

function buildSymbolName(node) {
	if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
	if (ts.isMethodDeclaration(node) && node.name) {
		const methodName = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : 'method';
		const classNode = node.parent && ts.isClassLike(node.parent) && node.parent.name ? node.parent.name.text : null;
		return classNode ? `${classNode}.${methodName}` : methodName;
	}
	if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
		node.parent &&
		ts.isVariableDeclaration(node.parent) &&
		ts.isIdentifier(node.parent.name)) {
		return node.parent.name.text;
	}
	if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
		node.parent &&
		ts.isPropertyAssignment(node.parent) &&
		ts.isIdentifier(node.parent.name)) {
		return node.parent.name.text;
	}
	return null;
}

function buildSymbolKind(node) {
	if (ts.isMethodDeclaration(node)) return 'method';
	if (ts.isArrowFunction(node)) return 'arrow';
	if (ts.isFunctionExpression(node)) return 'function-expression';
	return 'function';
}

function createSymbolRecord(rootDir, sourceFile, node) {
	const symbolName = buildSymbolName(node);
	if (!symbolName) return null;
	const startLine = lineOf(sourceFile, node.getStart(sourceFile));
	const endLine = lineOf(sourceFile, node.end);
	const filePath = normalizePath(rootDir, sourceFile.fileName);
	return {
		key: `${filePath}:${node.getStart(sourceFile)}:${symbolName}`,
		name: symbolName,
		kind: buildSymbolKind(node),
		filePath,
		startLine,
		endLine,
		node,
		sourceFile,
	};
}

function resolveCallTarget(checker, callExpression, rootDir) {
	const expressionNode = callExpression.expression;
	const lookupNode = ts.isPropertyAccessExpression(expressionNode) ? expressionNode.name :
		ts.isIdentifier(expressionNode) ? expressionNode :
		null;
	const callText = expressionNode.getText();
	const simpleName = ts.isPropertyAccessExpression(expressionNode) ? expressionNode.name.text :
		ts.isIdentifier(expressionNode) ? expressionNode.text :
		callText;
	if (!lookupNode) {
		return {callText, simpleName};
	}
	let targetSymbol = checker.getSymbolAtLocation(lookupNode);
	if (!targetSymbol) return {callText, simpleName};
	if (targetSymbol.flags & ts.SymbolFlags.Alias) {
		targetSymbol = checker.getAliasedSymbol(targetSymbol);
	}
	const targetDeclaration = targetSymbol.valueDeclaration ?? targetSymbol.declarations?.[0];
	if (!targetDeclaration) return {callText, simpleName};
	const targetSourceFile = targetDeclaration.getSourceFile();
	if (targetSourceFile.isDeclarationFile || !isTsSourceFile(targetSourceFile, rootDir)) {
		return {callText, simpleName};
	}
	return {
		callText,
		simpleName,
		targetName: buildSymbolName(targetDeclaration) || simpleName,
		targetFilePath: normalizePath(rootDir, targetSourceFile.fileName),
		targetStartLine: lineOf(targetSourceFile, targetDeclaration.getStart(targetSourceFile)),
	};
}

function resolveImportTarget(parsedConfig, importerFileName, specifierText, rootDir) {
	const resolved = ts.resolveModuleName(specifierText, importerFileName, parsedConfig.options, ts.sys).resolvedModule;
	if (!resolved?.resolvedFileName) return null;
	const normalizedPath = normalizePath(rootDir, resolved.resolvedFileName);
	return /\.(cts|mts|ts|tsx)$/.test(normalizedPath) ? normalizedPath : null;
}

export function buildCodeGraph(options = {}) {
	const rootDir = path.resolve(options.rootDir || process.cwd());
	const {parsedConfig, program} = buildProgram(rootDir);
	const checker = program.getTypeChecker();
	const sourceFrontier = program.getSourceFiles().filter(sourceFile => isTsSourceFile(sourceFile, rootDir));
	const symbols = [];
	const importsByFile = new Map();
	const importedByFile = new Map();
	const calls = [];
	const symbolsByKey = new Map();

	for (const sourceFile of sourceFrontier) {
		const filePath = normalizePath(rootDir, sourceFile.fileName);
		importsByFile.set(filePath, []);
	}

	for (const sourceFile of sourceFrontier) {
		const filePath = normalizePath(rootDir, sourceFile.fileName);
		const importFrontier = importsByFile.get(filePath);
		const enqueueImport = (specifierNode, isTypeOnly = false) => {
			if (!specifierNode || !ts.isStringLiteral(specifierNode)) return;
			const targetPath = resolveImportTarget(parsedConfig, sourceFile.fileName, specifierNode.text, rootDir);
			if (!targetPath) return;
			importFrontier.push({
				specifier: specifierNode.text,
				targetPath,
				typeOnly: isTypeOnly,
			});
			if (!importedByFile.has(targetPath)) importedByFile.set(targetPath, []);
			importedByFile.get(targetPath).push(filePath);
		};

		sourceFile.statements.forEach(statementNode => {
			if (ts.isImportDeclaration(statementNode)) {
				enqueueImport(statementNode.moduleSpecifier, !!statementNode.importClause?.isTypeOnly);
			} else if (ts.isExportDeclaration(statementNode) && statementNode.moduleSpecifier) {
				enqueueImport(statementNode.moduleSpecifier, !!statementNode.isTypeOnly);
			}
		});

		const inspectNode = (currentNode, activeSymbolRecord = null) => {
			let nextActiveSymbol = activeSymbolRecord;
			if (isFunctionLike(currentNode)) {
				const symbolRecord = createSymbolRecord(rootDir, sourceFile, currentNode);
				if (symbolRecord) {
					symbols.push({
						key: symbolRecord.key,
						name: symbolRecord.name,
						kind: symbolRecord.kind,
						filePath: symbolRecord.filePath,
						startLine: symbolRecord.startLine,
						endLine: symbolRecord.endLine,
					});
					symbolsByKey.set(symbolRecord.key, symbolRecord);
				}
				nextActiveSymbol = symbolRecord;
			}
			if (ts.isCallExpression(currentNode) && nextActiveSymbol) {
				const targetInfo = resolveCallTarget(checker, currentNode, rootDir);
				calls.push({
					callerKey: nextActiveSymbol.key,
					callerName: nextActiveSymbol.name,
					callerFilePath: nextActiveSymbol.filePath,
					callerLine: lineOf(sourceFile, currentNode.getStart(sourceFile)),
					callText: targetInfo.callText,
					simpleName: targetInfo.simpleName,
					targetName: targetInfo.targetName || targetInfo.simpleName,
					targetFilePath: targetInfo.targetFilePath || null,
					targetStartLine: targetInfo.targetStartLine || null,
				});
			}
			ts.forEachChild(currentNode, childNode => inspectNode(childNode, nextActiveSymbol));
		};
		ts.forEachChild(sourceFile, inspectNode);
	}

	return {
		rootDir,
		files: sourceFrontier.map(sourceFile => normalizePath(rootDir, sourceFile.fileName)).sort(),
		importsByFile: Object.fromEntries(
			[...importsByFile.entries()].map(([filePath, importEntries]) => [
				filePath,
				importEntries.sort((leftEntry, rightEntry) => leftEntry.targetPath.localeCompare(rightEntry.targetPath)),
			]),
		),
		importedByFile: Object.fromEntries(
			[...importedByFile.entries()].map(([filePath, importedByEntries]) => [
				filePath,
				[...new Set(importedByEntries)].sort(),
			]),
		),
		symbols,
		calls,
	};
}
