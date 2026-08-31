// #1029: pre-activation guard for persisted project.repo/project.working_dir.
//
// V2 repository identity lives in project.repositories.  Until #1030, #1031,
// #1032, and #1053 retire the old consumers, this test carries an exact
// structural ledger of the remaining scalar reads.  The ledger is deliberately
// not a source-line allowlist: each entry is scoped to a file, enclosing symbol,
// field, and access form, and its count must match.  Removing a consumer therefore
// requires removing its ledger entry; adding another one fails this test.

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOTS = ["bin", "server", "src"];
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const EXCLUDED_SOURCE_DIRS = new Set([
  ".next", "__generated__", "__tests__", "build", "coverage", "dist",
  "generated", "node_modules", "out", "test", "tests",
]);
const SCALAR_FIELDS = new Set(["repo", "working_dir"]);

const K = Object.freeze({
  CONFIG: "config",
  CONFIG_FLOW: "config-flow",
  PROJECTS: "project-collection",
  PROJECT: "project",
  REPOSITORIES: "repository-collection",
  REPOSITORY: "repository",
});

// These are the only compatibility symbols.  They are checked by their
// nearest function symbol, never by a path/line regular expression.
const LEGACY_NORMALIZER = "normalizeProjectRepositories";
const V2_MIGRATION_NORMALIZER = "migrateConfigurationToV2";
const RESPONSE_COMPATIBILITY_SERIALIZER = "serializeProjectCompatibility";

function normalizeFileName(fileName) {
  return path.resolve(fileName).replaceAll(path.sep, "/");
}

function relativeFileName(fileName, rootDir) {
  return path.relative(rootDir, fileName).replaceAll(path.sep, "/");
}

function discoverProductionSources(rootDir = ROOT) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_SOURCE_DIRS.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      // Exact dotted suffixes only: contest.js and generated-client.js are
      // production, while x.test.js / x.generated.ts are not.
      if (/(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)) continue;
      if (/(?:^|\.)generated\.[cm]?[jt]sx?$/i.test(entry.name)) continue;
      files.push(full);
    }
  }
  for (const sourceRoot of SOURCE_ROOTS) {
    const absolute = path.join(rootDir, sourceRoot);
    if (fs.existsSync(absolute)) walk(absolute);
  }
  return files.sort();
}

