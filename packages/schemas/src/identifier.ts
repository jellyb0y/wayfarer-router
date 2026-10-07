/**
 * The identifier shape, in its own module so that both the profile document and the catalogue's
 * typed configurations can use it without one importing the other.
 *
 * Constrained rather than free-form because these values leave the document: a tunnel id becomes an
 * outbound tag, a systemd template instance and part of a generated file name. A value that is fine
 * as a JSON key and catastrophic as a unit instance is exactly the kind of thing that is discovered
 * on a device rather than in a test.
 */

import { Type } from '@sinclair/typebox';

export const Identifier = Type.String({
  pattern: '^[a-z0-9][a-z0-9-]{0,62}$',
  description: 'Lower case, digits and hyphens; must not start with a hyphen.',
});
