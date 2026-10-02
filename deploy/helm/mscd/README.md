# MSCD Helm chart

Installs the MSCD platform on Kubernetes 1.29 or later with Helm 3: the web
pods (NGINX, the only pods the Ingress reaches; they proxy `/api` to the api),
the api, the worker, the storage gateway, and the `migrate` Job, a
`pre-install,pre-upgrade` hook that applies the database migrations and
installs the packs of the image before any pod rolls.

The installation guide (`docs/INSTALL-ONPREM.md`) walks through a complete
install. This page lists what the chart expects and how it is checked.

## Before installing

1. PostgreSQL 15 or later with the MSCD roles (`mscd-server db bootstrap`,
   build plan C.2) and an S3-compatible object store with a bucket for the
   Managed Vault.
2. One Secret per component in the release namespace. Each pod mounts only its
   own Secret at `/run/secrets`, so `storage.key` exists only in the storage
   gateway and `platform.key` never there. `<fullname>` below is the release
   name when it contains `mscd`, otherwise `<release>-mscd` (for example
   `prod-mscd-api` for the release `prod`); `fullnameOverride` replaces it.

   | Secret | Keys |
   |---|---|
   | `<fullname>-api` | `db-app.url`, `platform.key`, `gateway.token`, optional `smtp.password` |
   | `<fullname>-worker` | `db-app.url`, `platform.key`, `gateway.token`, `db-pack.url`, `audit-anchor.key`, optional `smtp.password` |
   | `<fullname>-gateway` | `storage.key`, `s3.access`, `s3.secret`, `gateway.token`, optional `gateway.token.previous` |
   | `<fullname>-migrate` | `db-migrator.url`, `db-pack.url` |

   `platform.key` and `storage.key` hold base64 of 32 random bytes
   (`openssl rand -base64 32`), `gateway.token` at least 32 characters (the
   same in the three Secrets that hold it), `audit-anchor.key` the Ed25519
   private key of `mscd-server keys generate`. Other names can be given with
   `secrets.existingSecret.<component>`. Set `secrets.smtpPassword: true` when
   the api and worker Secrets hold `smtp.password`.
3. Certificates for the internal mTLS between the api and worker (clients,
   `CN=mscd-api` and `CN=mscd-worker`) and the storage gateway (server, DNS
   name `<fullname>-gateway`): either `certManager.enabled: true` (cert-manager
   issues them, from `certManager.issuerRef` or a CA the chart sets up), or
   three `kubernetes.io/tls` Secrets with `ca.crt` named
   `<fullname>-gateway-tls`, `<fullname>-api-tls` and `<fullname>-worker-tls`, or
   `certs.generate: true` (Helm makes an internal CA; its key is then stored in
   the release record).

## Main values

| Value | Purpose |
|---|---|
| `profile` | The deployment profile (build plan I.1), written to a ConfigMap. The chart sets the secret file paths, the gateway URL, the ports and `http.trust_proxy` itself |
| `api.trustedProxyCidrs` | Address ranges of the web pods (the pod network). The api takes the client address from `X-Forwarded-For` only from these; the NetworkPolicies let only the web pods reach the api |
| `ingress.trustedCidrs` | Address ranges of the ingress controller; the web pods take the client address from `X-Forwarded-For` only from these |
| `ingress.*` | Host names and TLS; each host routes `/` and `/api` to the web Service |
| `networkPolicy.*` | Default deny for every pod of the release plus the flows MSCD needs; narrow `database`, `objectStore`, `smtp` and `identityProviders` to your addresses. `identityProviders` defaults to any address outside `identityProviders.except` (cluster and private ranges) on 443 |
| `networkPolicy.ingressFrom` | Sources allowed to reach the web pods. **Empty by default, which allows any source in or outside the cluster**; set it to the ingress controller in production (`values-ha.yaml` shows a namespace selector for `ingress-nginx`) |
| `gateway.egressAll`, `gateway.egressExcept`, `gateway.egressCidrs` | Outbound HTTPS of the storage gateway to SharePoint and Google Drive |
| `values-ha.yaml` | Reference for production: replicas, autoscaling, disruption budgets, spread across nodes, cert-manager |
| `values-ci.yaml` | Install test only: generated secrets, demo image, test PostgreSQL and SeaweedFS |

Kubernetes mounts Secret files with group read access for the pod's group
(`fsGroup`), so the server logs a warning that a key file is readable by other
users. No other user exists in the container.

## Checks

```bash
bash deploy/helm/mscd/ci/validate.sh    # helm lint, helm template, kubeconform, ci/assert-render.mjs
bash deploy/helm/mscd/ci/k3s-test.sh    # install, helm test and upgrade in k3s (nightly CI)
```

`validate.sh` runs helm and kubeconform in `alpine/k8s:1.34.1` and needs
Docker and Node.js with the repository dependencies installed. `k3s-test.sh`
needs a host where k3s in Docker can start pods (cgroup v2), Docker Hub access
for the third-party images, and takes `--build-ca` like the image builds.
