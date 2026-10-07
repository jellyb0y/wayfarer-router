/**
 * The two guards the coverage manifest rests on, asserted against the shapes that defeated them.
 *
 * Both were green on the defect. Neither test is written from the code: each is the mutation that
 * was actually performed on the interface, reduced to the markup or the file sequence that produced
 * it, so that running it reproduces the failure rather than restating the fix.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useState } from 'react';

import { changedPointers, harvestScreen, normalisePointer } from './harvest.ts';
import { actualPath, compareManifest, type Manifest } from './manifest.ts';

const click = (node: Element): void => {
  fireEvent.click(node);
};

describe('a pointer counts when a person can supply the value, not when it was stamped', () => {
  it('counts a block holding an enabled control', () => {
    const { container } = render(
      <div className="field-block" data-pointer="/uplinks/0/config/psk">
        <label>
          <span className="field-label">Passphrase</span>
          <input type="password" />
        </label>
      </div>,
    );
    expect(harvestScreen(container, { click })).toEqual({ pointers: ['/uplinks/-/config/psk'], inert: [] });
  });

  /**
   * **The substitution that was green.** The pointer is in the DOM, the label is on the screen, and
   * there is nothing to type into. Deleting the same block fails loudly; turning it into a caption
   * used to fail nothing at all.
   */
  it('does not count a pointer whose control has become a caption', () => {
    const { container } = render(
      <div className="field-block" data-pointer="/uplinks/0/config/psk">
        <span className="field-label">Passphrase</span>
      </div>,
    );
    expect(harvestScreen(container, { click })).toEqual({ pointers: [], inert: ['/uplinks/-/config/psk'] });
  });

  it('does not count a control that is disabled, read-only or out of the tab order', () => {
    const { container } = render(
      <>
        <div data-pointer="/a">
          <input disabled />
        </div>
        <div data-pointer="/b">
          <input readOnly />
        </div>
        <div data-pointer="/c">
          <input tabIndex={-1} />
        </div>
        <div data-pointer="/d">
          <input aria-disabled="true" />
        </div>
      </>,
    );
    expect(harvestScreen(container, { click }).pointers).toEqual([]);
  });

  /**
   * A credential the device already holds. The control is real and it is one tap away, which is the
   * case a gate that only looks at the current DOM gets wrong in the direction that matters: five
   * required positions would be reported as unreachable, and a false red is answered by weakening.
   */
  it('counts a control that a tap reveals, and not a button that reveals nothing', () => {
    function Reveals(): React.ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <div data-pointer="/accessPoint/passphrase">
          {open ? <input type="password" /> : <button type="button" onClick={() => setOpen(true)}>Replace</button>}
        </div>
      );
    }
    const { container } = render(
      <>
        <Reveals />
        <div data-pointer="/accessPoint/ssid">
          <button type="button">Passphrase</button>
        </div>
      </>,
    );
    expect(harvestScreen(container, { click })).toEqual({
      pointers: ['/accessPoint/passphrase'],
      inert: ['/accessPoint/ssid'],
    });
  });

  /**
   * The add control: three buttons, each writing a different value at the same position. Nothing in
   * the markup separates it from a decorative row, so the document is what answers — the tap writes
   * `/tunnels/0/protocol`, and that is this pointer with its index normalised.
   */
  it('counts a choice made by pressing one of several buttons, because the tap writes the position', () => {
    let document: Record<string, unknown> = { tunnels: [] };
    const { container } = render(
      <div className="row-actions" data-pointer="/tunnels/-/protocol">
        <button type="button" onClick={() => (document = { tunnels: [{ id: 't1', protocol: 'openvpn' }] })}>
          OpenVPN
        </button>
      </div>,
    );
    expect(harvestScreen(container, { click, document: () => document }).pointers).toEqual([
      '/tunnels/-/protocol',
    ]);
  });

  it('does not count a row of buttons that writes nothing', () => {
    const document = { tunnels: [] };
    const { container } = render(
      <div className="row-actions" data-pointer="/tunnels/-/protocol">
        <button type="button">OpenVPN</button>
      </div>,
    );
    expect(harvestScreen(container, { click, document: () => document }).pointers).toEqual([]);
  });

  /**
   * **A container is never tapped, and the reason is a measurement.** The first version of the
   * harvest tapped the first button inside any block with no control — and the buttons inside
   * `/uplinks`, `/subscriptions` and `/routing/ruleSets` are Remove. Every one of those rows was
   * deleted from the draft, and the check then reported twenty-seven required positions as
   * unreachable from an interface that renders all of them.
   */
  it('never taps inside a container, and does not count one either', () => {
    let removed = false;
    const { container } = render(
      <div data-pointer="/uplinks">
        <button type="button" onClick={() => (removed = true)}>
          Remove
        </button>
        <div data-pointer="/uplinks/0/config/ssid">
          <input />
        </div>
      </div>,
    );
    const harvested = harvestScreen(container, { click });
    expect(removed).toBe(false);
    expect(harvested.pointers).toEqual(['/uplinks/-/config/ssid']);
    expect(harvested.inert).toEqual([]);
  });

  it('counts a position once, however many rows a fixture happens to have', () => {
    expect(normalisePointer('/routing/rules/0/suffixes')).toBe('/routing/rules/-/suffixes');
    expect(normalisePointer('/uplinks/0/config/dns1')).toBe('/uplinks/-/config/dns1');
  });

  /**
   * The draft store's own diff reports a grown array as one change at the array's pointer, which is
   * right for a pending-changes bar and useless here: the tap that adds a tunnel would never mention
   * the position it filled.
   */
  it('names the leaf a new array element brought with it, not the array', () => {
    const written = changedPointers({ tunnels: [] }, { tunnels: [{ protocol: 'vless' }] });
    expect(written).toContain('/tunnels/0/protocol');
  });
});

