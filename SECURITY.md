# Security policy

Please report security issues privately through GitHub's security advisory
feature for this repository.

Agent Sideband treats message bodies and provider output as untrusted data.
Deployments must authenticate every mutation, bind publicly only behind an
appropriate authenticated reverse proxy, scope host-adapter credentials to the
minimum required operations, and keep token files outside source control.
