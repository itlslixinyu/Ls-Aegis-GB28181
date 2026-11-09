---
name: gb-frontend-flow
description: Implement frontend interactions for this GB28181 platform using agreed business API contracts.
---

# gb-frontend-flow

Read ../../docs/workflows.md and inspect actual frontend files before choosing framework-specific code. Preserve current startup until a working migration is included. Represent loading, empty, permission denied, device offline and media failure separately. Treat task acceptance as pending, not success. For video wait for media readiness, release the viewer on exit and renew its lease while watching. On event reconnection reload authoritative snapshots. Use server permissions to drive controls but never as a substitute for backend authorization. Render device names as text, not HTML. Verify the changed page at desktop and narrow widths when browser tools are available; otherwise report visual verification as pending.
