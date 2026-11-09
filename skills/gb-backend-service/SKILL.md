---
name: gb-backend-service
description: Implement device, task, permission and persistence APIs for this GB28181 management platform.
---

# gb-backend-service

Read ../../docs/workflows.md and existing routes/tests. Implement the agreed contract through request validation, authorization, service logic and persistence. Keep SIP and media calls behind adapters. Device codes are strings; enforce uniqueness in storage, not only frontend validation. Bind resource access to the current user. Use transactions for multi-record changes and recoverable tasks for external side effects. Do not hold database transactions while waiting for device replies. Return accepted tasks promptly with queryable status. Test the changed observable behavior, including relevant duplicate, permission or timeout cases. If storage changes, provide migration and explain existing data handling.
