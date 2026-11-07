import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scriptLiteral, themeBootstrapScript } from '../../src/lib/theme/appearance';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe('inline theme bootstrap script (CodeQL js/bad-code-sanitization)', () => {
  it('scriptLiteral escapes everything that could break out of an inline <script>', () => {
    const tricky = `</script><img src=x onerror=alert(1)>${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`;
    const literal = scriptLiteral(tricky);
    for (const unsafe of ['<', '>', LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
      assert.equal(literal.includes(unsafe), false, `literal still contains ${JSON.stringify(unsafe)}`);
    }
    assert.equal(JSON.parse(literal), tricky, 'the escaped literal still decodes to the original value');
  });

  it('scriptLiteral round-trips objects unchanged', () => {
    const value = { a: 'x</y', b: [1, 'two'], c: null };
    assert.deepEqual(JSON.parse(scriptLiteral(value)), value);
  });

  it('the bootstrap script is valid JavaScript and contains no raw closing tag', () => {
    const script = themeBootstrapScript();
    assert.doesNotThrow(() => new Function(script));
    assert.equal(script.toLowerCase().includes('</script'), false);
  });
});
