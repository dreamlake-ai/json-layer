import { describe, expect, it } from 'vitest';
import { explain, JsonLayerError, parseLayer, resolve, type JsonObject } from './index.js';

const run = (base: JsonObject, ...texts: string[]) =>
  resolve(base, texts.map((text, i) => ({ id: `L${i + 1}`, text })));

describe('static overwrite', () => {
  it('merges objects key by key and replaces everything else', () => {
    const base = { region: 'us-east-1', tags: { team: 'a', cost: 'x' }, sgs: ['sg-1'], disk: 100 };
    const { value } = run(base, '{"tags": {"team": "b"}, "sgs": ["sg-2"], "disk": null}');
    expect(value).toEqual({ region: 'us-east-1', tags: { team: 'b', cost: 'x' }, sgs: ['sg-2'], disk: null });
    expect(base.tags.team).toBe('a');
  });

  it('applies lines in order and ignores blank lines', () => {
    expect(run({}, '{"a": 1}\n\n{"a": 2, "b": 3}\r\n["delete", "b"]\n').value).toEqual({ a: 2 });
  });
});

describe('operators', () => {
  it('inserts into an array, creating it and its parents when absent', () => {
    expect(run({}, '["insert", "someKey", "hey hey"]').value).toEqual({ someKey: ['hey hey'] });
    expect(run({ k: ['a'] }, '["insert", "k", "b", "c"]').value).toEqual({ k: ['a', 'b', 'c'] });
    expect(run({ k: ['a'] }, '["prepend", "k", "z"]').value).toEqual({ k: ['z', 'a'] });
    expect(run({}, '["insert", "a.b", 1]').value).toEqual({ a: { b: [1] } });
  });

  it('removes and unions by value, including objects regardless of key order', () => {
    const base = { k: ['a', { x: 1, y: 2 }, 'a', 'b'] };
    expect(run(base, '["remove", "k", "a", {"y": 2, "x": 1}]').value).toEqual({ k: ['b'] });
    expect(run(base, '["union", "k", "b", "c", "c"]').value).toEqual({ k: ['a', { x: 1, y: 2 }, 'a', 'b', 'c'] });
  });

  it('deletes and replaces, and leaves a missing target alone for delete and remove', () => {
    const base = { tags: { a: '1', b: '2' }, gone: 1 };
    const layer = ['["replace", "tags", {"c": "3"}]', '["delete", "gone"]', '["delete", "x.y"]', '["remove", "list", 1]'];
    expect(run(base, layer.join('\n')).value).toEqual({ tags: { c: '3' } });
  });

  it('replaces the whole value with an empty path', () => {
    expect(run({ a: 1 }, '["replace", "", {"b": 2}]').value).toEqual({ b: 2 });
  });

  it('addresses keys by dotted path, or by array path when a key contains "."', () => {
    expect(run({}, '["replace", "a.b.c", 1]').value).toEqual({ a: { b: { c: 1 } } });
    expect(run({}, '["replace", ["a.b", "c"], 1]').value).toEqual({ 'a.b': { c: 1 } });
    expect(run({}, '{"a.b": 1}').value).toEqual({ 'a.b': 1 });
  });

  it('treats operator-like strings and $-keys as data', () => {
    expect(run({}, '{"$insert": ["x"], "k": "[\\"delete\\"]"}').value).toEqual({ $insert: ['x'], k: '["delete"]' });
  });

  it('keeps meaning when the layer below changes', () => {
    const layer = '["union", "sgs", "sg-team"]\n{"tags": {"owner": "ge"}}';
    expect(run({ sgs: ['sg-base'] }, layer).value).toEqual({ sgs: ['sg-base', 'sg-team'], tags: { owner: 'ge' } });
    expect(run({ sgs: ['sg-new', 'sg-team'], tags: { env: 'p' } }, layer).value)
      .toEqual({ sgs: ['sg-new', 'sg-team'], tags: { env: 'p', owner: 'ge' } });
  });

  it('does not let a __proto__ key reach the prototype', () => {
    const { value } = run({}, '{"__proto__": {"polluted": true}}\n["insert", "__proto__.list", 1]');
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe('large nested changes', () => {
  const base = { network: { vpc: 'vpc-1', subnets: { a: 'subnet-a', b: 'subnet-b' }, sgs: ['sg-1'] }, disk: 100 };

  it('merges an object at a dotted path, keeping what it does not mention', () => {
    const { value } = run(base, '["merge", "network.subnets", {"b": "subnet-b2", "c": {"id": "subnet-c"}}]');
    expect(value.network).toEqual({ vpc: 'vpc-1', subnets: { a: 'subnet-a', b: 'subnet-b2', c: { id: 'subnet-c' } }, sgs: ['sg-1'] });
  });

  it('creates the path, and replaces a non-object, when merging', () => {
    expect(run({ a: { b: 1 } }, '["merge", "a.b", {"c": 1}]').value).toEqual({ a: { b: { c: 1 } } });
    expect(run({}, '["merge", "a.b", {"c": 1}]').value).toEqual({ a: { b: { c: 1 } } });
    expect(() => run({ a: 1 }, '["merge", "a.b", {"c": 1}]')).toThrow('L1:1: a is not an object');
    expect(run({}, '["merge", "", {"c": 1}]').value).toEqual({ c: 1 });
  });

  it('ignores comment lines, and keeps "//" inside strings as data', () => {
    const layer = [
      '// network for the vision team',
      '  // keeps subnet b',
      '["merge", "network", {"subnets": {"a": "subnet-a2"}, "url": "https://x//y"}]',
      '',
      '["union", "network.sgs", "sg-2"]',
    ].join('\n');
    const { value, touches } = run(base, layer);
    expect(value).toEqual({
      network: { vpc: 'vpc-1', subnets: { a: 'subnet-a2', b: 'subnet-b' }, sgs: ['sg-1', 'sg-2'], url: 'https://x//y' },
      disk: 100,
    });
    expect(explain(touches, 'network.subnets.a')).toMatchObject({ line: 3 });
    expect(explain(touches, 'network.sgs')).toMatchObject({ line: 5 });
  });

  it('rejects a document spanning lines, a trailing comment, and two documents on a line', () => {
    expect(() => parseLayer('L1', '{"a": 1}\n["merge", "a", {\n  "b": 1}]')).toThrow('L1:2: not JSON');
    expect(() => parseLayer('L1', '{"a": 1} // why')).toThrow('L1:1: not JSON');
    expect(() => parseLayer('L1', '{"a": 1} {"b": 2}')).toThrow('L1:1: not JSON');
  });
});

describe('provenance', () => {
  it('names the layer and line that produced each value', () => {
    const { touches } = run({ region: 'us-east-1', tags: { a: '1' } },
      '{"type": "t3"}',
      '{"type": "g5"}\n["replace", "tags", {"b": "2"}]');
    expect(explain(touches, 'type')).toMatchObject({ layer: 'L2', line: 1 });
    expect(explain(touches, 'tags.b')).toMatchObject({ layer: 'L2', line: 2 });
    expect(explain(touches, 'region')).toBeUndefined();
  });
});

describe('errors', () => {
  it.each([
    ['{"a": 1', 'complete on one line'],
    ['# c', 'not JSON'],
    ['/* c */ {"a": 1}', 'not JSON'],
    ['"text"', 'must be an object'],
    ['["insrt", "a", 1]', 'unknown operator "insrt"'],
    ['["insert"]', 'needs a path'],
    ['["insert", 3, 1]', 'dot-separated string'],
    ['["insert", ["a", 1], 1]', 'only string keys'],
    ['["insert", "a..b", 1]', 'empty key'],
    ['["insert", "a"]', 'at least 1'],
    ['["delete", "a", 1]', 'takes 0'],
    ['["insert", "", 1]', 'whole value'],
    ['["replace", "", [1]]', 'whole value'],
    ['["merge", "a", [1]]', 'merge takes an object'],
    ['{"a": 1} x', 'not JSON'],
  ])('rejects %s', (text, message) => {
    const doc = `{"ok": 1}\n${text}`;
    expect(() => parseLayer('L1', doc)).toThrow(JsonLayerError);
    expect(() => parseLayer('L1', doc)).toThrow(`L1:2: `);
    expect(() => parseLayer('L1', doc)).toThrow(message);
  });

  it('rejects type mismatches against the layer below, at the line', () => {
    expect(() => run({ k: 'x' }, '\n["insert", "k", 1]')).toThrow('L1:2: insert needs an array at k');
    expect(() => run({ k: 'x' }, '["replace", "k.j", 1]')).toThrow('L1:1: k is not an object');
  });
});
