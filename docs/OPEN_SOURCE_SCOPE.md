# Open-source release scope

Source baseline: upstream `main`, commit `fe098ad5e909ce176adf781d32ba3b0d170ab031`, retrieved 2026-11-02. Local uncommitted changes were explicitly excluded.

Included: the runtime tarot content dataset (`tarot-rws-78-content.json`), application source, Worker and server integrations, tests, lockfile and project media approved for redistribution by the project owner.

Excluded: original Git history, real environment files, deployment secrets, production Cloudflare account and routes, production app/avatar IDs, hosted Spatius avatar asset packages, personal tooling, research and captured third-party code, screenshots, internal handoff and product plans, prototypes, caches and build output.

The release starts with a new history. The upstream repository and its local uncommitted changes are preserved. Existing credentials must be revoked separately if exposed in the upstream history.

Release changes: empty credential templates; portable Cloudflare configuration; project-authored replacement for the unlicensed vendored decorative orb; MIT license; public setup and contribution documentation; test/build CI without production deployment.

## Avatar access

Developers who want the demo's tarot characters register their own Spatius Studio account and email the maintainer to request avatar copies. The maintainer copies the avatars into the requesting account manually. Developers then use the Avatar IDs, App ID and API key from their own account; their deployment consumes their own account quota. See the [request instructions](../README.md#demo-and-avatar-access).

The avatar request process does not provide access to the hosted demo's account or credentials. LLM and speech services require the developer's own provider configuration.
