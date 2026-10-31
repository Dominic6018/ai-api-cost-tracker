# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the version or commit you tested. You'll get an acknowledgement within a week. Once a fix is merged, the report is published as a security advisory, crediting you unless you'd rather not be named.

## Supported versions

Only the latest commit on `main` is supported. There are no release branches yet.

## Scope

This covers the code in this repository: the usage API, API keys, dashboard sign-in and sessions, and the Docker setup. A deployment's own configuration, such as its reverse proxy, TLS and database access, is the operator's responsibility; [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) lists what to check.

Never include real API keys, passwords or usage data in a report.
