// generate-go-topology.mjs — generates the Go mirror of the TypeScript
// topology module.
//
//   node scripts/generate-go-topology.mjs   (from the repo root)
//
// Source: packages/contracts/src/topology.ts (the single source of truth
// for every name the services agree on: exchanges, routing keys, queues,
// Redis key builders, TTLs, SSE event types).
// Output: services/ingress/internal/topology/topology.go (package topology).
//
// The Go ai service gets no generated file: it uses no broker or Redis
// names, so a topology.go there would be dead code.
//
// Rules:
// - No hand-copying: every name in the output comes from the TS source.
//   If the source gains an export this script cannot classify (a new
//   shape), the script exits non-zero and names it — a silent drop
//   would let the two sides drift apart again.
// - String consts keep their exact TS name (EVENTS_EXCHANGE, ...).
//   Builder functions are PascalCased (incomingRoutingKey ->
//   IncomingRoutingKey). TS `string | number` params become Go `string`
//   (callers convert ints); an optional `slot?: string` becomes a plain
//   Go `string` where "" means absent.
// - The one non-template builder, telegramSessionKey (a ternary on
//   DEFAULT_SLOT), is special-cased by name.
// - Output is deterministic: source order, no timestamps. Run it twice
//   and diff to prove it.
//
// No dependencies — plain Node (node:fs, node:path, node:url).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'packages/contracts/src/topology.ts');
const OUT = path.join(ROOT, 'services/ingress/internal/topology/topology.go');

const src = readFileSync(SRC, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** camelCase -> PascalCase; UPPER_SNAKE -> PascalCase per segment.
 * An all-caps single word (MESSAGE, QR) title-cases too, so the SSE
 * consts read SSEEventTypeMessage, not SSEEventTypeMESSAGE. */
function pascalCase(name) {
  const segments = name.split('_');
  if (segments.length > 1 || /^[A-Z0-9]+$/.test(name)) {
    return segments
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join('');
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A TS template literal body -> a Go string expression. */
function templateToGo(template) {
  const parts = template.split(/(\$\{[^}]+\})/g).filter(Boolean);
  return parts
    .map((p) => {
      const m = p.match(/^\$\{([^}]+)\}$/);
      return m ? m[1].trim() : JSON.stringify(p);
    })
    .join(' + ');
}

/** A JSDoc block -> Go `//` lines. `{@link X}` becomes `X`. */
function jsdocToGoLines(comment) {
  if (!comment) return [];
  const inner = comment
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/\s*$/, '');
  return inner
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').replace(/\{@link\s+([^}]+)\}/g, '$1').trimEnd())
    .filter((line) => line.length > 0);
}

/** The JSDoc block immediately preceding `index` in the source, if any.
 * The pattern cannot cross a `*\/`, so it finds the LAST JSDoc block
 * before the item — never the file header or an earlier item's doc. */
