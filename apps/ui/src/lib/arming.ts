/**
 * How long a confirming control refuses a tap after it was armed, in milliseconds.
 *
 * Shared by every two-tap act in the panel — deleting a profile, switching the device off — because a
 * second copy of the number is how one of them comes to be answerable by a double tap again.
 *
 * Measured against the gesture rather than against a person: the two taps of a double tap arrive within
 * roughly 300 ms on every platform that defines one, so the floor sits above that and nowhere near the
 * time a reader needs to read a label.
 */
export const ARMING_MS = 500;
