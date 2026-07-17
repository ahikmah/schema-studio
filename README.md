# Schema Studio

A private DBML designer for database architecture work. It provides DBML syntax highlighting, a resizable DBML/ERD workspace, full-width and fullscreen diagrams, PostgreSQL export, project sharing, revisions, and optimistic autosave conflict handling.

The application database stores only Access users, design projects, collaborators, and revision snapshots. The example schema in `examples/mybro-core.dbml` is a resource; operational application data is not stored by Schema Studio.

Authentication belongs to Cloudflare Access. The Worker validates the signed `Cf-Access-Jwt-Assertion`, then creates the corresponding local `users` row on first use. There are no application passwords, password hashes, or session tables.

## Local development

Prerequisites: Node.js 22+, npm, PostgreSQL, and `psql`.

```bash
npm install
export DATABASE_URL='postgresql://user:password@host:5432/database?sslmode=require'
npm run db:migrate
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
```

Create an untracked `.dev.vars` file beside `wrangler.jsonc`:

```dotenv
ENVIRONMENT="local"
DEV_USER_EMAIL="you@example.com"
```

Then run `npm run dev` and open the URL printed by Vite. The local email shortcut is ignored outside `ENVIRONMENT=local`.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

The test suite uses an in-memory PostgreSQL implementation and covers Access JWT/JWKS validation, fail-closed authentication, first-use user provisioning, the password/session-free schema, cross-origin mutation blocking, role authorization, optimistic conflicts, revisions, DBML parsing/export, API errors, editor conflict state, and split-width bounds.

## Free Cloudflare deployment

This setup uses Cloudflare Workers + Static Assets, Cloudflare Access, Hyperdrive, and Neon PostgreSQL. No D1 database or application-owned auth service is required.

### 1. Create the Neon database

Create a Neon Free project. In **Connection Details**, select the branch/database/role and turn **Connection pooling** off. Hyperdrive already pools connections, so use the direct TLS connection string (the host must not contain `-pooler`).

```bash
export DATABASE_URL='postgresql://user:password@host/database?sslmode=require'
npm run db:migrate
```

Keep this URL out of Git. The initial migration creates only `users`, `projects`, `project_collaborators`, and `project_revisions`.

### 2. Create Hyperdrive and deploy once

```bash
npx wrangler login
npx wrangler hyperdrive create mybro-database-designer \
  --connection-string="$DATABASE_URL" \
  --sslmode=require \
  --caching-disabled \
  --binding=HYPERDRIVE \
  --update-config
npm run deploy
```

`--update-config` replaces the placeholder Hyperdrive ID in `wrangler.jsonc`. Caching stays disabled because authentication and permissions need read-after-write consistency. The Neon connection string is stored by Cloudflare, not in Git.

### 3. Protect the Worker with Access

In the Cloudflare Zero Trust dashboard:

1. Go to **Access controls → Applications → Add an application → Self-hosted**.
2. Select this Worker as the destination and protect all deployments you intend users to open.
3. Add an Allow policy for the permitted email addresses or identity group.
4. Copy the team domain (for example `my-team.cloudflareaccess.com`).
5. Open the application's **Additional settings** and copy its **Application Audience (AUD) Tag**.

Replace the two explicit placeholders in `wrangler.jsonc`, then deploy again:

```bash
npm run deploy
```

Production fails closed if the token, team domain, signature, issuer, audience, expiry, or email is invalid. Owners can share with an email before that user signs in; the app creates a placeholder user row and Cloudflare Access still controls who can enter. Sign out uses `/cdn-cgi/access/logout`.

### Free-tier boundaries

- Cloudflare Access Free: $0 for up to 50 users.
- Workers Free: 100,000 dynamic requests per day and 10 ms CPU per invocation; static assets are free and unlimited.
- Hyperdrive Free: 100,000 database statements per day.
- Neon Free: 100 compute-unit hours and 0.5 GB storage per project at the time this guide was written.

The DBML parser, SQL exporter, and diagram renderer run in the browser. The Worker only validates a JWT and performs parameterized PostgreSQL queries, so the former PBKDF2 CPU cost is gone.

## Data and access rules

- Projects are private by default.
- Owners invite an email as viewer or editor.
- Viewers can inspect revisions and export; editors can also save and create revisions.
- DBML is the source of truth. Diagram interactions persist table positions only.
- Invalid drafts autosave, while PostgreSQL export and named revisions require valid DBML.
- A stale save returns `409`; the UI preserves local DBML and requires an explicit reload.
- The app designs SQL but never executes generated SQL against a live application database.
