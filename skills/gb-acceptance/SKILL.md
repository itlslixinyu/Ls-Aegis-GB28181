---
name: gb-acceptance
description: Verify this GB28181 platform or diagnose local service and device integration failures.
---

# gb-acceptance

Read ../../README.md and the relevant acceptance stage in ../../docs/workflows.md. Check running processes, logs, listener and HTTP response before diagnosing a browser connection problem. Start only the intended project service, verify both homepage and health endpoint, and avoid replacing unrelated listeners. For feature acceptance run relevant existing tests and exercise the complete user path, including affected failure and cleanup cases. Separate mock, simulator and real-device evidence. Record commands, outcomes, device/firmware/version when used and unverified items. Do not mark SIP/media functionality passed from a static page or health response alone. Real device commands and external deployment require authorization for that scope.
