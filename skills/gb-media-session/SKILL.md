---
name: gb-media-session
description: Implement media node integration and live or playback session lifecycle for this platform.
---

# gb-media-session

Read ../../docs/workflows.md and the selected media server official API documentation. Model allocation, signaling, media readiness and viewer ownership separately. Allocate receive resources before negotiation; compensate allocations on every failure and timeout. Authenticate callbacks and reject stale generations. Ref-count reusable live streams by compatible parameters; never reuse live sessions as playback sessions. Enforce viewer ownership, lease renewal and server-side expiry. Protect playback URLs with short-lived authorization; keep node management secrets on the backend. Verify multi-viewer exit, duplicate callback, delayed readiness, node outage and orphan cleanup where affected. Report browser codec limits based on tests rather than assumed support.
