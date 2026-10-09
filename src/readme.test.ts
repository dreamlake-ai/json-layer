import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolve, type JsonObject } from './index.js';

// Every README example is a jsonl block, optionally preceded by a json base,
// and followed by a json result or a text error.
const blocks = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').matchAll(/```(\w*)\n([\s\S]*?)```/g)]
  .map(([, lang, body]) => ({ lang, body }));

// A json block is a base only when it does not close the previous example.
const examples = blocks.flatMap((b, i) => {
  if (b.lang !== 'jsonl') return [];
  const before = blocks[i - 1];
  const isBase = before?.lang === 'json' && blocks[i - 2]?.lang !== 'jsonl';
  return [{ line: b.body.split('\n')[0], base: isBase ? (JSON.parse(before.body) as JsonObject) : {}, layer: b.body, after: blocks[i + 1] }];
});

describe('README examples', () => {
  it('has examples', () => expect(examples.length).toBeGreaterThan(15));

  it.each(examples)('$line', ({ base, layer, after }) => {
    const run = () => resolve(base, [{ id: 'L', text: layer }]).value;
    if (after?.lang === 'json') expect(run()).toEqual(JSON.parse(after.body));
    else if (after?.lang === 'text') expect(run).toThrow(after.body.trim());
    else throw new Error('example has no result');
  });
});
