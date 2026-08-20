# Security Policy

## Supported versions

Only the latest released version of **Markdown Read Aloud** receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report it privately via GitHub's **Private vulnerability reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, steps to reproduce, and the impact.

(If private reporting is not available, open a regular issue that says only *"security — please enable private reporting"* without details, and a maintainer will follow up.)

You can expect an initial response within a few days. Once a fix is released, the advisory will be published with credit to the reporter (unless you prefer to remain anonymous).

## Scope & data handling

The default **Edge** engine sends the text to be spoken to Microsoft's public Edge "Read Aloud" endpoint to synthesize audio. No account or key is used and the extension collects nothing else. This is documented in the [README](README.md#privacy--note-on-the-edge-engine). Reports about this data flow, or about the extension leaking data beyond it, are in scope.

The **Supertonic** engine sends the text to be spoken only to a local Supertonic server on a fixed loopback endpoint (`http://127.0.0.1:7788`). The endpoint is not configurable by workspace settings, redirects are rejected, responses are validated (status, content type, WAV header, size cap), and a failure stops reading rather than falling back to an online engine. Trust assumption to be aware of: loopback is not authentication — any local process could listen on that port, so the engine trusts the local machine. The engine setting itself is application-scoped, so repository (workspace) settings cannot switch a user from an offline engine to an online one. Reports about text leaving the machine while Supertonic or Browser is selected are very much in scope.
