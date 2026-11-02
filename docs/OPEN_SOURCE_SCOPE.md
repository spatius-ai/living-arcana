# Open-source release scope

Source baseline: upstream `main`, commit `fe098ad5e909ce176adf781d32ba3b0d170ab031`, retrieved 2026-11-02. Local uncommitted changes were explicitly excluded.

Included: the runtime tarot content dataset (`tarot-rws-78-content.json`), application source, Worker and server integrations, tests, lockfile and project media approved for redistribution by the project owner.

Excluded: original Git history, real environment files, deployment secrets, production Cloudflare account and routes, production app/avatar IDs, personal tooling, research and captured third-party code, screenshots, internal handoff and product plans, prototypes, caches and build output.

The release starts with a new history. The upstream repository and its local uncommitted changes are preserved. Existing credentials must be revoked separately if exposed in the upstream history.

Release changes: empty credential templates; portable Cloudflare configuration; project-authored replacement for the unlicensed vendored decorative orb; MIT license; public setup and contribution documentation; test/build CI without production deployment.
