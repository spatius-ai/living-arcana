# Security

Do not publish credentials or exploit details in public issues. Use the repository's GitHub Security Advisory reporting facility when private vulnerability reporting is available; otherwise contact an organization maintainer privately before disclosing sensitive details.

Use server-side secrets for provider credentials; never use a `VITE_` prefix for an API key. Before exposing the API publicly, add access control and provider spending limits suited to your deployment. Anonymous per-browser reading quotas are not authentication or comprehensive API rate limiting.

If a credential has ever been committed, revoke or rotate it at the provider. Deleting a file or publishing a fresh history does not revoke the original credential.
