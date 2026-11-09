---
name: gb-feature-contract
description: Design cross-layer GB28181 feature contracts before implementation or API changes.
---

# gb-feature-contract

Read ../../docs/workflows.md and the current frontend/backend callers. Define the user trigger, success, empty, timeout and failure outcomes. Specify routes, permission scope, fields, asynchronous completion, idempotency and resource cleanup where applicable. Distinguish current implementation from proposed behavior. Update the relevant design section without duplicating the whole architecture. Produce concrete acceptance cases for frontend and backend; resolve shared contracts before implementation. Do not change unrelated technology choices.
