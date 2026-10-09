#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { explain, formatPath, JsonLayerError, parseLayer, resolve, type JsonObject } from './index.js';

const USAGE = `usage:
  json-layer resolve <base.json> [layer.jsonl ...] [--explain <path>]...
  json-layer check <layer.jsonl> ...

  A base of "-" is {}. Output is the resolved JSON; --explain prints
  where a path's value came from.`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const explains: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--explain') explains.push(rest[++i] ?? '');
    else files.push(rest[i]);
  }
  try {
    if (command === 'check' && files.length > 0) {
      for (const f of files) parseLayer(f, readFileSync(f, 'utf8'));
      return 0;
    }
    if (command === 'resolve' && files.length > 0) {
      const [baseFile, ...layerFiles] = files;
      const base = baseFile === '-' ? {} : (JSON.parse(readFileSync(baseFile, 'utf8')) as JsonObject);
      const { value, touches } = resolve(base, layerFiles.map((f) => ({ id: f, text: readFileSync(f, 'utf8') })));
      if (explains.length === 0) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      for (const p of explains) {
        const t = explain(touches, p);
        process.stdout.write(`${p}\t${t ? `${t.layer}:${t.line} (${formatPath(t.path) || '<root>'})` : baseFile}\n`);
      }
      return 0;
    }
  } catch (e) {
    process.stderr.write(`${e instanceof JsonLayerError ? e.message : `json-layer: ${(e as Error).message}`}\n`);
    return 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
