// JSON Layer: JSON Lines applied, line by line, on top of a lower value.
// Every line is plain JSON, and its top-level type says what it is, so no key
// or value inside the data is reserved:
//
//   {"instanceType": "g5.xlarge", "tags": {"team": "vision"}}
//     An object line is a static overwrite. Objects merge key by key; every
//     other value, arrays and null included, replaces what is below. Keys are
//     literal: {"a.b": 1} writes the key "a.b".
//   ["insert", "setup.commands", "pip install -e ."]
//     An array line is an operator: name, path, values. A path is a
//     dot-separated string of keys, or an array of keys when a key itself
//     contains "."; "" or [] is the whole value.
//
//   ["merge", "network.subnets", {"b": "subnet-b2"}]
//     merge is a static overwrite at a path, for nested changes.
//   // a comment, on a line of its own
//
// A document is complete on one line, with nothing after it. Array operators match by value,
// never by index, so a layer keeps its meaning when the layer below changes.
// Errors name the layer and line.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Path = string[];

export const OPERATORS = ['merge', 'replace', 'delete', 'insert', 'prepend', 'remove', 'union'] as const;
export type Operator = (typeof OPERATORS)[number];

const ARITY: Record<Operator, [min: number, max: number]> = {
  merge: [1, 1], replace: [1, 1], delete: [0, 0],
  insert: [1, Infinity], prepend: [1, Infinity], remove: [1, Infinity], union: [1, Infinity],
};

export type Line =
  | { kind: 'overwrite'; line: number; value: JsonObject }
  | { kind: 'op'; line: number; op: Operator; path: Path; args: Json[] };

export type Layer = { id: string; text: string };
export type Touch = { path: Path; layer: string; line: number };
export type Resolved = { value: JsonObject; touches: Touch[] };

export class JsonLayerError extends Error {
  constructor(readonly layer: string, readonly line: number, message: string) {
    super(`${layer}:${line}: ${message}`);
    this.name = 'JsonLayerError';
  }
}

const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Plain assignment would let a "__proto__" key from the input replace the
// object's prototype; a data property is just a key.
function put(o: JsonObject, k: string, v: Json) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function clone(v: Json): Json {
  if (Array.isArray(v)) return v.map(clone);
  if (!isObject(v)) return v;
  const out: JsonObject = {};
  for (const k of Object.keys(v)) put(out, k, clone(v[k]));
  return out;
}

function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function parsePath(path: Json): Path {
  if (Array.isArray(path)) {
    if (!path.every((k) => typeof k === 'string')) throw new Error('an array path holds only string keys');
    return path as string[];
  }
  if (typeof path !== 'string') throw new Error('a path is a dot-separated string or an array of keys');
  if (path === '') return [];
  const keys = path.split('.');
  if (keys.includes('')) throw new Error(`empty key in ${JSON.stringify(path)}; write a key containing "." as an array path`);
  return keys;
}

// Dotted when that reads back as the same keys, otherwise the array form.
export function formatPath(path: Path): string {
  return path.some((k) => k === '' || k.includes('.')) ? JSON.stringify(path) : path.join('.');
}

export function parseLayer(id: string, text: string): Line[] {
  const lines: Line[] = [];
  text.split('\n').forEach((full, i) => {
    const line = i + 1;
    const fail = (message: string): never => { throw new JsonLayerError(id, line, message); };
    const raw = full.trim();
    if (raw === '' || raw.startsWith('//')) return;
    let value: Json;
    try { value = JSON.parse(raw); } catch (e) {
      return fail(`not JSON; a document is complete on one line, and comments take a whole line: ${(e as Error).message}`);
    }
    if (isObject(value)) { lines.push({ kind: 'overwrite', line, value }); return; }
    if (!Array.isArray(value)) return fail('a line must be an object (overwrite) or an array (operator)');
    const [op, rawPath, ...args] = value;
    if (typeof op !== 'string' || !(OPERATORS as readonly string[]).includes(op)) {
      return fail(`unknown operator ${JSON.stringify(op)}; expected one of ${OPERATORS.join(', ')}`);
    }
    if (rawPath === undefined) return fail(`${op} needs a path as its second element`);
    let path: Path = [];
    try { path = parsePath(rawPath); } catch (e) { fail((e as Error).message); }
    const [min, max] = ARITY[op as Operator];
    if (args.length < min || args.length > max) {
      return fail(`${op} takes ${min === max ? min : `at least ${min}`} value${max === 1 ? '' : 's'}, got ${args.length}`);
    }
    if (op === 'merge' && !isObject(args[0])) return fail('merge takes an object');
    if (path.length === 0 && !((op === 'replace' || op === 'merge') && isObject(args[0]))) {
      return fail('only replace or merge with an object can target the whole value');
    }
    lines.push({ kind: 'op', line, op: op as Operator, path, args });
  });
  return lines;
}

