'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

const root = path.resolve(__dirname, '../..');
registerTypescript(root);
const { AI_FEATURE_POLICIES } = require('../../src/lib/ai-execution-policy.ts');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return /\.tsx?$/.test(entry.name) ? [filename] : [];
  });
}

describe('AI call-site contract', () => {
  it('routes every server Gemini call through the unified attributed wrapper', () => {
    const violations = [];
    let wrapperCalls = 0;
    for (const filename of sourceFiles(path.join(root, 'src'))) {
      const source = fs.readFileSync(filename, 'utf8');
      const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      const at = node => `${path.relative(root, filename)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['generateWithFallback', 'generateStreamWithFallback'].includes(node.expression.text)) {
          wrapperCalls += 1;
          if (node.arguments.length !== 3) violations.push(`${at(node)} does not provide an AI context`);
          const context = node.arguments[2];
          const featureProperty = context && ts.isObjectLiteralExpression(context)
            ? context.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(sf) === 'feature')
            : null;
          const feature = featureProperty && ts.isStringLiteral(featureProperty.initializer) ? featureProperty.initializer.text : null;
          if (!feature || !Object.hasOwn(AI_FEATURE_POLICIES, feature)) violations.push(`${at(node)} has no registered literal feature`);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^generateContent(Stream)?$/.test(node.expression.name.text) && !filename.endsWith(path.join('src', 'lib', 'ai.ts'))) {
          violations.push(`${at(node)} bypasses the unified AI wrapper`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    assert.ok(wrapperCalls >= 48, `expected the full LifeOS AI surface, found ${wrapperCalls} calls`);
    assert.deepEqual(violations, []);
  });
});
