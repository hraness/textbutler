import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

export const publicEntries = ["index", "message-bundle-v1", "message-bundle-v2", "agentic-messaging-v1", "ensoul-source-v1"] as const;

function referencesAccounts(value: string): boolean {
  if (value === "account.hraness.com") return true;
  try { return new URL(value).hostname === "account.hraness.com"; }
  catch { return false; }
}

/** Follow the actual distributed JavaScript and declaration graph. */
export async function publicGraphProblems(directory: string): Promise<string[]> {
  const pending = publicEntries.flatMap((entry) => [join(directory, `${entry}.js`), join(directory, `${entry}.d.ts`)]);
  const visited = new Set<string>();
  const problems: string[] = [];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || visited.has(next)) continue;
    const file: string = next;
    visited.add(file);
    const source = await readFile(file, "utf8");
    if (source.includes("node_modules/effect/") || source.includes("EffectPrimitive")) {
      problems.push(`${file} embeds the command runtime in a public protocol graph`);
    }
    if (source.includes("support-foundation") || source.includes("runSupportCommand")) {
      problems.push(`${file} embeds optional CLI support in a public protocol graph`);
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function dependency(specifier: string): void {
      if (specifier === "effect" || specifier.startsWith("effect/")) problems.push(`${file} exposes an Effect dependency`);
      if (!specifier.startsWith(".")) return;
      const extension = file.endsWith(".d.ts") ? ".d.ts" : ".js";
      const target = resolve(dirname(file), specifier.replace(/\.(?:ts|js)$/u, "") + extension);
      if (!target.startsWith(`${resolve(directory)}/`)) problems.push(`${file} imports outside its distribution`);
      else pending.push(target);
    }
    function visit(node: ts.Node): void {
      // Inspect URL authorities in literals, including a template's static URL prefix.
      // This rejects an Accounts dependency; it never admits a URL for navigation.
      const literal = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : undefined;
      if (literal !== undefined && referencesAccounts(literal)) problems.push(`${file} embeds optional CLI support in a public protocol graph`);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        dependency(node.moduleSpecifier.text);
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dependency(node.argument.literal.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteral(argument)) dependency(argument.text);
        else problems.push(`${file} has a non-literal dynamic import`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return [...new Set(problems)];
}
if (import.meta.main) {
  const problems = await publicGraphProblems(resolve(import.meta.dir, "..", "dist"));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
  else console.log("All five public protocol JavaScript and type graphs remain independent of Effect.");
}
