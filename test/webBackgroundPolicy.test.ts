import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import ts from 'typescript';

it('官网输出在遮挡时仍需更新；后台策略只在两个官网视图配置，不扩大为全局开关', () => {
  for (const [file, owner] of [['index.ts', 'webPagePreferences'], ['webPlatformView.ts', 'webPreferences']]) {
    const source = ts.createSourceFile(file, readFileSync(path.join(__dirname, '../src/main', file), 'utf8'), ts.ScriptTarget.Latest, true);
    const policies: Array<{ owner: string; value: ts.SyntaxKind }> = [];
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'backgroundThrottling') {
        const declaration = node.parent.parent;
        policies.push({ owner: ts.isVariableDeclaration(declaration) ? declaration.name.getText(source) : '', value: node.initializer.kind });
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.commandLine.appendSwitch') {
        assert.ok(!node.arguments.some(argument => ts.isStringLiteral(argument) && /background|occluded/.test(argument.text)));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.deepEqual(policies, [{ owner, value: ts.SyntaxKind.FalseKeyword }]);
  }
});