function makeProgram(sourceTextByFile) {
  const options = {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  const sources = new Map(
    [...sourceTextByFile].map(([fileName, text]) => [normalizeFileName(fileName), text]),
  );
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => sources.has(normalizeFileName(fileName));
  host.readFile = (fileName) => sources.get(normalizeFileName(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(normalizeFileName(fileName));
    if (text === undefined) {
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    return ts.createSourceFile(
      fileName,
      text,
      languageVersion,
      true,
      fileName.endsWith("x") ? ts.ScriptKind.TSX : fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
  };
  return ts.createProgram([...sources.keys()], options, host);
}

function functionLike(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function staticPropertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function calleeName(call) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return staticPropertyName(expression.argumentExpression);
  return null;
}

function unwrap(node) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  )) current = current.expression;
  return current;
}

function analyzeSources(sourceTextByFile, rootDir = ROOT) {
  const program = makeProgram(sourceTextByFile);
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => sourceTextByFile.has(normalizeFileName(sourceFile.fileName)));
  const sourceFileByName = new Map(sourceFiles.map((sourceFile) => [normalizeFileName(sourceFile.fileName), sourceFile]));
  const symbolKinds = new Map();
  const symbolOrigins = new Map();
  const symbolShapes = new Map();
  const bindingPatternKinds = new Map();
  const bindingPatternOrigins = new Map();
  const functionReturnKinds = new Map(); // FunctionLike node -> Set<K>
  const assignmentsBySymbol = new Map();
  const propertyAssignmentsBySymbol = new Map();
  const stateSetterTargets = new Map();
  let changed = false;

  function symbolAt(node) {
    if (!node) return null;
    if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      && node.parent.name === node) {
      return checker.getShorthandAssignmentValueSymbol(node.parent)
        || checker.getSymbolAtLocation(node)
        || null;
    }
    return checker.getSymbolAtLocation(node) || null;
  }

  function addToMap(map, key, kind) {
    if (!key || !kind) return;
    let kinds = map.get(key);
    if (!kinds) map.set(key, (kinds = new Set()));
    if (!kinds.has(kind)) {
      kinds.add(kind);
      changed = true;
    }
  }

  function addKindsToMap(map, key, kinds) {
    for (const kind of kinds) addToMap(map, key, kind);
  }

  function addValuesToMap(map, key, values) {
    for (const value of values || []) addToMap(map, key, value);
  }

  function kindsForSymbol(symbol) {
    return symbolKinds.get(symbol) || new Set();
  }

  function hasKind(kinds, kind) {
    return kinds.has(kind);
  }

  function isProjectValue(kinds) {
    // A union can be a repository on one branch and a persisted project on
    // another.  The project possibility must remain guarded; only a value
    // proven to be repository-only is clean.
    return hasKind(kinds, K.PROJECT);
  }

  function union(...sets) {
    const result = new Set();
    for (const set of sets) for (const value of set || []) result.add(value);
    return result;
  }

  function mergeShape(target, source, trackChanges = true) {
    if (!target || !source) return;
    for (const [property, sourceEntry] of source) {
      let entry = target.get(property);
      if (!entry) {
        entry = { kinds: new Set(), origins: new Set(), shape: new Map() };
        target.set(property, entry);
        if (trackChanges) changed = true;
      }
      const beforeKinds = entry.kinds.size;
      const beforeOrigins = entry.origins.size;
      addKindsToSet(entry.kinds, sourceEntry.kinds);
      addKindsToSet(entry.origins, sourceEntry.origins);
      if (trackChanges && (entry.kinds.size !== beforeKinds || entry.origins.size !== beforeOrigins)) changed = true;
      mergeShape(entry.shape, sourceEntry.shape, trackChanges);
    }
  }

  function addAssignment(symbol, expression) {
    if (!symbol || !expression) return;
    let expressions = assignmentsBySymbol.get(symbol);
    if (!expressions) assignmentsBySymbol.set(symbol, (expressions = []));
    if (!expressions.includes(expression)) expressions.push(expression);
  }

  function addPropertyAssignment(symbol, property, expression) {
    if (!symbol || !property || !expression) return;
    let properties = propertyAssignmentsBySymbol.get(symbol);
    if (!properties) propertyAssignmentsBySymbol.set(symbol, (properties = new Map()));
    let expressions = properties.get(property);
    if (!expressions) properties.set(property, (expressions = []));
    if (!expressions.includes(expression)) expressions.push(expression);
  }

  function elementKinds(collectionKinds) {
    const result = new Set();
    if (hasKind(collectionKinds, K.PROJECTS)) result.add(K.PROJECT);
    if (hasKind(collectionKinds, K.REPOSITORIES)) result.add(K.REPOSITORY);
    return result;
  }

  function collectionKindsForElement(elementKindSet) {
    const result = new Set();
    if (hasKind(elementKindSet, K.PROJECT)) result.add(K.PROJECTS);
    if (hasKind(elementKindSet, K.REPOSITORY)) result.add(K.REPOSITORIES);
    return result;
  }

  function moduleSpecifierForRequire(node) {
    const expression = unwrap(node);
    if (!expression || !ts.isCallExpression(expression)) return null;
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "require") return null;
    const requireSymbol = symbolAt(expression.expression);
    if ((requireSymbol?.declarations || []).some((declaration) =>
      sourceFileByName.has(normalizeFileName(declaration.getSourceFile().fileName)))) return null; // locally shadowed require
    return expression.arguments.length === 1 && ts.isStringLiteralLike(expression.arguments[0])
      ? expression.arguments[0].text
      : null;
  }

  function resolveSourceModule(fromSourceFile, specifier) {
    if (!specifier || !specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromSourceFile.fileName), specifier);
    const candidates = [
      base,
      ...[".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].map((extension) => base + extension),
      ...[".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].map((extension) => path.join(base, `index${extension}`)),
    ];
    for (const candidate of candidates) {
      const sourceFile = sourceFileByName.get(normalizeFileName(candidate));
      if (sourceFile) return sourceFile;
    }
    return null;
  }

  function exportedFunctionNodes(sourceFile, exportedName) {
    if (!sourceFile || !exportedName) return [];
    const result = [];
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === exportedName) result.push(statement);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === exportedName
            && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            result.push(declaration.initializer);
          }
        }
      }
    }
    return result;
  }

  function importedFunctionNodesForSymbol(symbol, seen = new Set()) {
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    const result = [];
    for (const declaration of symbol.declarations || []) {
      if (functionLike(declaration)) {
        result.push(declaration);
        continue;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const initializer = unwrap(declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) result.push(initializer);
        else result.push(...functionNodesForCallee(initializer, seen));
        continue;
      }
      if (ts.isPropertyAssignment(declaration) && declaration.initializer) {
        const initializer = unwrap(declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) result.push(initializer);
        else result.push(...functionNodesForCallee(initializer, seen));
        continue;
      }
      if (ts.isBindingElement(declaration)) {
        const pattern = declaration.parent;
        const variable = pattern?.parent;
        if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(variable) || !variable.initializer) continue;
        const specifier = moduleSpecifierForRequire(variable.initializer);
        const targetFile = resolveSourceModule(declaration.getSourceFile(), specifier);
        const exportedName = staticPropertyName(declaration.propertyName || declaration.name);
        result.push(...exportedFunctionNodes(targetFile, exportedName));
        continue;
      }
      if (ts.isImportSpecifier(declaration)) {
        const importDeclaration = declaration.parent?.parent?.parent;
        if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) continue;
        const targetFile = resolveSourceModule(declaration.getSourceFile(), importDeclaration.moduleSpecifier.text);
        const exportedName = (declaration.propertyName || declaration.name).text;
        result.push(...exportedFunctionNodes(targetFile, exportedName));
      }
    }
    return [...new Set(result)];
  }

  function moduleForExpression(rawNode, seen = new Set()) {
    const node = unwrap(rawNode);
    if (!node || seen.has(node)) return null;
    seen.add(node);
    const direct = moduleSpecifierForRequire(node);
    if (direct) return resolveSourceModule(node.getSourceFile(), direct);
    if (!ts.isIdentifier(node)) return null;
    const symbol = symbolAt(node);
    for (const declaration of symbol?.declarations || []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const resolved = moduleForExpression(declaration.initializer, seen);
        if (resolved) return resolved;
      }
      if (ts.isNamespaceImport(declaration)) {
        const importDeclaration = declaration.parent?.parent?.parent;
        if (ts.isImportDeclaration(importDeclaration) && ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) {
          return resolveSourceModule(declaration.getSourceFile(), importDeclaration.moduleSpecifier.text);
        }
      }
    }
    // TypeScript deliberately performs limited CommonJS binding in .js files.
    // Fall back to the actual top-level declaration in this source file (still
    // symbol/declaration provenance, never the identifier spelling alone).
    for (const statement of node.getSourceFile().statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== node.text || !declaration.initializer) continue;
        const resolved = moduleForExpression(declaration.initializer, seen);
        if (resolved) return resolved;
      }
    }
    return null;
  }

  function functionNodesForCallee(rawExpression, seenSymbols = new Set()) {
    const expression = unwrap(rawExpression);
    if (!expression) return [];
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return [expression];
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const targetFile = moduleForExpression(expression.expression);
      const exportedName = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : staticPropertyName(expression.argumentExpression);
      if (targetFile && exportedName) return exportedFunctionNodes(targetFile, exportedName);
    }
    const resolved = importedFunctionNodesForSymbol(symbolAt(expression), seenSymbols);
    if (resolved.length > 0 || !ts.isIdentifier(expression)) return resolved;
    const result = [];
    function consider(declaration) {
      if (ts.isFunctionDeclaration(declaration) && declaration.name?.text === expression.text) result.push(declaration);
      if (ts.isVariableDeclaration(declaration)) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === expression.text && declaration.initializer) {
          const initializer = unwrap(declaration.initializer);
          if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) result.push(initializer);
          else result.push(...functionNodesForCallee(initializer, seenSymbols));
        }
        if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer) {
          const binding = declaration.name.elements.find((element) =>
            ts.isIdentifier(element.name) && element.name.text === expression.text);
          if (binding) {
            const targetFile = resolveSourceModule(declaration.getSourceFile(), moduleSpecifierForRequire(declaration.initializer));
            result.push(...exportedFunctionNodes(targetFile, staticPropertyName(binding.propertyName || binding.name)));
          }
        }
      }
    }
    let scope = expression.parent;
    while (scope) {
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        const declarations = [];
        for (const statement of scope.statements) {
          if (ts.isFunctionDeclaration(statement)) declarations.push(statement);
          if (ts.isVariableStatement(statement)) declarations.push(...statement.declarationList.declarations);
        }
        for (const declaration of declarations) consider(declaration);
        if (result.length > 0) break; // nearest lexical declaration wins
      }
      scope = scope.parent;
    }
    return [...new Set(result)];
  }

  function isPersistedPathExpression(rawNode, seenSymbols = new Set()) {
    const node = unwrap(rawNode);
    if (!node) return false;
    if (ts.isStringLiteralLike(node)) return /(?:^|[\\/])config\.json$/i.test(node.text);
    if (!ts.isIdentifier(node)) return false;
    const symbol = symbolAt(node);
    if (!symbol || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    return (assignmentsBySymbol.get(symbol) || []).some((expression) => {
      let found = false;
      function visit(candidate) {
        if (ts.isStringLiteralLike(candidate) && /(?:^|[\\/])?config\.json$/i.test(candidate.text)) found = true;
        if (!found && ts.isIdentifier(candidate) && candidate !== node
          && isPersistedPathExpression(candidate, new Set(seenSymbols))) found = true;
        if (!found) ts.forEachChild(candidate, visit);
      }
      visit(expression);
      return found;
    });
  }

  function isPersistedConfigData(rawNode, seenSymbols = new Set()) {
    const node = unwrap(rawNode);
    if (!node) return false;
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      const isRead = (ts.isPropertyAccessExpression(expression) && expression.name.text === "readFileSync")
        || (ts.isIdentifier(expression) && expression.text === "readFileSync");
      return isRead && node.arguments.length > 0 && isPersistedPathExpression(node.arguments[0]);
    }
    if (!ts.isIdentifier(node)) return false;
    const symbol = symbolAt(node);
    if (!symbol || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    return (assignmentsBySymbol.get(symbol) || []).some((expression) =>
      isPersistedConfigData(expression, new Set(seenSymbols)));
  }

  function readsPersistedConfig(call) {
    const expression = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "parse") return false;
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "JSON") return false;
    if (symbolAt(expression.expression)) return false; // shadowed JSON
    return call.arguments.length > 0 && isPersistedConfigData(call.arguments[0]);
  }

  function endpointFromCall(call) {
    const expression = unwrap(call.expression);
    if (ts.isIdentifier(expression) && expression.text === "fetch" && !symbolAt(expression)
      && call.arguments.length > 0 && ts.isStringLiteralLike(call.arguments[0])) {
      return call.arguments[0].text;
    }
    const localTargets = functionNodesForCallee(expression);
    if (localTargets.some((fn) => (fn.name?.text || (ts.isVariableDeclaration(fn.parent) && staticPropertyName(fn.parent.name))) === "httpRequest")
      && call.arguments.length > 1 && ts.isStringLiteralLike(call.arguments[1])) {
      return call.arguments[1].text;
    }
    return null;
  }

  function symbolIsImportFrom(symbol, moduleName, exportedName) {
    for (const declaration of symbol?.declarations || []) {
      if (!ts.isImportSpecifier(declaration)) continue;
      const importDeclaration = declaration.parent?.parent?.parent;
      if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) continue;
      if (importDeclaration.moduleSpecifier.text === moduleName
        && (declaration.propertyName || declaration.name).text === exportedName) return true;
    }
    return false;
  }

  // Collect real assignment provenance before the fixed-point pass. This is
  // also what makes local config readers work without trusting their names.
  for (const sourceFile of sourceFiles) {
    function collect(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        addAssignment(symbolAt(node.name), node.initializer);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrap(node.left))) {
        addAssignment(symbolAt(unwrap(node.left)), node.right);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(unwrap(node.left)) || ts.isElementAccessExpression(unwrap(node.left)))) {
        const left = unwrap(node.left);
        const base = unwrap(left.expression);
        const property = ts.isPropertyAccessExpression(left) ? left.name.text : staticPropertyName(left.argumentExpression);
        if (ts.isIdentifier(base)) addPropertyAssignment(symbolAt(base), property, node.right);
      }
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
        && node.initializer && ts.isCallExpression(node.initializer)
        && symbolIsImportFrom(symbolAt(node.initializer.expression), "react", "useState")) {
        const value = node.name.elements[0];
        const setter = node.name.elements[1];
        if (value && setter && ts.isBindingElement(value) && ts.isBindingElement(setter)
          && ts.isIdentifier(value.name) && ts.isIdentifier(setter.name)) {
          stateSetterTargets.set(symbolAt(setter.name), value.name);
        }
      }
      ts.forEachChild(node, collect);
    }
    collect(sourceFile);
  }

  const canonicalConfigFile = sourceFileByName.get(normalizeFileName(path.join(rootDir, "server", "config.js"))) || null;
  const canonicalConfigReaderNode = exportedFunctionNodes(canonicalConfigFile, "readConfig")[0] || null;
  const canonicalCloneConfigurationNode = exportedFunctionNodes(canonicalConfigFile, "cloneConfigurationValue")[0] || null;
  const legacyNormalizerNode = exportedFunctionNodes(canonicalConfigFile, LEGACY_NORMALIZER)[0] || null;
  const migrationNormalizerNode = exportedFunctionNodes(canonicalConfigFile, V2_MIGRATION_NORMALIZER)[0] || null;
  const compatibilitySerializerNode = exportedFunctionNodes(canonicalConfigFile, RESPONSE_COMPATIBILITY_SERIALIZER)[0] || null;
  const canonicalPrimaryRepositoryNode = exportedFunctionNodes(canonicalConfigFile, "primaryRepository")[0] || null;

  function originsForSymbol(symbol) {
    return symbolOrigins.get(symbol) || new Set();
  }

  function originsForExpression(rawNode, seen = new Set()) {
    const node = unwrap(rawNode);
    if (!node || seen.has(node)) return new Set();
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node);
      return union(
        new Set(originsForSymbol(symbol)),
        ...(assignmentsBySymbol.get(symbol) || []).map((assignment) =>
          originsForExpression(assignment, new Set(seen))),
      );
    }
    if (ts.isConditionalExpression(node)) {
      return union(originsForExpression(node.whenTrue, seen), originsForExpression(node.whenFalse, seen));
    }
    if (ts.isBinaryExpression(node)) {
      return union(originsForExpression(node.left, seen), originsForExpression(node.right, seen));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return union(...node.properties.map((property) => {
        if (ts.isSpreadAssignment(property)) return originsForExpression(property.expression, new Set(seen));
        if (ts.isShorthandPropertyAssignment(property)) return originsForExpression(property.name, new Set(seen));
        if (ts.isPropertyAssignment(property)) return originsForExpression(property.initializer, new Set(seen));
        return new Set();
      }));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text : staticPropertyName(node.argumentExpression);
      const entry = shapeForExpression(node.expression, seen)?.get(property);
      return union(
        property === "repositories" && hasKind(expressionKinds(node.expression), K.PROJECT)
          ? originsForExpression(node.expression, new Set(seen)) : new Set(),
        entry ? new Set(entry.origins) : new Set(),
        ...propertyValueExpressions(node.expression, property).map((value) => originsForExpression(value, new Set(seen))),
      );
    }
    if (ts.isCallExpression(node) && ["find", "findLast", "at"].includes(calleeName(node))) {
      return originsForExpression(node.expression.expression, seen);
    }
    if (ts.isCallExpression(node)) {
      return union(...node.arguments.map((argument) => originsForExpression(argument, new Set(seen))));
    }
    return new Set();
  }

  function shapeForExpression(rawNode, seen = new Set()) {
    const node = unwrap(rawNode);
    if (!node || seen.has(node)) return new Map();
    seen.add(node);
    if (ts.isIdentifier(node)) return symbolShapes.get(symbolAt(node)) || new Map();
    if (ts.isObjectLiteralExpression(node)) {
      const shape = new Map();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          mergeShape(shape, shapeForExpression(property.expression, new Set(seen)), false);
          continue;
        }
        let name;
        let value;
        if (ts.isShorthandPropertyAssignment(property)) {
          name = property.name.text;
          value = property.name;
        } else if (ts.isPropertyAssignment(property)) {
          name = staticPropertyName(property.name);
          value = property.initializer;
        }
        if (!name || !value) continue;
        shape.set(name, {
          kinds: expressionKinds(value, new Set(seen)),
          origins: originsForExpression(value, new Set(seen)),
          shape: shapeForExpression(value, new Set(seen)),
        });
      }
      return shape;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text : staticPropertyName(node.argumentExpression);
      return shapeForExpression(node.expression, seen).get(property)?.shape || new Map();
    }
    return new Map();
  }

  function isOperatorContextProjectReaderCall(call) {
    const expression = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "getConfiguredProjects") return false;
    if (!ts.isIdentifier(expression.expression)) return false;
    let owner = call.parent;
    while (owner && !functionLike(owner)) owner = owner.parent;
    if (!owner || owner.parameters.length < 2 || !ts.isIdentifier(owner.parameters[1].name)) return false;
    if (symbolAt(expression.expression) !== symbolAt(owner.parameters[1].name)) return false;
    // MCP tool handlers are properties inside module.exports.handlers. This
    // structural contract is narrower than trusting any .getConfiguredProjects
    // method name in production code.
    let current = owner.parent;
    let insideHandlers = false;
    let insideModuleExports = false;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isPropertyAssignment(current) && staticPropertyName(current.name) === "handlers") insideHandlers = true;
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && current.left.getText() === "module.exports") insideModuleExports = true;
      current = current.parent;
    }
    return insideHandlers && insideModuleExports;
  }

  function propertyValueExpressions(rawBase, property, seenSymbols = new Set()) {
    const base = unwrap(rawBase);
    if (!base || !property) return [];
    if (ts.isObjectLiteralExpression(base)) {
      const values = [];
      for (const member of base.properties) {
        if (ts.isSpreadAssignment(member)) values.push(...propertyValueExpressions(member.expression, property, new Set(seenSymbols)));
        else if (ts.isShorthandPropertyAssignment(member) && member.name.text === property) values.push(member.name);
        else if (ts.isPropertyAssignment(member) && staticPropertyName(member.name) === property) values.push(member.initializer);
      }
      return values;
    }
    if (!ts.isIdentifier(base)) return [];
    const symbol = symbolAt(base);
    if (!symbol || seenSymbols.has(symbol)) return [];
    seenSymbols.add(symbol);
    const values = [...(propertyAssignmentsBySymbol.get(symbol)?.get(property) || [])];
    for (const assignment of assignmentsBySymbol.get(symbol) || []) {
      values.push(...propertyValueExpressions(assignment, property, new Set(seenSymbols)));
    }
    return values;
  }

  function expressionKinds(rawNode, seen = new Set()) {
    const node = unwrap(rawNode);
    if (!node || seen.has(node)) return new Set();
    seen.add(node);

    if (ts.isIdentifier(node)) return new Set(kindsForSymbol(symbolAt(node)));
    if (ts.isAwaitExpression(node)) {
      const awaited = expressionKinds(node.expression, seen);
      const result = new Set(awaited);
      if (hasKind(awaited, K.CONFIG_FLOW)) result.add(K.CONFIG);
      return result;
    }
    if (ts.isConditionalExpression(node)) {
      return union(expressionKinds(node.whenTrue, seen), expressionKinds(node.whenFalse, seen));
    }
    if (ts.isBinaryExpression(node)) {
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken]
        .includes(node.operatorToken.kind)) {
        return union(expressionKinds(node.left, seen), expressionKinds(node.right, seen));
      }
      return expressionKinds(node.right, seen);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const result = new Set();
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) addKindsToSet(result, expressionKinds(element.expression, seen));
        else addKindsToSet(result, collectionKindsForElement(expressionKinds(element, seen)));
      }
      return result;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const spreads = node.properties.filter(ts.isSpreadAssignment);
      const result = union(...spreads.map((spread) => expressionKinds(spread.expression, new Set(seen))));
      const projectsProperty = node.properties.find((property) =>
        ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "projects");
      if (projectsProperty && hasKind(expressionKinds(projectsProperty.initializer, new Set(seen)), K.PROJECTS)) {
        result.add(K.CONFIG);
      }
      const repositoriesProperty = node.properties.find((property) =>
        (ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "repositories")
        || (ts.isShorthandPropertyAssignment(property) && property.name.text === "repositories"));
      const repositoriesValue = repositoriesProperty && (ts.isPropertyAssignment(repositoriesProperty)
        ? repositoriesProperty.initializer : repositoriesProperty.name);
      if (repositoriesValue && hasKind(expressionKinds(repositoriesValue, new Set(seen)), K.REPOSITORIES)) {
        result.add(K.PROJECT);
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = expressionKinds(node.expression, seen);
      const property = node.name.text;
      const result = new Set();
      if (property === "projects" && hasKind(base, K.CONFIG)) result.add(K.PROJECTS);
      if (property === "repositories" && hasKind(base, K.PROJECT)) result.add(K.REPOSITORIES);
      const entry = shapeForExpression(node.expression, new Set(seen)).get(property);
      if (entry) addKindsToSet(result, entry.kinds);
      for (const value of propertyValueExpressions(node.expression, property)) {
        addKindsToSet(result, expressionKinds(value, new Set(seen)));
      }
      return result;
    }
    if (ts.isElementAccessExpression(node)) {
      const base = expressionKinds(node.expression, seen);
      const property = staticPropertyName(node.argumentExpression);
      const result = new Set();
      if (property === "projects" && hasKind(base, K.CONFIG)) result.add(K.PROJECTS);
      else if (property === "repositories" && hasKind(base, K.PROJECT)) result.add(K.REPOSITORIES);
      else {
        addKindsToSet(result, elementKinds(base));
        const entry = shapeForExpression(node.expression, new Set(seen)).get(property);
        if (entry) addKindsToSet(result, entry.kinds);
        for (const value of propertyValueExpressions(node.expression, property)) {
          addKindsToSet(result, expressionKinds(value, new Set(seen)));
        }
      }
      return result;
    }
    if (!ts.isCallExpression(node)) return new Set();

    const name = calleeName(node);
    // V1 route-local readers are part of the pre-activation debt this guard is
    // meant to expose.  This is an AST identity check on CONFIG_PATH inside a
    // JSON.parse input, not a source-line/path exemption.
    if (readsPersistedConfig(node)) return new Set([K.CONFIG]);
    const targetFunctions = functionNodesForCallee(node.expression);
    // The canonical reader may acquire its persisted document through helper
    // calls and migrations.  Seed only that exact config.js declaration so an
    // unrelated object (or a same-named local function) cannot become a source.
    if (canonicalConfigReaderNode && targetFunctions.includes(canonicalConfigReaderNode)) {
      return new Set([K.CONFIG]);
    }
    // This exact config helper is a shape-preserving deep clone.  Treating its
    // monomorphic global return summary as a union would incorrectly mix every
    // repository and project callsite; preserve the actual argument kind.
    if (canonicalCloneConfigurationNode && targetFunctions.includes(canonicalCloneConfigurationNode)
      && node.arguments[0]) {
      return expressionKinds(node.arguments[0], seen);
    }
    if (isOperatorContextProjectReaderCall(node)) return new Set([K.PROJECTS]);
    if (canonicalPrimaryRepositoryNode && targetFunctions.includes(canonicalPrimaryRepositoryNode)
      && hasKind(expressionKinds(node.arguments[0], seen), K.PROJECT)) {
      return new Set([K.REPOSITORY]);
    }
    const endpoint = endpointFromCall(node);
    if (endpoint === "/api/config" || endpoint === "/api/projects") return new Set([K.CONFIG_FLOW]);

    const result = union(...targetFunctions.map((fn) => functionReturnKinds.get(fn) || new Set()));

    const methodTarget = ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
      ? node.expression.expression
      : null;
    if (!methodTarget) return result;
    const base = expressionKinds(methodTarget, seen);
    if (name === "json" && hasKind(base, K.CONFIG_FLOW)) result.add(K.CONFIG);
    if (name === "then" && hasKind(base, K.CONFIG_FLOW)) result.add(K.CONFIG_FLOW);
    if (["find", "findLast", "at"].includes(name)) addKindsToSet(result, elementKinds(base));
    if (["filter", "slice", "toSorted"].includes(name)) addKindsToSet(result, base);
    if ((name === "map" || name === "flatMap") && node.arguments[0]) {
      const callback = functionNodeForExpression(node.arguments[0]);
      const returned = callback ? functionReturnKinds.get(callback) || new Set() : new Set();
      if (name === "map") addKindsToSet(result, collectionKindsForElement(returned));
      else {
        if (hasKind(returned, K.PROJECT) || hasKind(returned, K.PROJECTS)) result.add(K.PROJECTS);
        if (hasKind(returned, K.REPOSITORY) || hasKind(returned, K.REPOSITORIES)) result.add(K.REPOSITORIES);
      }
    }
    return result;
  }

  function addKindsToSet(target, source) {
    for (const kind of source) target.add(kind);
  }

  function assignBinding(name, kinds, origins = new Set(), shape = new Map()) {
    if (!name || (kinds.size === 0 && shape.size === 0)) return;
    if (ts.isIdentifier(name)) {
      const symbol = symbolAt(name);
      addKindsToMap(symbolKinds, symbol, kinds);
      const carriesProjectOrigin = [K.PROJECT, K.PROJECTS, K.REPOSITORIES, K.REPOSITORY]
        .some((kind) => hasKind(kinds, kind));
      if (carriesProjectOrigin) {
        const trackedOrigins = symbolOrigins.get(symbol);
        if (origins.size > 0) {
          // A self-origin is only a provisional root used before caller flow is
          // known. Replace it once concrete upstream origins arrive so an
          // exemption cannot be defeated (or granted) by fixed-point timing.
          if (trackedOrigins?.delete(symbol)) changed = true;
          addValuesToMap(symbolOrigins, symbol, origins);
        } else if (hasKind(kinds, K.PROJECT) && (!trackedOrigins || trackedOrigins.size === 0)) {
          addValuesToMap(symbolOrigins, symbol, new Set([symbol]));
        }
      }
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      addKindsToMap(bindingPatternKinds, name, kinds);
      addValuesToMap(bindingPatternOrigins, name, origins);
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (element.dotDotDotToken) {
          // Object rest is an alias of all remaining persisted fields.
          assignBinding(element.name, kinds, origins, shape);
          continue;
        }
        const property = staticPropertyName(element.propertyName || element.name);
        const shaped = shape.get(property);
        if (shaped) assignBinding(element.name, shaped.kinds, shaped.origins, shaped.shape);
        if (property === "projects" && hasKind(kinds, K.CONFIG)) {
          assignBinding(element.name, new Set([K.PROJECTS]));
        } else if (property === "repositories" && hasKind(kinds, K.PROJECT)) {
          assignBinding(element.name, new Set([K.REPOSITORIES]));
        }
      }
    }
    if (ts.isArrayBindingPattern(name)) {
      const elements = name.elements.filter(ts.isBindingElement);
      for (const element of elements) assignBinding(element.name, elementKinds(kinds));
    }
  }

  function functionNodeForExpression(expression) {
    const node = unwrap(expression);
    if (node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return node;
    return functionNodesForCallee(node)[0] || null;
  }

  function bindFunctionParameter(fn, index, kinds, origins = new Set(), shape = new Map()) {
    if (!fn || !fn.parameters || !fn.parameters[index]) return;
    assignBinding(fn.parameters[index].name, kinds, origins, shape);
  }

  function processCall(call) {
    const name = calleeName(call);
    const methodTarget = ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)
      ? call.expression.expression
      : null;
    const base = methodTarget ? expressionKinds(methodTarget) : new Set();

    if (name === "then" && hasKind(base, K.CONFIG_FLOW) && call.arguments[0]) {
      bindFunctionParameter(functionNodeForExpression(call.arguments[0]), 0, new Set([K.CONFIG]));
    }

    const elements = elementKinds(base);
    if (elements.size > 0 && ["every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flatMap", "forEach", "map", "some"]
      .includes(name) && call.arguments[0]) {
      bindFunctionParameter(functionNodeForExpression(call.arguments[0]), 0, elements, originsForExpression(methodTarget));
    }
    if (elements.size > 0 && ["sort", "toSorted"].includes(name) && call.arguments[0]) {
      bindFunctionParameter(functionNodeForExpression(call.arguments[0]), 0, elements);
      bindFunctionParameter(functionNodeForExpression(call.arguments[0]), 1, elements);
    }
    if (elements.size > 0 && name === "reduce" && call.arguments[0]) {
      bindFunctionParameter(functionNodeForExpression(call.arguments[0]), 1, elements);
    }

    // Bind parameters for every resolved local declaration, including object
    // and class methods.  Unresolved built-in methods (map/filter/etc.) have no
    // local declaration in this no-lib program and are handled above instead.
    const directTargets = functionNodesForCallee(call.expression);
    for (const directTarget of directTargets) {
      call.arguments.forEach((argument, index) => bindFunctionParameter(
        directTarget,
        index,
        expressionKinds(argument),
        originsForExpression(argument),
        shapeForExpression(argument),
      ));
    }

    const setterTarget = ts.isIdentifier(unwrap(call.expression))
      ? stateSetterTargets.get(symbolAt(unwrap(call.expression)))
      : null;
    if (setterTarget && call.arguments[0]) {
      assignBinding(
        setterTarget,
        expressionKinds(call.arguments[0]),
        originsForExpression(call.arguments[0]),
        shapeForExpression(call.arguments[0]),
      );
    }
  }

  function runInferencePass() {
    for (const sourceFile of sourceFiles) {
      function visit(node) {
        if (ts.isVariableDeclaration(node)) {
          if (node.initializer) assignBinding(
            node.name,
            expressionKinds(node.initializer),
            originsForExpression(node.initializer),
            shapeForExpression(node.initializer),
          );
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (ts.isIdentifier(unwrap(node.left))) assignBinding(
            unwrap(node.left),
            expressionKinds(node.right),
            originsForExpression(node.right),
            shapeForExpression(node.right),
          );
        } else if (ts.isForOfStatement(node)) {
          const loopKinds = elementKinds(expressionKinds(node.expression));
          if (ts.isVariableDeclarationList(node.initializer)) {
            for (const declaration of node.initializer.declarations) assignBinding(declaration.name, loopKinds);
          } else if (ts.isIdentifier(node.initializer)) assignBinding(node.initializer, loopKinds);
        } else if (ts.isCallExpression(node)) {
          processCall(node);
        } else if (ts.isReturnStatement(node) && node.expression) {
          let owner = node.parent;
          while (owner && !functionLike(owner)) owner = owner.parent;
          if (owner) addKindsToMap(functionReturnKinds, owner, expressionKinds(node.expression));
        } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
          addKindsToMap(functionReturnKinds, node, expressionKinds(node.body));
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
    }
  }

  for (let iteration = 0; iteration < 40; iteration++) {
    changed = false;
    runInferencePass();
    if (!changed) break;
    if (iteration === 39) throw new Error("project scalar analysis did not converge");
  }

  function enclosingFunction(node) {
    let current = node.parent;
    while (current && !functionLike(current)) current = current.parent;
    return current || null;
  }

  function enclosingSymbolName(node) {
    const fn = enclosingFunction(node);
    if (!fn) return "<module>";
    if (fn.name) return staticPropertyName(fn.name) || "<anonymous>";
    if (fn.parent && ts.isVariableDeclaration(fn.parent)) return staticPropertyName(fn.parent.name) || "<anonymous>";
    if (fn.parent && ts.isPropertyAssignment(fn.parent)) return staticPropertyName(fn.parent.name) || "<anonymous>";
    if (fn.parent && ts.isCallExpression(fn.parent)) return `<${calleeName(fn.parent) || "callback"}-callback>`;
    return "<anonymous>";
  }

  function callbackDescriptor(fn) {
    if (!fn?.parent || !ts.isCallExpression(fn.parent)) return null;
    const call = fn.parent;
    const argumentIndex = call.arguments.findIndex((argument) => argument === fn);
    const literalContext = call.arguments
      .filter((argument) => argument !== fn && ts.isStringLiteralLike(argument))
      .map((argument) => JSON.stringify(argument.text))
      .join(",");
    return `${calleeName(call) || "call"}(${literalContext})#arg${argumentIndex}`;
  }

  function ownershipIdentity(node) {
    const scopes = [];
    let current = node.parent;
    while (current) {
      if (functionLike(current)) {
        const named = current.name
          ? staticPropertyName(current.name)
          : ts.isVariableDeclaration(current.parent) ? staticPropertyName(current.parent.name)
            : ts.isPropertyAssignment(current.parent) ? staticPropertyName(current.parent.name) : null;
        scopes.push(named || callbackDescriptor(current) || "anonymous-function");
      }
      current = current.parent;
    }
    const owner = [...scopes].reverse().find((scope) => !scope.includes("#arg"))
      || scopes.at(-1)
      || "<module>";
    return { owner, callsite: scopes.reverse().join(" > ") || "<module>" };
  }

  function statementAnchor(node) {
    let current = node;
    while (current.parent && !ts.isStatement(current) && !ts.isSourceFile(current.parent)) current = current.parent;
    const normalized = current.getText().replace(/\s+/g, " ").trim();
    const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    const readable = normalized.replace(/[\r\n]/g, " ").slice(0, 56);
    const scope = enclosingFunction(node) || node.getSourceFile();
    let astOrdinal = -1;
    let nextOrdinal = 0;
    function findOrdinal(candidate) {
      const ordinal = nextOrdinal++;
      if (candidate === node) astOrdinal = ordinal;
      if (astOrdinal < 0) ts.forEachChild(candidate, findOrdinal);
    }
    findOrdinal(scope);
    return `${digest}#${astOrdinal}:${readable}`;
  }

  function containsMatchingCanonicalPrimaryCall(fn, violationOrigins) {
    if (!violationOrigins || violationOrigins.size === 0) return false;
    const coveredOrigins = new Set();
    function visit(node) {
      if (node !== fn && functionLike(node)) return;
      if (ts.isCallExpression(node) && canonicalPrimaryRepositoryNode
        && functionNodesForCallee(node.expression).includes(canonicalPrimaryRepositoryNode)
        && node.arguments[0]) {
        const callOrigins = originsForExpression(node.arguments[0]);
        for (const origin of callOrigins) coveredOrigins.add(origin);
      }
      ts.forEachChild(node, visit);
    }
    if (fn.body) visit(fn.body);
    for (const origin of violationOrigins) {
      if (!coveredOrigins.has(origin)) return false;
    }
    return true;
  }

  function exempt(node, sourceFile, violationOrigins) {
    if (sourceFile !== canonicalConfigFile) return false;
    let fn = enclosingFunction(node);
    while (fn) {
      if (fn === legacyNormalizerNode || fn === migrationNormalizerNode) return true;
      if (fn === compatibilitySerializerNode) {
        return containsMatchingCanonicalPrimaryCall(fn, violationOrigins);
      }
      let parent = fn.parent;
      while (parent && !functionLike(parent)) parent = parent.parent;
      fn = parent || null;
    }
    return false;
  }

  function expressionLabel(node) {
    return unwrap(node).getText().replace(/\s+/g, " ").slice(0, 120);
  }

  const violations = [];
  const seenViolations = new Set();
  function record(sourceFile, node, field, access, binding, violationOrigins = new Set()) {
    if (exempt(node, sourceFile, violationOrigins)) return;
    const dedupe = `${normalizeFileName(sourceFile.fileName)}:${node.pos}:${node.end}:${field}:${access}`;
    if (seenViolations.has(dedupe)) return;
    seenViolations.add(dedupe);
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const ownership = ownershipIdentity(node);
    violations.push({
      file: relativeFileName(sourceFile.fileName, rootDir),
      symbol: enclosingSymbolName(node),
      owner: ownership.owner,
      callsite: ownership.callsite,
      anchor: statementAnchor(node),
      field,
      access,
      binding,
      line: start.line + 1,
      column: start.character + 1,
    });
  }

  for (const sourceFile of sourceFiles) {
    function visit(node) {
      if (ts.isPropertyAccessExpression(node) && SCALAR_FIELDS.has(node.name.text)
        && isProjectValue(expressionKinds(node.expression))) {
        record(sourceFile, node, node.name.text, node.questionDotToken ? "optional-property" : "property", expressionLabel(node.expression), originsForExpression(node.expression));
      } else if (ts.isElementAccessExpression(node)) {
        const field = staticPropertyName(node.argumentExpression);
        if (SCALAR_FIELDS.has(field) && isProjectValue(expressionKinds(node.expression))) {
          record(sourceFile, node, field, node.questionDotToken ? "optional-element" : "element", expressionLabel(node.expression), originsForExpression(node.expression));
        }
      } else if (ts.isObjectBindingPattern(node) && isProjectValue(bindingPatternKinds.get(node) || new Set())) {
        for (const element of node.elements) {
          if (element.dotDotDotToken) continue;
          const field = staticPropertyName(element.propertyName || element.name);
          if (SCALAR_FIELDS.has(field)) record(sourceFile, element, field, "destructure", node.getText(), bindingPatternOrigins.get(node) || new Set());
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isObjectLiteralExpression(unwrap(node.left)) && isProjectValue(expressionKinds(node.right))) {
        for (const property of unwrap(node.left).properties) {
          const field = ts.isShorthandPropertyAssignment(property)
            ? property.name.text
            : ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : null;
          if (SCALAR_FIELDS.has(field)) record(sourceFile, property, field, "destructure-assignment", unwrap(node.left).getText(), originsForExpression(node.right));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return violations.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.field.localeCompare(b.field));
}

function analyzeFixtureSources(entries) {
  return analyzeSources(new Map(Object.entries(entries).map(([fileName, source]) => [
    normalizeFileName(path.join(ROOT, fileName)),
    source,
  ])), ROOT);
}

const FIXTURE_CONFIG_PREAMBLE = `
  const fs = require("node:fs");
  const CONFIG_PATH = "/tmp/.quadwork/config.json";
  function readConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  function normalizeProjectRepositories(project) {
    return project.repositories || [{ key: "primary", repo: project.repo, working_dir: project.working_dir, primary: true }];
  }
  function migrateConfigurationToV2(config) {
    const migrated = { ...config.projects[0] };
    delete migrated["repo"];
    delete migrated["working_dir"];
    return { ...config, projects: [migrated] };
  }
  function primaryRepository(project) { return project.repositories.find((entry) => entry.primary); }
`;

function fixtureFiles(consumerName, consumerSource, configSuffix = `
  function serializeProjectCompatibility(project) {
    const primary = primaryRepository(project);
    return { repo: primary.repo, working_dir: primary.working_dir };
  }
  module.exports = { readConfig, normalizeProjectRepositories, migrateConfigurationToV2, primaryRepository, serializeProjectCompatibility };
`) {
  return {
    "server/config.js": FIXTURE_CONFIG_PREAMBLE + configSuffix,
    [consumerName]: consumerSource,
  };
}

function violationSummary(violation) {
  return `${violation.file} :: owner=${violation.owner} :: call=${violation.callsite} :: binding=${violation.binding} :: ${violation.field}:${violation.access} :: at=${violation.anchor}`;
}

function ledgerFor(violations) {
  const ledger = {};
  for (const violation of violations) {
    const key = violationSummary(violation);
    ledger[key] = (ledger[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
}

function runDiscoveryFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-scalar-discovery-"));
  try {
    const included = ["bin/contest.js", "server/generated-client.js", "src/widget.tsx"];
    const excluded = [
      "bin/tool.test.js", "bin/tool.spec.ts", "bin/tool.generated.js", "bin/generated.js",
      "server/test/hidden.js", "server/tests/hidden.js", "server/__tests__/hidden.js",
      "server/generated/hidden.js", "server/__generated__/hidden.js", "src/out/hidden.js",
    ];
    for (const relative of [...included, ...excluded]) {
      const absolute = path.join(fixtureRoot, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "void 0;\n");
    }
    const discovered = discoverProductionSources(fixtureRoot)
      .map((fileName) => relativeFileName(fileName, fixtureRoot));
    assert.deepEqual(discovered, included.sort(),
      "source discovery excludes exact test/tests/generated dirs and dotted test/generated files only");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function runSelfFixtures() {
  const detected = analyzeFixtureSources(fixtureFiles("fixtures/detected.ts", `
    const { readConfig: loadPersisted } = require("../server/config");
    const projects = loadPersisted().projects;
    const project = projects.find((candidate: any) => candidate.id === "p");
    function canonicalProjectReader() { return loadPersisted().projects.find((candidate: any) => candidate.id === "p"); }
    const alias = project;
    const { ...restAlias } = project;
    const { projects: destructuredProjects } = loadPersisted();
    const multiSpread = { ...{ id: "fallback" }, ...project };
    const holder = { current: project };
    const assignedHolder: any = {};
    assignedHolder.current = project;
    project.repo;
    alias.working_dir;
    const { repo: renamedRepo, working_dir } = alias;
    alias["repo"];
    alias?.["working_dir"];
    projects.map((entry: any) => entry?.repo);
    canonicalProjectReader().working_dir;
    restAlias.repo;
    destructuredProjects[0].repo;
    multiSpread.repo;
    holder.current.repo;
    assignedHolder.current.working_dir;
  `));
  const detectedKinds = detected.map((item) => `${item.field}:${item.access}`);
  for (const expected of ["repo:destructure", "repo:element", "repo:optional-property", "working_dir:destructure", "working_dir:optional-element"]) {
    assert.ok(detectedKinds.includes(expected), `detects ${expected}`);
  }
  assert.ok(detected.filter((item) => item.binding === "multiSpread" && item.field === "repo").length === 1,
    "detects multi-spread aliases");
  assert.ok(detected.some((item) => item.binding === "holder.current" && item.field === "repo"),
    `detects holder property aliases: ${JSON.stringify(detected)}`);
  assert.ok(detected.some((item) => item.binding === "assignedHolder.current" && item.field === "working_dir"),
    "detects assigned holder property aliases");

  const clean = analyzeFixtureSources(fixtureFiles("fixtures/clean.ts", `
    const { readConfig: loadPersisted } = require("../server/config");
    const project = loadPersisted().projects.find((candidate: any) => candidate.id === "p");
    const repository = project.repositories.find((entry: any) => entry.primary);
    const { repositories } = project;
    repository.repo;
    repository?.working_dir;
    repositories[0].repo;
    const { repo, working_dir } = repository;
    function transient(req: any, form: any, github: any) {
      const repo = req.body.repo;
      const working_dir = form.working_dir;
      const unrelatedProject = github.projects.find((item: any) => item.id === "x");
      return [repo, working_dir, unrelatedProject?.repo];
    }
  `));
  assert.deepEqual(clean, [], "repository entries, request/form locals, and unrelated GitHub objects must not be flagged");

  const projections = analyzeFixtureSources(fixtureFiles("fixtures/projections.ts", `
    const { readConfig: loadPersisted } = require("../server/config");
    const projects = loadPersisted().projects;
    const identity = (project: any) => project;
    const identityAlias = identity;
    const repositoryProjection = (project: any) => project.repositories[0];
    const repositoryFlatProjection = (project: any) => project.repositories;
    const mixedProjection = (project: any) => project.id ? project : project.repositories[0];
    const mixedDirect = projects[0].id ? projects[0] : projects[0].repositories[0];
    projects.map(repositoryProjection)[0].repo;
    projects.flatMap(repositoryFlatProjection)[0].working_dir;
    projects.map(identityAlias)[0].repo;
    projects.flatMap((project: any) => [project])[0].working_dir;
    mixedDirect.repo;
    projects.map(mixedProjection)[0].working_dir;
  `));
  assert.deepEqual(projections.map((item) => item.field).sort(), ["repo", "repo", "working_dir", "working_dir"],
    "map/flatMap infer callback projections; repository-only projections stay clean while identity and mixed unions stay guarded");

  const localMethods = analyzeFixtureSources(fixtureFiles("fixtures/local-methods.ts", `
    const { readConfig: loadPersisted } = require("../server/config");
    const project = loadPersisted().projects[0];
    const objectReader = {
      read(projectArg: any) { return projectArg.repo; },
      readArrow: (projectArg: any) => projectArg.working_dir,
    };
    class ClassReader {
      read(projectArg: any) { return projectArg.repo; }
    }
    objectReader.read(project);
    objectReader.readArrow(project);
    new ClassReader().read(project);
  `));
  assert.deepEqual(localMethods.map((item) => item.field).sort(), ["repo", "repo", "working_dir"],
    "resolved object and class methods receive persisted-project argument flow");

  const ledgerIdentity = analyzeFixtureSources(fixtureFiles("fixtures/ledger-identity.ts", `
    const { readConfig: loadPersisted } = require("../server/config");
    const projects = loadPersisted().projects;
    function firstOwner() { projects.map((project: any) => project.repo); }
    function secondOwner() { projects.map((item: any) => item.repo); }
  `));
  const identityKeys = Object.keys(ledgerFor(ledgerIdentity));
  assert.equal(identityKeys.length, 2, "ledger keeps distinct owner/callsite/binding identities");
  assert.ok(identityKeys.some((key) => key.includes("owner=firstOwner") && key.includes("binding=project")));
  assert.ok(identityKeys.some((key) => key.includes("owner=secondOwner") && key.includes("binding=item")));

  const ordinalIdentity = analyzeFixtureSources(fixtureFiles("fixtures/ledger-ordinal.ts", `
    const { readConfig: loadPersisted } = require("../server/config");
    const project = loadPersisted().projects[0];
    function sameOwner() {
      project.repo;
      project.repo;
    }
  `));
  const ordinalKeys = Object.keys(ledgerFor(ordinalIdentity));
  assert.equal(ordinalKeys.length, 2,
    "ledger AST paths separate identical accesses with the same owner/callsite/binding/statement");
  assert.ok(ordinalKeys.every((key) => key.includes("owner=sameOwner") && key.includes("binding=project")));

  const provenance = analyzeFixtureSources(fixtureFiles("fixtures/provenance.ts", `
    import { readConfig as importedAlias } from "../server/config";
    const configNamespace = require("../server/config");
    const github = { readConfig: () => ({ projects: [{ repo: "github/response" }] }) };
    function readConfig() { return { projects: [{ repo: "transient/local" }] }; }
    importedAlias().projects[0].repo;
    configNamespace.readConfig().projects[0].working_dir;
    github.readConfig().projects[0].repo;
    readConfig().projects[0].repo;
  `));
  assert.deepEqual(provenance.map((item) => item.field).sort(), ["repo", "working_dir"],
    "actual ESM/CommonJS import aliases are tracked while unrelated same-name readers are clean");

  const exactExemptions = analyzeFixtureSources(fixtureFiles("fixtures/exemptions.ts", `
    const config = require("../server/config");
    const project = config.readConfig().projects[0];
    config.normalizeProjectRepositories(project);
    config.serializeProjectCompatibility(project);
  `, `
    function serializeProjectCompatibility(project) {
      const sameProject = project;
      primaryRepository(sameProject);
      return { repo: project.repo };
    }
    module.exports = { readConfig, normalizeProjectRepositories, migrateConfigurationToV2, primaryRepository, serializeProjectCompatibility };
  `));
  assert.deepEqual(exactExemptions, [], "only the exact config symbols with a same-flow canonical-primary call are exempt");

  const wrongFile = analyzeFixtureSources(fixtureFiles("server/other.js", `
    const { readConfig: loadPersisted, primaryRepository: canonicalPrimary } = require("./config");
    function normalizeProjectRepositories(project) { return project.repo; }
    function migrateConfigurationToV2(config) {
      const project = config.projects[0];
      delete project["repo"];
    }
    function serializeProjectCompatibility(project) {
      canonicalPrimary(project);
      return project.working_dir;
    }
    const project = loadPersisted().projects[0];
    normalizeProjectRepositories(project);
    migrateConfigurationToV2(loadPersisted());
    serializeProjectCompatibility(project);
  `));
  assert.deepEqual(wrongFile.map((item) => item.field).sort(), ["repo", "repo", "working_dir"],
    `same-named functions outside config.js are not exempt: ${JSON.stringify(wrongFile)}`);

  const shadowedPrimary = analyzeFixtureSources(fixtureFiles("fixtures/use-shadowed.js", `
    const { readConfig: loadPersisted, serializeProjectCompatibility: serialize } = require("../server/config");
    serialize(loadPersisted().projects[0]);
  `, `
    function serializeProjectCompatibility(project) {
      function primaryRepository(value) { return value.repositories[0]; }
      primaryRepository(project);
      return project.repo;
    }
    module.exports = { readConfig, normalizeProjectRepositories, migrateConfigurationToV2, primaryRepository: () => null, serializeProjectCompatibility };
  `));
  assert.equal(shadowedPrimary.length, 1, "a shadowed primaryRepository symbol cannot activate the exemption");

  const unrelatedPrimaryFlow = analyzeFixtureSources(fixtureFiles("fixtures/use-unrelated.js", `
    const { readConfig: loadPersisted, serializeProjectCompatibility: serialize } = require("../server/config");
    serialize(loadPersisted().projects[0]);
  `, `
    function serializeProjectCompatibility(project) {
      const otherProject = readConfig().projects[1];
      primaryRepository(otherProject);
      return project.repo;
    }
    module.exports = { readConfig, normalizeProjectRepositories, migrateConfigurationToV2, primaryRepository, serializeProjectCompatibility };
  `));
  assert.equal(unrelatedPrimaryFlow.length, 1, "a canonical primary call for a different persisted project flow cannot exempt the access");

  const partialPrimaryCoverage = analyzeFixtureSources(fixtureFiles("fixtures/use-partial-union.js", `
    const { readConfig: loadPersisted, serializeProjectCompatibility: serialize } = require("../server/config");
    serialize(loadPersisted().projects[0]);
  `, `
    function serializeProjectCompatibility(project) {
      const otherProject = readConfig().projects[1];
      primaryRepository(project);
      const mixedProject = project.id ? project : otherProject;
      return mixedProject.repo;
    }
    module.exports = { readConfig, normalizeProjectRepositories, migrateConfigurationToV2, primaryRepository, serializeProjectCompatibility };
  `));
  assert.equal(partialPrimaryCoverage.length, 1,
    "serializer exemption requires canonical-primary coverage for every possible project origin");

  runDiscoveryFixture();
}

// Pre-activation ownership ledger.  #1030/#1031/#1032/#1053 remove their
// entries as they migrate consumers; the activated V2 target is an empty map.
const EXPECTED_PRE_ACTIVATION_LEDGER = Object.freeze({
  "bin/quadwork.js :: owner=cmdCleanup :: call=cmdCleanup :: binding=config.projects[idx] :: repo:property :: at=b5ee77fe2c04#226:log(` Config entry: ${projectId} (${config.projects[idx]": 1,
  "bin/quadwork.js :: owner=cmdDoctor :: call=cmdDoctor :: binding=p :: working_dir:property :: at=ab866067533d#109:console.log(` project:${p.id || \"(unnamed)\"} chat_mode=$": 1,
  "server/index.js :: owner=respawnActiveBatchAgents :: call=respawnActiveBatchAgents > filter()#arg0 :: binding=p :: working_dir:property :: at=d43a64b6da2e#12:const projects = (cfg?.projects || []).filter((p) => p &": 1,
  "server/index.js :: owner=runStartupMigrations :: call=runStartupMigrations :: binding=p :: working_dir:property :: at=3acbde7514d8#296:const parentDir = path.dirname(p.working_dir);": 1,
  "server/index.js :: owner=runStartupMigrations :: call=runStartupMigrations :: binding=p :: working_dir:property :: at=76de06f21223#273:if (!p.working_dir) continue;": 1,
  "server/index.js :: owner=runStartupMigrations :: call=runStartupMigrations :: binding=p :: working_dir:property :: at=7da5876fe50f#285:const dirName = path.basename(p.working_dir);": 1,
  "server/routes.js :: owner=_performReseedWrites :: call=_performReseedWrites :: binding=project :: working_dir:property :: at=8aff8d1c3cdd#14:const workingDir = project.working_dir;": 1,
  "server/routes.js :: owner=_resolveReseedTargets :: call=_resolveReseedTargets :: binding=project :: working_dir:optional-property :: at=c3bff90e939b#9:const workingDir = project?.working_dir;": 1,
  "server/routes.js :: owner=autoReseedOnStartup :: call=autoReseedOnStartup > filter()#arg0 :: binding=p :: working_dir:property :: at=d43a64b6da2e#12:const projects = (cfg?.projects || []).filter((p) => p &": 1,
  "server/routes.js :: owner=post(\"/api/projects/:project/reseed-agents\")#arg1 :: call=post(\"/api/projects/:project/reseed-agents\")#arg1 :: binding=project :: working_dir:property :: at=8aff8d1c3cdd#142:const workingDir = project.working_dir;": 1,
  "server/routes.js :: owner=post(\"/api/rename\")#arg1 :: call=post(\"/api/rename\")#arg1 :: binding=project :: working_dir:property :: at=204b9f7500f3#77:const workDir = project.working_dir || \"\";": 1,
  "src/components/HomeDashboard.tsx :: owner=HomeDashboard :: call=HomeDashboard > map()#arg0 :: binding=project :: repo:property :: at=959278b1fae5#226:return ( <div className=\"h-full overflow-y-auto lg:overf": 1,
  "src/components/QueueManager.tsx :: owner=QueueManager :: call=QueueManager > useEffect()#arg0 > then()#arg0 :: binding=project :: repo:optional-property :: at=80cac6e2afec#32:if (project?.repo) setRepo(project.repo);": 1,
  "src/components/QueueManager.tsx :: owner=QueueManager :: call=QueueManager > useEffect()#arg0 > then()#arg0 :: binding=project :: repo:property :: at=dae063fd2fe3#39:setRepo(project.repo);": 1,
  "src/components/SettingsPage.tsx :: owner=SettingsPage :: call=SettingsPage > map()#arg0 :: binding=project :: repo:property :: at=8437f5a87eb7#202:return ( <div key={project.id} className=\"border border-": 1,
  "src/components/SettingsPage.tsx :: owner=SettingsPage :: call=SettingsPage > map()#arg0 :: binding=project :: working_dir:property :: at=8437f5a87eb7#236:return ( <div key={project.id} className=\"border border-": 1,
});

function runProductionScan() {
  const files = discoverProductionSources(ROOT);
  const sourceTextByFile = new Map(files.map((fileName) => [normalizeFileName(fileName), fs.readFileSync(fileName, "utf8")]));
  const violations = analyzeSources(sourceTextByFile, ROOT);
  const actualLedger = ledgerFor(violations);
  assert.deepEqual(
    actualLedger,
    EXPECTED_PRE_ACTIVATION_LEDGER,
    `persisted scalar project-access ledger drifted:\n${violations.map((item) =>
      `  ${violationSummary(item)} @ ${item.line}:${item.column} (${item.binding})`).join("\n")}`,
  );
  return violations.length;
}

runSelfFixtures();
const remaining = runProductionScan();
console.log(`project scalar access guard: self-fixtures pass; ${remaining} pre-activation access(es) accounted for`);
