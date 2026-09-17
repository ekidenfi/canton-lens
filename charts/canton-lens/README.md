# Canton Lens Helm chart

Deploys the two Docker workloads as two Kubernetes Deployments behind one origin,
mirroring `docker/compose.yaml`:

| Kubernetes object | Docker equivalent | Notes |
|---|---|---|
| `frontend` Deployment + Service (nginx) | `frontend` compose service | Serves the built bundle, proxies `<basePath>/api/*` and `<basePath>/openapi.json` to the backend |
| `backend` Deployment + Service | `backend` compose service | Fastify API on port 7600, ClusterIP-only by default |
| `frontend-nginx` ConfigMap | `docker/nginx.conf` | Templated `proxy_pass` points at the backend Service DNS name |
| `shared-identity` Secret | `SHARED_IDENTITY_CLIENT_SECRET` in `docker/.env` | Only rendered in `shared-identity` mode without `existingSecret` |
| optional Ingress | `EXPLORER_BIND`/`EXPLORER_PORT` publishing | Terminates TLS at the edge; nginx itself terminates no TLS |

## Images

The chart deploys images; it does not build the frontend bundle. `VITE_*` values are
literals inside the bundle, so the frontend image is bound to its auth profile
and environment.

Images are published to GHCR by the `Publish images and charts` workflow under
names derived from the repository (`ghcr.io/<owner>/<repo>-backend`,
`ghcr.io/<owner>/<repo>-frontend`):

| Image | Tags | Notes |
|---|---|---|
| `<repo>-backend` | `0.1.0`, `0.1`, `latest`, `sha-*` (prod) · `staging`, `staging-sha-*` | Generic — no build args, safe to reuse |
| `<repo>-frontend` | `shared-identity-0.1.0`, `shared-identity-latest`, staging variants | Bakes in only `VITE_AUTH_MODE=shared-identity` |
| `<repo>-frontend` | `institution-bff-0.1.0`, `institution-bff-latest`, staging variants | Bakes in only `VITE_AUTH_MODE=institution-bff` |
| `<repo>-frontend` | `browser-oidc-0.1.0`, `browser-oidc-latest` (prod) · `browser-oidc-staging` | Bakes in the committed `docker/.env.production` / `docker/.env.staging` |

A deployment with its own issuer, client id or redirect URIs still builds its
own `browser-oidc` frontend (one command, from the repo root):

```bash
docker build -f docker/frontend.Dockerfile \
  --build-arg VITE_AUTH_MODE=browser-oidc \
  --build-arg VITE_OIDC_ISSUER=https://idp.example/realms/explorer \
  --build-arg VITE_OIDC_CLIENT_ID=explorer-browser \
  --build-arg VITE_OIDC_REDIRECT_URI=https://explorer.example/ \
  --build-arg VITE_OIDC_POST_LOGOUT_REDIRECT_URI=https://explorer.example/ \
  --build-arg VITE_OIDC_SCOPES="openid profile" \
  -t registry.example/canton-lens-frontend:browser-oidc .
docker push registry.example/canton-lens-frontend:browser-oidc
```

Never pass a secret as a frontend `--build-arg`: build args are recorded in image
history, printed in build output and kept in the build cache. `SHARED_IDENTITY_*`
stays backend-only (env / Secret), read at startup.

## Chart releases

The chart itself is published to GHCR as an OCI artifact by the same workflow —
`oci://ghcr.io/<owner>/<repo>/charts/canton-lens` — versioned from the `v*`
tag on prod releases (`0.1.0`) and as `<Chart.yaml version>-staging.<run>`
(e.g. `0.1.0-staging.42`) on `main`:

```bash
helm install lens oci://ghcr.io/ekidenfi/canton-lens/charts/canton-lens --version 0.1.0 -f my-values.yaml
```

Prefer a pinned version over the floating `latest` / `<profile>-latest` image
tags in production (see `values-browser-oidc.yaml`,
`values-shared-identity.yaml`).

## Install

```bash
helm install lens ./charts/canton-lens -f my-values.yaml
helm lint ./charts/canton-lens
helm template lens ./charts/canton-lens -f my-values.yaml | kubectl apply --dry-run=client -f -
```

Minimal browser-oidc install (`my-values.yaml`):

```yaml
config:
  ledgerBase: https://canton.example
  ledgerAuthMode: caller-bearer
  viteAuthMode: browser-oidc
  publicEntryUrl: https://explorer.example/
frontend:
  # Prebuilt browser-oidc image for the committed env (`docker/.env.staging` /
  # `docker/.env.production`); pin to a release tag in production, or build
  # your own per deployment (see "Images" above).
  image: { repository: ghcr.io/ekidenfi/canton-lens-frontend, tag: browser-oidc-staging }
backend:
  image: { repository: ghcr.io/ekidenfi/canton-lens-backend, tag: staging }
ingress:
  enabled: true
  hosts: [{ host: explorer.example, paths: [{ path: /, pathType: Prefix }] }]
  tls: [{ secretName: explorer-tls, hosts: [explorer.example] }]
```

Shared-identity install (backend holds one service credential; protect with edge access control):

```yaml
config:
  ledgerBase: https://canton.example
  ledgerAuthMode: shared-identity
  viteAuthMode: shared-identity
  sharedIdentity:
    issuer: https://idp.example/realms/explorer
    clientId: explorer-service
    scopes: ledger.read
    existingSecret: { name: lens-shared-identity, key: client-secret }
frontend:
  image: { repository: ghcr.io/ekidenfi/canton-lens-frontend, tag: shared-identity-latest }
backend:
  image: { repository: ghcr.io/ekidenfi/canton-lens-backend, tag: latest }
```

```bash
kubectl create secret generic lens-shared-identity --from-literal=client-secret="$SECRET"
helm install lens ./charts/canton-lens -f shared-values.yaml
```

Prefer `existingSecret` (external-secrets / Vault / Sealed Secrets) over inline
`config.sharedIdentity.clientSecret`, which lands in Helm release state. Restart all
backend pods after rotating issuer / secret / scopes; revoking a client secret may not
revoke already-issued tokens.

## API-only (no frontend)

```yaml
frontend: { enabled: false }
```

The ingress then routes to the backend Service. Put your own entry controls in front;
`shared-identity` mode additionally rejects any incoming `Authorization` header with 409.

## `basePath`

Leave `config.basePath` empty unless a gateway forwards a prefix without stripping it.
When set (e.g. `/explorer`), the backend serves `<basePath>/api/*` and
`<basePath>/openapi.json` (probes follow), and nginx proxies the same prefix. The SPA
itself is still served at `/`; serving it under a sub-path is out of scope for this chart.

## Before exposing it

- The chart's nginx terminates no TLS and enforces no access control — same as
  `docker/nginx.conf`. Put TLS, edge access control and rate limiting in front.
- `shared-identity` shares one Canton scope with every visitor; never expose it without
  operator-managed access control.
- Keep tokens, secrets, `Authorization` headers and ledger bodies out of logs/traces.
- Review `docs/security.md#deployment-checklist`.
