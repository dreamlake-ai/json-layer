# @dreamlake/json-layer

Layer JSON changes on top of JSON. One change per line.

```sh
npm install @dreamlake/json-layer
```

```ts
import { resolve, explain } from '@dreamlake/json-layer';

const { value, touches } = resolve(base, [
  { id: 'provider', text: providerLayer },
  { id: 'team', text: teamLayer },
]);
explain(touches, 'network.subnets.b'); // { layer: 'team', line: 3, path: [...] }
```

Every example below is a base, a layer, and the result. They run as tests.

## Overwrite

An object line merges objects and replaces everything else.

```json
{"type": "t3.large", "tags": {"team": "a", "cost": "x"}, "groups": ["sg-1"], "disk": 100}
```

```jsonl
{"type": "g5.xlarge", "tags": {"team": "b"}, "groups": ["sg-2"], "disk": null}
```

```json
{"type": "g5.xlarge", "tags": {"team": "b", "cost": "x"}, "groups": ["sg-2"], "disk": null}
```

Lines apply in order.

```json
{}
```

```jsonl
{"a": 1}
{"a": 2, "b": 3}
```

```json
{"a": 2, "b": 3}
```

## Operators

`[operator, path, ...values]`

### insert

```json
{"setup": ["apt update"]}
```

```jsonl
["insert", "setup", "pip install -e .", "make"]
["insert", "env.paths", "/opt/bin"]
```

```json
{"setup": ["apt update", "pip install -e .", "make"], "env": {"paths": ["/opt/bin"]}}
```

### prepend

```json
{"setup": ["make"]}
```

```jsonl
["prepend", "setup", "apt update"]
```

```json
{"setup": ["apt update", "make"]}
```

### union

```json
{"groups": ["sg-1", "sg-2"]}
```

```jsonl
["union", "groups", "sg-2", "sg-3"]
```

```json
{"groups": ["sg-1", "sg-2", "sg-3"]}
```

### remove

```json
{"groups": ["sg-1", "sg-2", "sg-1"], "mounts": [{"src": "/a", "dst": "/b"}, {"src": "/c", "dst": "/d"}]}
```

```jsonl
["remove", "groups", "sg-1"]
["remove", "mounts", {"dst": "/b", "src": "/a"}]
```

```json
{"groups": ["sg-2"], "mounts": [{"src": "/c", "dst": "/d"}]}
```

### delete

```json
{"tags": {"team": "a", "scratch": "yes"}}
```

```jsonl
["delete", "tags.scratch"]
["delete", "tags.missing"]
```

```json
{"tags": {"team": "a"}}
```

### replace

```json
{"tags": {"team": "a", "cost": "x"}}
```

```jsonl
["replace", "tags", {"team": "b"}]
```

```json
{"tags": {"team": "b"}}
```

### merge

```json
{"network": {"vpc": "vpc-1", "subnets": {"a": "subnet-a", "b": "subnet-b"}}}
```

```jsonl
["merge", "network.subnets", {"b": "subnet-b2", "c": {"id": "subnet-c"}}]
```

```json
{"network": {"vpc": "vpc-1", "subnets": {"a": "subnet-a", "b": "subnet-b2", "c": {"id": "subnet-c"}}}}
```

### whole value

```json
{"a": 1}
```

```jsonl
["replace", "", {"b": 2}]
["merge", "", {"c": 3}]
```

```json
{"b": 2, "c": 3}
```

## Paths

```json
{}
```

```jsonl
["replace", "a.b.c", 1]
["replace", ["x.y", "z"], 2]
{"p.q": 3}
```

```json
{"a": {"b": {"c": 1}}, "x.y": {"z": 2}, "p.q": 3}
```

## Comments

```json
{"groups": []}
```

```jsonl
// whole lines only

  // indented is fine
["insert", "groups", "sg-1"]
{"url": "https://example.com//kept"}
```

```json
{"groups": ["sg-1"], "url": "https://example.com//kept"}
```

## Nothing is reserved

```json
{}
```

```jsonl
{"$insert": ["x"], "note": "[\"delete\", \"a\"]"}
```

```json
{"$insert": ["x"], "note": "[\"delete\", \"a\"]"}
```

## Errors

```jsonl
{"a": 1}
["insrt", "a", 1]
```

```text
L:2: unknown operator "insrt"
```

```jsonl
{"a": 1} // no trailing comments
```

```text
L:1: not JSON
```

```jsonl
["merge", "a", {
  "b": 1}]
```

```text
L:1: not JSON
```

```json
{"tags": "none"}
```

```jsonl
["insert", "tags", "x"]
```

```text
L:1: insert needs an array at tags
```

## CLI

```sh
json-layer resolve base.json provider.jsonl team.jsonl
json-layer resolve base.json provider.jsonl team.jsonl --explain network.subnets.b
# network.subnets.b	team.jsonl:3 (network.subnets.b)
json-layer check team.jsonl
```

## Reference

| Line | Effect |
|---|---|
| `{...}` | merge objects, replace the rest |
| `["merge", p, {...}]` | the same, at `p` |
| `["replace", p, v]` | set `p` to `v` |
| `["delete", p]` | remove `p` if present |
| `["insert", p, v...]` | append to array |
| `["prepend", p, v...]` | add to array front |
| `["union", p, v...]` | append values not present |
| `["remove", p, v...]` | remove equal values |
| `// ...` | comment, whole line |

- `p`: `"a.b.c"`, or `["a.b", "c"]` when a key has a dot; `""` is the whole value.
- Missing parents are created, except by `delete` and `remove`.
- Arrays match by value, never index.
- One document per line.
- Comment lines make a layer non-strict JSON Lines.

## License

MIT
