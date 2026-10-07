import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFieldMeta, groupFields, type FieldMetaOverlay } from '../src/index.ts';

const overlay: FieldMetaOverlay = {
  '#/outbound/*/server': { label: 'Server', order: 1, group: 'Basic' },
  '#/outbound/vless/uuid': { label: 'UUID', secret: true, group: 'Basic', order: 2 },
  '#/outbound/*/*/path': { label: 'Path' },
};

test('an exact entry wins over a wildcard one', () => {
  assert.equal(resolveFieldMeta(overlay, '#/outbound/vless/uuid').label, 'UUID');
  assert.equal(resolveFieldMeta(overlay, '#/outbound/vless/uuid').matchedBy, '#/outbound/vless/uuid');
});

test('a wildcard entry labels every protocol at once', () => {
  assert.equal(resolveFieldMeta(overlay, '#/outbound/trojan/server').label, 'Server');
  assert.equal(resolveFieldMeta(overlay, '#/outbound/hysteria2/server').label, 'Server');
});

test('a field nobody has described resolves to nothing rather than undefined', () => {
  // This is the property the whole approach rests on: a protocol released this morning still
  // renders, with its raw schema key as the label.
  const meta = resolveFieldMeta(overlay, '#/outbound/something-new/obscure_option');
  assert.equal(meta.matchedBy, null);
  assert.equal(meta.label, undefined);
});

test('pointer depth must match, so a wildcard does not swallow a deeper field', () => {
  assert.equal(resolveFieldMeta(overlay, '#/outbound/vless/transport/path').label, 'Path');
  assert.equal(resolveFieldMeta(overlay, '#/outbound/vless/transport/headers/host').matchedBy, null);
});

test('grouping puts described fields in their group and the rest in the fallback', () => {
  const groups = groupFields(
    [{ pointer: '#/outbound/vless/uuid' }, { pointer: '#/outbound/vless/server' }, { pointer: '#/outbound/vless/flow' }],
    overlay,
  );
  const basic = groups.find((group) => group.group === 'Basic')!;
  assert.deepEqual(
    basic.fields.map((field) => field.meta.label),
    ['Server', 'UUID'],
  );
  const advanced = groups.find((group) => group.group === 'Advanced')!;
  assert.deepEqual(
    advanced.fields.map((field) => field.pointer),
    ['#/outbound/vless/flow'],
  );
});