function precedingJsdoc(index) {
  const before = src.slice(0, index);
  const m = before.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*$/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Parse: every `export const` in source order
// ---------------------------------------------------------------------------

const items = []; // { kind, name, ... } in source order

// String + number consts: export const NAME = '...' | 123;
for (const m of src.matchAll(/export const ([A-Z][A-Z0-9_]*) = ('[^']*'|\d+);/g)) {
  const [, name, value] = m;
  items.push({
    kind: value.startsWith("'") ? 'strconst' : 'numconst',
    name,
    value: value.startsWith("'") ? value.slice(1, -1) : value,
    index: m.index,
    jsdoc: precedingJsdoc(m.index),
  });
}

// Builder functions: export const name = (params): string => body;
for (const m of src.matchAll(
  /export const (\w+) = \(([\s\S]*?)\)(?:: string)? =>\s*(`[^`]*`|[^;]+);/g,
)) {
  const [, name, paramStr, body] = m;
  // Skip the consts above (they have no parens, so they never match) and
  // the SSE object (its body is `{...}`, not a template/ternary).
  if (name === 'SSE_EVENT_TYPES') continue;
  const params = paramStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const pm = p.match(/^(\w+)\??:\s*(.+)$/);
      if (!pm) throw new Error(`cannot parse param ${JSON.stringify(p)} in ${name}`);
      return { name: pm[1], tsType: pm[2].trim() };
    });
  items.push({
    kind: 'func',
    name,
    params,
    body: body.trim(),
    index: m.index,
    jsdoc: precedingJsdoc(m.index),
  });
}

// SSE event types: export const SSE_EVENT_TYPES = { KEY: 'value', ... } as const;
const sseMatch = src.match(/export const SSE_EVENT_TYPES = \{([\s\S]*?)\} as const;/);
if (!sseMatch) throw new Error('SSE_EVENT_TYPES not found in topology.ts');
const sseBody = sseMatch[1];
const sseEntries = [];
for (const m of sseBody.matchAll(/(\w+):\s*'([^']*)',/g)) {
  const [, key, value] = m;
  sseEntries.push({ key, value, jsdoc: precedingJsdoc(sseMatch.index + sseBody.indexOf(m[0])) });
}
items.push({ kind: 'sse', index: sseMatch.index });

// Sort by source position so the output follows the TS file's sections.
items.sort((a, b) => a.index - b.index);

// Drift guard: every `export const` in the source must be emitted.
const exported = [...src.matchAll(/export const (\w+)/g)].map((m) => m[1]);
const emitted = new Set(items.filter((i) => i.kind !== 'sse').map((i) => i.name));
emitted.add('SSE_EVENT_TYPES');
const missing = exported.filter((n) => !emitted.has(n));
if (missing.length > 0) {
  throw new Error(
    `cannot generate Go for these topology.ts exports (unsupported shape): ${missing.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

// Section headers come from the TS file itself: each item belongs to
// the most recent `// ---...--- // Title // ---...---` block before it,
// so the generated file carries the same structure as the source.
const sectionHeads = [];
for (const m of src.matchAll(/\/\/ -+\n\/\/ (.+)\n\/\/ -+/g)) {
  let title = m[1].trim();
  if (title.startsWith('SSE event types')) title = 'SSE event types';
  sectionHeads.push({ index: m.index, title });
}
function sectionFor(item) {
  let title = 'Topology';
  for (const h of sectionHeads) {
    if (h.index < item.index) title = h.title;
    else break;
  }
  return title;
}

let lastSection = '';
const out = [];
out.push('// Code generated by scripts/generate-go-topology.mjs from');
out.push('// packages/contracts/src/topology.ts. DO NOT EDIT.');
out.push('// Regenerate: node scripts/generate-go-topology.mjs (from the repo root).');
out.push('//');
out.push('// The TypeScript module is the single source of truth for every');
out.push('// name the services agree on over the wire: RabbitMQ exchanges /');
out.push('// routing keys / queues, Redis key builders, TTLs, and SSE event');
out.push('// types. This file is its Go mirror for the ingress service, so a');
out.push('// rename lands in both languages from one edit. The Go ai service');
out.push('// has no generated file: it uses no broker or Redis names.');
out.push('//');
out.push('// Naming: string consts keep their exact TS name (EVENTS_EXCHANGE);');
out.push('// builder functions are PascalCased (incomingRoutingKey ->');
out.push('// IncomingRoutingKey). TS `string | number` params become Go');
out.push('// `string` (callers convert ints); an optional `slot?: string`');
out.push('// becomes a plain Go `string` where "" means absent.');
out.push('package topology');
out.push('');

for (const item of items) {
  const section = sectionFor(item);
  if (section !== lastSection) {
    out.push('// ---------------------------------------------------------------------------');
    out.push(`// ${section}`);
    out.push('// ---------------------------------------------------------------------------');
    out.push('');
    lastSection = section;
  }

  const docLines = jsdocToGoLines(item.jsdoc);
  const fallbackDoc = (goName) => `// ${goName} mirrors ${item.name} in topology.ts.`;
  if (item.kind === 'strconst') {
    if (docLines.length > 0) for (const l of docLines) out.push(`// ${l}`);
    else out.push(fallbackDoc(item.name));
    out.push(`const ${item.name} = ${JSON.stringify(item.value)}`);
    out.push('');
  } else if (item.kind === 'numconst') {
    if (docLines.length > 0) for (const l of docLines) out.push(`// ${l}`);
    else out.push(fallbackDoc(item.name));
    out.push(`const ${item.name} = ${item.value}`);
    out.push('');
  } else if (item.kind === 'func') {
    const goName = pascalCase(item.name);
    const goParams = item.params.map((p) => `${p.name} string`).join(', ');
    if (docLines.length > 0) for (const l of docLines) out.push(`// ${l}`);
    else out.push(fallbackDoc(goName));
    if (item.name === 'telegramSessionKey') {
      // The one non-template builder: a ternary on DEFAULT_SLOT.
      // TS: slot && slot !== DEFAULT_SLOT ? `tg:${id}:${slot}` : `tg:${id}`
      out.push(`// ${goName} mirrors telegramSessionKey in topology.ts: the`);
      out.push('// DEFAULT slot omits the slot suffix, non-default slots');
      out.push('// carry it. An empty slot behaves like the default.');
      out.push(`func ${goName}(${goParams}) string {`);
      out.push('\tif slot != "" && slot != DEFAULT_SLOT {');
      out.push('\t\treturn "tg:" + clientId + ":" + slot');
      out.push('\t}');
      out.push('\treturn "tg:" + clientId');
      out.push('}');
    } else if (item.body.startsWith('`')) {
      out.push(`func ${goName}(${goParams}) string {`);
      out.push(`\treturn ${templateToGo(item.body.slice(1, -1))}`);
      out.push('}');
    } else {
      throw new Error(`unsupported body shape for ${item.name}: ${item.body}`);
    }
    out.push('');
  } else if (item.kind === 'sse') {
    for (const e of sseEntries) {
      const docLines2 = jsdocToGoLines(e.jsdoc);
      const goName = `SSEEventType${pascalCase(e.key)}`;
      if (docLines2.length > 0) for (const l of docLines2) out.push(`// ${l}`);
      else out.push(`// ${goName} mirrors SSE_EVENT_TYPES.${e.key} in topology.ts.`);
      out.push(`const ${goName} = ${JSON.stringify(e.value)}`);
      out.push('');
    }
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, out.join('\n'));
console.log(`wrote ${path.relative(ROOT, OUT)} (${items.length} items, ${sseEntries.length} SSE types)`);
