# Changelog

## [0.1.0] - 2026-02-09

### Features

* Dynamic blueprint discovery from Leapter API
* Automatic input field generation from OpenAPI schemas
* Support for all Leapter blueprint operations (POST to `/models/{id}/runs`)
* Run metadata with editor links in response (`_metadata.runId`, `_metadata.editorLink`)
* API key authentication via `X-API-Key` header
* Configurable server URL for self-hosted instances
* `continueOnFail()` support for graceful error handling

### Initial Release

This is the first public release of the n8n Leapter community node.