describe('the manifest guard stays armed on the second run', () => {
  const manifest = (pointers: string[]): Manifest => ({
    generatedBy: 'a test',
    screens: ['network'],
    fields: pointers.map((pointer) => ({ pointer, screen: 'network' })),
  });

  /**
   * **The self-heal, in the sequence that produced it.** The file was written before it was
   * compared, so run 2 compared the harvest against itself. Measured on the interface by deleting
   * the `ssid` field: 2 failures on run 1, 1 failure and 3 passing on run 2 with no code change —
   * and for any pointer the parity comparison does not separately require, green forever after.
   */
  it('reports the same change however many times it is run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wayfarer-manifest-'));
    const path = join(directory, 'parity-manifest.json');
    writeFileSync(path, `${JSON.stringify(manifest(['/uplinks/-/config/ssid']), null, 2)}\n`, 'utf8');

    const first = compareManifest(path, manifest([]), false);
    const second = compareManifest(path, manifest([]), false);

    expect(first.status).toBe('changed');
    expect(second.status).toBe('changed');
    expect(second).toStrictEqual(first);
    // The committed file is what the comparison is against, so it is the one thing not written to.
    expect(JSON.parse(readFileSync(path, 'utf8')).fields).toHaveLength(1);
    expect(JSON.parse(readFileSync(actualPath(path), 'utf8')).fields).toHaveLength(0);
  });

  it('accepts a change only when somebody asks for it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wayfarer-manifest-'));
    const path = join(directory, 'parity-manifest.json');
    writeFileSync(path, `${JSON.stringify(manifest(['/uplinks/-/config/ssid']), null, 2)}\n`, 'utf8');

    expect(compareManifest(path, manifest([]), true).status).toBe('changed');
    expect(compareManifest(path, manifest([]), false).status).toBe('unchanged');
  });

  it('writes a manifest that is not there at all, and still fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wayfarer-manifest-'));
    const path = join(directory, 'parity-manifest.json');
    const verdict = compareManifest(path, manifest(['/a']), false);
    expect(verdict.status).toBe('absent');
    expect(JSON.parse(readFileSync(path, 'utf8')).fields).toHaveLength(1);
  });
});
