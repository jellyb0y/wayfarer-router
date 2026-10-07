/**
 * The draft store's pure half.
 *
 * These are the parts where being wrong is silent: a pending count that is wrong makes somebody apply
 * a change they did not know about, and a write body that is wrong blanks a credential.
 */

import { describe, expect, it } from 'vitest';
import { pendingChanges, readAt, toWriteBody, writeAt } from './draft.ts';

describe('pending changes', () => {
  it('reports nothing when the draft matches the baseline', () => {
    const document = { meta: { name: 'x' }, uplinks: [] };
    expect(pendingChanges(document, structuredClone(document))).toEqual([]);
  });

  it('reports a value edited and edited back as nothing pending', () => {
    // Compared structurally rather than counted. A counter would say one change, and the bar's number
    // is what somebody uses to decide whether to press Review.
    const baseline = { meta: { name: 'x' } };
    const draft = { meta: { name: 'x' } };
    expect(pendingChanges(baseline, draft)).toEqual([]);
  });

  it('names the pointer that changed', () => {
    const changes = pendingChanges({ meta: { name: 'x' } }, { meta: { name: 'y' } });
    expect(changes).toEqual([{ pointer: '/meta/name', from: 'x', to: 'y' }]);
  });

  it('never puts a secret value in a change description', () => {
    // The draft holds `{ $set: … }` or a literal the operator just typed. Printing either in the diff
    // would defeat the redaction the read path performs.
    const changes = pendingChanges(
      { accessPoint: { passphrase: { $set: true } } },
      { accessPoint: { passphrase: 'a-real-passphrase' } },
    );
    expect(changes).toEqual([{ pointer: '/accessPoint/passphrase', from: 'set', to: 'a new value' }]);
    expect(JSON.stringify(changes)).not.toContain('a-real-passphrase');
  });

  it('summarises a list whose length changed rather than diffing every element', () => {
    const changes = pendingChanges({ uplinks: [] }, { uplinks: [{ id: 'a' }] });
    expect(changes).toEqual([{ pointer: '/uplinks', from: '0 entries', to: '1 entries' }]);
  });

  it('descends into a list whose length is unchanged', () => {
    const changes = pendingChanges({ uplinks: [{ id: 'a' }] }, { uplinks: [{ id: 'b' }] });
    expect(changes).toEqual([{ pointer: '/uplinks/0/id', from: 'a', to: 'b' }]);
  });
});

describe('the write body', () => {
  it('turns every untouched secret into $keep', () => {
    // Without this, a save of an unrelated field sends `{ $set: true }` — which the API refuses, and
    // which would otherwise overwrite the stored value with a marker meaning "something is stored".
    const body = toWriteBody({
      accessPoint: { passphrase: { $set: true }, ssid: 'x' },
      uplinks: [{ config: { psk: { $set: false } } }],
    });
    expect(body).toEqual({
      accessPoint: { passphrase: { $keep: true }, ssid: 'x' },
      uplinks: [{ config: { psk: { $keep: true } } }],
    });
  });

  it('leaves a value the operator typed alone', () => {
    const body = toWriteBody({ accessPoint: { passphrase: 'typed' } });
    expect(body).toEqual({ accessPoint: { passphrase: 'typed' } });
  });

  it('keeps a redaction marker, so an unfilled gap stays visible', () => {
    // An access point with an empty passphrase is an open network, so the gap has to survive a save.
    const body = toWriteBody({ accessPoint: { passphrase: { $redacted: 'psk' } } });
    expect(body).toEqual({ accessPoint: { passphrase: { $redacted: 'psk' } } });
  });
});

describe('pointers', () => {
  it('reads and writes nested values', () => {
    const document: Record<string, unknown> = { a: { b: 1 } };
    expect(readAt(document, '/a/b')).toBe(1);
    writeAt(document, '/a/b', 2);
    expect(readAt(document, '/a/b')).toBe(2);
  });

  it('creates intermediate objects but never arrays', () => {
    // Growing an array by writing past its end produces holes, and a document with a hole in `uplinks`
    // fails validation with a message pointing at the wrong thing. Adding to a list is its own action.
    const document: Record<string, unknown> = {};
    writeAt(document, '/a/b/c', 1);
    expect(document).toEqual({ a: { b: { c: 1 } } });

    const withList: Record<string, unknown> = { uplinks: [] };
    writeAt(withList, '/uplinks/3/id', 'x');
    expect(withList).toEqual({ uplinks: [] });
  });

  it('writes into an element that exists', () => {
    const document: Record<string, unknown> = { uplinks: [{ id: 'a' }] };
    writeAt(document, '/uplinks/0/id', 'b');
    expect(readAt(document, '/uplinks/0/id')).toBe('b');
  });

  it('removes a key when the value is undefined', () => {
    const document: Record<string, unknown> = { a: { b: 1 } };
    writeAt(document, '/a/b', undefined);
    expect(document).toEqual({ a: {} });
  });
});

/*
 * `deriveLabel` was tested here — turning a schema key into words without pretending to explain it.
 * It belonged to the generated form and is deleted with it. No label in this interface is derived
 * from anything any more: every one of them was written for the field it names.
 */
