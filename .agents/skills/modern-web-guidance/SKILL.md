---
name: modern-web-guidance
description: Consult browser guidance when choosing native form controls, focus behavior, or browser APIs for the offline human-review page.
---

From the repository root, search with the pinned CLI and retrieve the guide that matches the behavior under review. For example, to check how a reviewer activates a labeled checkbox:

```sh
DISABLE_TELEMETRY=1 corepack yarn modern-web-guidance search "label checkbox control"
DISABLE_TELEMETRY=1 corepack yarn modern-web-guidance retrieve checkbox
```

Keep the generated page usable offline under its existing content security policy. Verify changed interactions in the generated HTML and run `node --test scripts/jev/tests/review-handoff.test.mjs`.
