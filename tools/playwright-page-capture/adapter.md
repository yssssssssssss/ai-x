# Playwright page capture adapter

This optional adapter captures public HTTPS pages in an isolated Chromium context. It is registered only when `PLAYWRIGHT_CAPTURE_ENABLED=1`.

Install the pinned browser explicitly with `pnpm playwright:install:chromium`. Runtime execution never downloads a browser.

The adapter requires a non-root Worker, Chromium sandbox support, and infrastructure egress rules that block private, loopback, link-local, CGNAT, reserved, and cloud metadata destinations. Its in-process route checks are defense in depth and do not replace egress isolation.

Tool JSON contains metadata and sanitized page failures only. Image bytes are returned through the in-memory media sidecar and must never be logged or JSON serialized.