// Static overwrite: objects merge key by key, anything else replaces.
function overwrite(target: JsonObject, patch: JsonObject, at: Path, touch: (path: Path) => void) {
  for (const k of Object.keys(patch)) {
    const next = patch[k];
    const current = has(target, k) ? target[k] : undefined;
    if (isObject(next) && isObject(current)) overwrite(current, next, [...at, k], touch);
    else { put(target, k, clone(next)); touch([...at, k]); }
  }
}

function apply(root: JsonObject, l: Line & { kind: 'op' }, touch: (path: Path) => void, fail: (m: string) => never) {
  const { op, path, args } = l;
  // Walk to the parent. Missing objects are created, except for delete and
  // remove, which have nothing to do when their target is already absent.
  const creates = op !== 'delete' && op !== 'remove';
  let parent = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!has(parent, k)) {
      if (!creates) return;
      put(parent, k, {});
    }
    const next = parent[k];
    if (!isObject(next)) return fail(`${formatPath(path.slice(0, i + 1))} is not an object`);
    parent = next;
  }
  const key = path[path.length - 1];
  const current = has(parent, key) ? parent[key] : undefined;

  switch (op) {
    case 'merge':
      if (!isObject(current)) { put(parent, key, {}); touch(path); }
      overwrite(parent[key] as JsonObject, args[0] as JsonObject, path, touch);
      return;
    case 'replace': put(parent, key, clone(args[0])); break;
    case 'delete': if (current === undefined) return; delete parent[key]; break;
    default: {
      if (current === undefined && op === 'remove') return;
      if (current !== undefined && !Array.isArray(current)) return fail(`${op} needs an array at ${formatPath(path)}`);
      const list = (current as Json[] | undefined) ?? [];
      const values = args.map(clone);
      let next: Json[];
      if (op === 'insert') next = [...list, ...values];
      else if (op === 'prepend') next = [...values, ...list];
      else if (op === 'remove') {
        const drop = new Set(values.map(canonical));
        next = list.filter((v) => !drop.has(canonical(v)));
      } else {
        const seen = new Set(list.map(canonical));
        next = [...list];
        for (const v of values) { const c = canonical(v); if (!seen.has(c)) { seen.add(c); next.push(v); } }
      }
      put(parent, key, next);
    }
  }
  touch(path);
}

// Applies layers in order, lowest first, to a copy of `base`. `touches`
// records each path written, in order; `explain` turns that into the line a
// final value came from.
export function resolve(base: JsonObject, layers: Layer[]): Resolved {
  let root = clone(base) as JsonObject;
  const touches: Touch[] = [];
  for (const layer of layers) {
    for (const l of parseLayer(layer.id, layer.text)) {
      const touch = (path: Path) => touches.push({ path, layer: layer.id, line: l.line });
      if (l.kind === 'overwrite') overwrite(root, l.value, [], touch);
      else if (l.path.length === 0 && l.op === 'merge') overwrite(root, l.args[0] as JsonObject, [], touch);
      else if (l.path.length === 0) { root = clone(l.args[0]) as JsonObject; touch([]); }
      else apply(root, l, touch, (m) => { throw new JsonLayerError(layer.id, l.line, m); });
    }
  }
  return { value: root, touches };
}

// The last write covering `path`: to the path itself or to an ancestor that
// replaced it. Undefined means the value comes from the base.
export function explain(touches: Touch[], path: string | Path): Touch | undefined {
  const keys = typeof path === 'string' ? parsePath(path) : path;
  for (let i = touches.length - 1; i >= 0; i--) {
    const p = touches[i].path;
    if (p.length <= keys.length && p.every((k, j) => k === keys[j])) return touches[i];
  }
  return undefined;
}
