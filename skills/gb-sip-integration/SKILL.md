---
name: gb-sip-integration
description: Implement or diagnose GB28181 SIP registration, catalog and signaling against target devices.
---

# gb-sip-integration

Read ../../docs/workflows.md. Establish the requested protocol version, transport and target equipment before claiming compatibility. Consult authoritative protocol/library documentation for exact wire behavior; do not invent mandatory fields or timing values. Isolate parser, transaction correlation and device state. Correlate replies using transaction/dialog identifiers and catalog command identifiers as appropriate; handle duplicates, out-of-order fragments and deadlines. Preserve previous catalog until a complete replacement is confirmed. Bound XML/body sizes and reject malformed input. Never log credentials or unredacted authentication material. Use simulator/fixtures first; contact real devices only within explicit authorization. Record expected versus observed messages, firmware and remaining interoperability limits. Registration success is not proof of a playable stream.
