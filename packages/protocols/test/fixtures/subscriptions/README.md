# Subscription fixtures — SYNTHETIC, not captures

**Every file in this directory was written by hand from what this project believes each link format to
be.** None of them is a capture of a link produced by a real provider.

That distinction is the whole reason this README exists. Elsewhere in this repository a fixture is a
recording: the hostapd station output, the `iw phy` dump and the core's JSON Schema were all taken from a
device and are evidence about the world. These are not. They encode an **assumption**, and an assumption
that disagrees with reality produces a green test suite and a parser that is wrong.

So when a real subscription is available, replace these files with what it actually contained (credentials
substituted, structure untouched) and delete this warning. Until then, every test that reads them says so
in its name.

The failure mode to watch for is the one the design explicitly rejects: **"skipping unsupported format"**.
A link shape not represented here must produce a reported failure naming the scheme and the line, never a
silently absent node.

Credentials in these files are obviously fake — `0000…`-style UUIDs and passwords that say what they are.
Nothing here is a secret, and nothing here should ever be replaced with something that is.
