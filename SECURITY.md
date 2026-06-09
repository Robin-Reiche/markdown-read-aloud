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
