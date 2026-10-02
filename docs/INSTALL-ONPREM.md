# MSCD On-Premise Installation Guide

MSCD (Management System Compliance Dashboard) by CyberLentera.

This guide installs and runs MSCD on your own servers: with Docker Compose on one server, or with Helm on Kubernetes. Both work in air-gapped networks. Nothing is downloaded during installation.

## Contents

1. [What you receive](#1-what-you-receive)
2. [Requirements](#2-requirements)
3. [Check the bundle](#3-check-the-bundle)
4. [Install with Docker Compose](#4-install-with-docker-compose)
5. [First administrator](#5-first-administrator)
6. [Licence](#6-licence)
7. [Administration settings](#7-administration-settings)
8. [Sign-in with your identity provider](#8-sign-in-with-your-identity-provider)
9. [Local sign-in policy](#9-local-sign-in-policy)
10. [Connect file repositories](#10-connect-file-repositories)
11. [Your own PostgreSQL or S3 storage](#11-your-own-postgresql-or-s3-storage)
12. [Install on Kubernetes with Helm](#12-install-on-kubernetes-with-helm)
13. [Secrets and keys](#13-secrets-and-keys)
14. [Audit trail and anchors](#14-audit-trail-and-anchors)
15. [Backups, upgrades and rollback](#15-backups-upgrades-and-rollback)
16. [Everyday operations](#16-everyday-operations)
17. [Troubleshooting](#17-troubleshooting)
18. [Network and firewall](#18-network-and-firewall)
19. [Uninstall](#19-uninstall)
20. [Security summary](#20-security-summary)
21. [Try MSCD on a test server](#21-try-mscd-on-a-test-server)

## 1. What you receive

CyberLentera delivers three files:

| File | Purpose |
|---|---|
| `mscd-onprem-<version>.tar.gz` | The offline bundle |
| `mscd-onprem-<version>.tar.gz.sha256` | Checksum of the bundle. It shows that the copy is complete. |
| `mscd-release.pub` | CyberLentera public key. It proves that CyberLentera made the bundle. |

Keep the three files together in one directory. The installer looks for `mscd-release.pub` next to the extracted bundle directory.

Inside the bundle:

| Path | Contents |
|---|---|
| `install.sh`, `upgrade.sh`, `uninstall.sh`, `lib/` | Scripts for Docker Compose installations |
| `images/` | Container images: MSCD web, MSCD server, PostgreSQL 16, SeaweedFS (object storage) and Valkey (optional queue) |
| `compose/` | Docker Compose file, settings template and the database start-up script |
| `helm/` | Helm chart `mscd-<version>.tgz` and the production reference values `values-ha.yaml` |
| `packs/` | Framework packs signed by CyberLentera. They are also inside the server image and are installed automatically. |
| `keys/` | The CyberLentera public keys built into this release (licence, pack and anchor keys), for your records |
| `SHA256SUMS`, `SHA256SUMS.sig` | Checksums of every file, and their signature |
| `SECURITY-SCAN.txt` | Vulnerability scan of the images, made before the release was signed |
| `VERSION`, `BUNDLE-INFO` | Release details |
| `INSTALL-ONPREM.md` | This guide |

MSCD has these parts. All of them come with the bundle, and you can replace PostgreSQL and the object storage with your own (section 11).

| Part | What it does |
|---|---|
| web | The user interface (NGINX). The only part users connect to. It forwards `/api` to the api. |
| api | Application API, sign-in, access control, business rules, licence checks |
| worker | Scheduled and background jobs: evidence freshness, link checks, notifications, evidence packs, audit anchors |
| storage-gateway | The only part that reads and writes files: the Managed Vault and your SharePoint or Google Drive repositories. It holds the storage keys. |
| migrate | Runs once at every start and upgrade: database changes and framework packs |
| PostgreSQL | Structured data and the audit trail |
| SeaweedFS | S3-compatible object storage for the Managed Vault |
| Valkey | Optional job queue for large installations. PostgreSQL is the default queue. |

## 2. Requirements

### Server for Docker Compose

| Item | Requirement |
|---|---|
| Operating system | 64-bit Linux on x86-64 that runs Docker Engine 24 or later |
| Size for production (Small profile: up to 150 users, 1 to 2 management systems) | 8 vCPU, 32 GB RAM, 500 GB SSD |
| Minimum to start (evaluation) | 4 vCPU, 4 GB RAM, 10 GB free for Docker data |
| Software | Docker Engine 24 or later with the Docker Compose plugin 2.20 or later, `openssl`, `sha256sum`, `tar`, and `curl` for the final checks |
| Access | `root` through `sudo` (recommended), or a member of the `docker` group installing into a directory that user owns |
| Browsers | Current Chrome, Edge or Firefox |

Tested with Ubuntu 24.04 LTS, Docker Engine 29.6.2 and Docker Compose 5.3.1.

### Kubernetes

Kubernetes 1.29 or later, Helm 3, an internal container registry, an ingress controller, PostgreSQL 15 or later and an S3-compatible object store. See section 12.

### Larger installations

| Profile | Users and management systems | Resources |
|---|---|---|
| Medium (Kubernetes) | Up to 1,000 users, up to 6 management systems | 3 worker nodes with 8 vCPU and 32 GB RAM each; PostgreSQL primary and replica; 2 TB object storage |
| Large (Kubernetes) | More than 1,000 users or many subsidiaries | Sized with your infrastructure team |

These figures are a starting point. Confirm them with a load test before you make them a contractual requirement.

## 3. Check the bundle

Do this on the machine that received the files, and again on the server after every transfer.

1. Check the bundle file:

   ```bash
   sha256sum -c mscd-onprem-<version>.tar.gz.sha256
   ```

   The command prints `OK`.

2. Check the public key itself once. Compare its fingerprint with the one CyberLentera publishes on the support portal:

   ```bash
   openssl pkey -pubin -in mscd-release.pub -outform DER | sha256sum
   ```

3. Copy the three files to one directory on the server with your approved transfer method, then extract the bundle:

   ```bash
   sha256sum -c mscd-onprem-<version>.tar.gz.sha256
   tar xzf mscd-onprem-<version>.tar.gz
   cd mscd-onprem-<version>
   ```

4. Optional: check the signature and every file by hand before running any script:

   ```bash
   openssl dgst -sha256 -verify ../mscd-release.pub -signature SHA256SUMS.sig SHA256SUMS
   sha256sum -c --quiet SHA256SUMS
   ```

   The first command prints `Verified OK`. The second prints nothing when every file matches.

The installer and the upgrade script check the checksums and the signature again before they change anything.

## 4. Install with Docker Compose

### 4.1 Install

From the extracted bundle directory:

```bash
sudo ./install.sh
```

The installer checks the server and the bundle, then asks for:

- the host name users open in the browser,
- the HTTP and HTTPS ports (80 and 443 by default),
- the certificate: self-signed, or files from your certificate authority,
- the short name (slug) and the display name of your organisation.

Press Enter to accept the value in brackets. Every answer is checked, and the question repeats when an answer is not valid. The installer then shows a summary and asks for confirmation.

To install without questions, give the answers as options:

```bash
sudo ./install.sh --yes --domain mscd.example.co.id --self-signed \
  --org-slug acme --org-name "PT Acme Indonesia" \
  --admin-email ana.wijaya@acme.co.id \
  --smtp-host smtp.acme.co.id --mail-from "MSCD <mscd@acme.co.id>"
```

The organisation slug names your organisation inside MSCD and the database. It cannot change later. Use a lower-case letter, then 2 to 40 lower-case letters, digits or `_`.

A successful run ends like this:

```text
==> Verifying
  PASS  HTTP  http://127.0.0.1:80/healthz returned 200
  PASS  HTTPS https://127.0.0.1:443/healthz returned 200
  PASS  HTTPS https://127.0.0.1:443/ returned 200
  PASS  API   https://127.0.0.1:443/api/v1/system/profile returned 200
  PASS  HTTP  http://127.0.0.1:80/ redirects to HTTPS

MSCD 1.0.0 is running.

  Open          https://mscd.example.co.id/
  Organisation  PT Acme Indonesia (acme)
  Install dir   /opt/mscd
  Status        cd /opt/mscd && sudo docker compose ps
  Logs          cd /opt/mscd && sudo docker compose logs api web
  Uninstall     sudo /opt/mscd/uninstall.sh

  First administrator: send this one-time link (valid 72 hours) to ana.wijaya@acme.co.id:
    admin create-user: created user ana.wijaya (ana.wijaya@acme.co.id) to organisation acme as tenant_admin
    Invitation link (single use, valid until 2026-10-05T07:49:57.028Z):
    https://mscd.example.co.id/invite#token=<one-time token>

  Keep a copy of /opt/mscd/secrets in a safe place: without it the database
  and the encrypted files cannot be opened.
```

The first start takes a few minutes: the database is created, every database change is applied and the framework packs are installed before the application starts.

How the installer protects you:

- Every check runs before anything changes. When a check fails, the installer prints `FAIL` with a `Fix:` line and stops without changing anything.
- A new certificate is first tested by NGINX in a container without network. The installed certificate is replaced only when that test passes.
- If MSCD does not become healthy with new settings, the installer puts back the previous settings and certificate and starts MSCD again.
- Running `install.sh` again is safe. It keeps your settings, secrets and data and changes only what you pass.

Keep the extracted bundle directory. `install.sh` and `upgrade.sh` run from it.

### 4.2 Installer options

`./install.sh --help` shows the same list.

| Option | Default | Purpose |
|---|---|---|
| `--dir DIR` | `/opt/mscd` | Install directory. Without `sudo`, use a directory you own, such as `~/mscd`. |
| `--domain NAME` | The server's host name | Name users open in the browser |
| `--http-port PORT` | 80 | HTTP port on the server |
| `--https-port PORT` | 443 | HTTPS port on the server |
| `--bind-address IP` | 0.0.0.0 | Listen on one IPv4 address only |
| `--self-signed` | Used for new installs | Generate a self-signed certificate |
| `--tls-cert FILE`, `--tls-key FILE` | | Your certificate (PEM, full chain) and its key |
| `--http-redirect on/off` | on | Redirect HTTP to HTTPS |
| `--hsts on/off` | off | Send Strict-Transport-Security (only with a trusted certificate) |
| `--external-fonts on/off` | off | Allow the optional Google Fonts |
| `--org-slug SLUG` | Asked | Short name of your organisation. It cannot change later. |
| `--org-name NAME` | Asked | Display name of your organisation |
| `--admin-email EMAIL` | | Invite this person as the first administrator and print the one-time invitation link |
| `--smtp-host HOST` | `smtp` | SMTP relay for outgoing email |
| `--smtp-port PORT` | 25 | SMTP port |
| `--smtp-user USER` | | SMTP login, when the relay needs one |
| `--smtp-password-file FILE` | | File whose first line is the SMTP password. Needed with `--smtp-user`. |
| `--mail-from ADDRESS` | `MSCD <mscd@<host name>>` | Sender of MSCD email |
| `--verify-key FILE` | `../mscd-release.pub` when present | Public key for the bundle signature |
| `--skip-signature-check` | | Install a signed bundle without checking its signature. Not recommended. |
| `--timeout SECONDS` | 600 | How long to wait for the services to become healthy |
| `--yes` | | Ask no questions. Required when there is no terminal, for example in automation. |

To change a setting later, run `sudo ./install.sh` again from the bundle directory with the new option, for example `--smtp-host mail.acme.co.id`. Every other setting is kept.

### 4.3 What the installer sets up

In the install directory (`/opt/mscd` by default):

| Path | Contents |
|---|---|
| `.env` | Your settings (readable only by its owner). `.env.example` explains every setting. |
| `docker-compose.yml` | The services. Do not edit it; it is replaced on upgrade. |
| `secrets/` | Database passwords, encryption keys, the gateway token, the audit anchor key, the internal certificates. See section 13. |
| `tls/` | The web certificate and key |
| `config/` | The database start-up script |
| `backups/` | Settings saved before each upgrade |
| `upgrade.sh`, `uninstall.sh`, `lib/` | Scripts for later use |

The installer runs these Docker Compose services in the project `mscd`:

| Service | Image | Notes |
|---|---|---|
| `web` | `cyberlentera/mscd-web` | Publishes the HTTP and HTTPS ports |
| `api`, `worker`, `storage-gateway` | `cyberlentera/mscd-server` | Run as user 10001 with a read-only file system and no Linux capabilities |
| `migrate` | `cyberlentera/mscd-server` | Runs once at every start, then stops (status `exited (0)` is normal) |
| `postgres` | `postgres:16.15-alpine` | Profile `bundled-db`, data in the volume `mscd_pgdata` |
| `objectstore` | `chrislusf/seaweedfs:4.48` | Profile `bundled-s3`, data in the volume `mscd_s3data` |
| `valkey` | `valkey/valkey:8.1-alpine` | Profile `bullmq`, only when you choose the Valkey queue |
| `cli` | `cyberlentera/mscd-server` | Profile `cli`, for operator commands only (section 16) |

Each service receives only the secret files it needs. The encryption key of the stored files (`storage.key`) exists only inside `storage-gateway`, and the application key (`platform.key`) never does.

The services use three Docker networks:

| Network | Purpose |
|---|---|
| `mscd` (internal, `172.31.250.0/24`) | Traffic between the services. It has no route out. The web container has the fixed address `172.31.250.10`, and the api trusts the client address only from it. |
| `edge` | The published ports of `web` |
| `egress` | Outbound connections of `api`, `worker`, `storage-gateway`, `migrate` and `cli`: your identity provider, SMTP relay, file repositories and, when you use them, your own PostgreSQL and S3 storage |

PostgreSQL, SeaweedFS and Valkey are only on the internal network and cannot connect anywhere. If `172.31.250.0/24` is already used on your network, set `MSCD_SUBNET` and `MSCD_WEB_ADDRESS` in `.env` before the first start (both must change together).

### 4.4 TLS certificate

MSCD always serves HTTPS. Choose where the certificate comes from:

| Option | Use for | How |
|---|---|---|
| Self-signed | Pilots and labs | `--self-signed` (the default for a new install). Browsers show a warning. |
| Certificate from your CA | Production | `--tls-cert` and `--tls-key` |
| TLS at your load balancer | An existing reverse proxy or load balancer | Forward to the HTTPS port, or to the HTTP port with `--http-redirect off`. Set `MSCD_TRUSTED_PROXY_CIDRS` in `.env` to its address so MSCD logs the real client address. |

To install or replace a certificate from your CA:

```bash
sudo ./install.sh --yes --tls-cert /etc/pki/mscd/fullchain.pem --tls-key /etc/pki/mscd/mscd.key --hsts on
```

Certificate requirements:

- PEM format: the files start with `-----BEGIN CERTIFICATE-----` and `-----BEGIN PRIVATE KEY-----` (or `BEGIN RSA PRIVATE KEY`, `BEGIN EC PRIVATE KEY`).
- The server certificate first, followed by the intermediate certificates.
- The private key has no passphrase.
- The certificate lists the host name users open.

A `.cer` or `.der` file from Windows is often in DER format. Convert it first: `openssl x509 -inform DER -in mscd.cer -out mscd.pem`.

The installer checks the format, that the key matches, the expiry date (it warns when less than 30 days remain) and the host name, and tests the pair in NGINX before it replaces the installed one. The previous pair is kept as `tls.crt.bak` and `tls.key.bak`. Renew the same way. Turn on HSTS only with a certificate that browsers trust.

## 5. First administrator

If you passed `--admin-email`, the installer printed a one-time invitation link. Otherwise create it now (from the install directory):

```bash
cd /opt/mscd
sudo docker compose run --rm cli admin create-user --email ana.wijaya@acme.co.id --tenant-admin
```

The command prints a one-time link that is valid for 72 hours. Send it to the administrator through a trusted channel. The administrator opens it, sets a password and enrols an authenticator app (TOTP). Multi-factor sign-in is always on for local accounts.

The administrator (role Tenant Admin) then installs the licence (section 6), invites the other users (section 8) and grants their roles per management system.

## 6. Licence

Until a licence is installed, the organisation has its first Tenant Admin and nothing else: no further users, management systems or features. CyberLentera issues a licence file (signed JSON) for your installation. It is bound to the installation id, which identifies this database.

1. Find the installation id:

   ```bash
   cd /opt/mscd
   sudo docker compose exec postgres psql -U postgres -d mscd -tAc "select id from platform.installation"
   ```

   With your own PostgreSQL (section 11), ask your database administrator to run the same query in the MSCD database.

2. Send the installation id and your organisation name to CyberLentera. You receive the licence file.

3. Sign in as the Tenant Admin and install the licence with the helper of section 7:

   ```js
   await mscd('PUT', '/admin/license', <paste the content of the licence file here>)
   ```

   The answer shows the licence with `"state": "valid"`. A licence for another installation is refused with `LIC-BINDING`.

The licence names the frameworks, the number of users and management systems, the storage adapters and the features you may use. Before it expires there is a grace period with a warning banner. After the grace period MSCD becomes read-only until a new licence is installed. Background jobs and exports keep running. The installation id changes only when the database is created again, so restore backups instead of reinstalling (section 15).

## 7. Administration settings

Some settings have no screen in this release: the licence, identity providers, the local sign-in policy and file repositories. You change them through the MSCD API, from the browser in which you are signed in as Tenant Admin. No extra tool is needed.

1. Sign in to MSCD as the Tenant Admin.
2. Open the browser's developer tools (F12) and choose the Console tab.
3. Paste this helper once and press Enter:

   ```js
   async function mscd(method, path, body) {
     const me = await (await fetch('/api/v1/me')).json();
     const res = await fetch('/api/v1' + path, {
       method,
       headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
       body: body === undefined ? undefined : JSON.stringify(body),
     });
     const text = await res.text();
     console.log(res.status, text);
     return text ? JSON.parse(text) : null;
   }
   ```

4. Run the commands of the following sections, one at a time. Each prints the HTTP status and the answer. `200`, `201` and `204` mean success. Any other status comes with a message that explains the problem.

`await mscd('GET', '/license')` shows the installed licence, and `await mscd('GET', '/admin/identity-providers')` and `await mscd('GET', '/admin/storage/repositories')` list what is configured. Every change is recorded in the audit trail.

## 8. Sign-in with your identity provider

MSCD supports OpenID Connect (OIDC) and SAML 2.0 identity providers per organisation. This example connects Microsoft Entra ID with OIDC.

1. In the Entra admin center, register an application:
   - Supported account types: accounts in this organisational directory only.
   - Redirect URI (Web): `https://<host name>/api/v1/auth/oidc/entra/callback`. The last but one part, `entra`, is the slug you give the provider in step 2.
   - Create a client secret and note its value, the application (client) id and the directory (tenant) id.

2. In the MSCD console (section 7):

   ```js
   const idp = await mscd('POST', '/admin/identity-providers', {
     slug: 'entra', kind: 'oidc', displayName: 'Sign in with Microsoft', icon: 'microsoft',
     oidc: {
       issuer: 'https://login.microsoftonline.com/<tenant id>/v2.0',
       clientId: '<application id>',
       clientSecret: '<client secret>',
       scopes: 'openid email profile',
       subjectMode: 'entra',
       entraTenantId: '<tenant id>',
     },
   })
   await mscd('POST', `/admin/identity-providers/${idp.id}/test`)
   ```

   `subjectMode: 'entra'` identifies users by their Entra tenant and object id, which never change, and refuses tokens from any other Entra tenant. The test prints `"ok": true` with the endpoints MSCD found. The client secret is encrypted and never shown again.

3. The sign-in page now shows "Sign in with Microsoft".

How accounts are matched: Entra ID tokens carry no verified email, so MSCD never links an account by email. Invite each user. The user receives an invitation email, opens it and chooses "Sign in with Microsoft"; from then on the Microsoft account is linked. To invite a user from the console:

```js
await mscd('POST', '/admin/users', { email: 'budi.santoso@acme.co.id', displayName: 'Budi Santoso', adminRoles: [] })
``` Automatic account creation (`jitProvisioning: true`) needs a provider that sends verified emails and an email domain verified by the operator:

```bash
sudo docker compose run --rm cli tenant verify-domain --org acme --domain acme.co.id --by "Ana Wijaya"
```

Multi-factor: when the token does not show that the user passed multi-factor sign-in, MSCD asks for its own TOTP code after the provider sign-in. Keep this default.

## 9. Local sign-in policy

Local accounts sign in with email, password and TOTP. Decide who may still use them once your identity provider works:

| Policy | Effect |
|---|---|
| `allowed` (default) | Every member may sign in locally |
| `admins_only` | Only Tenant Admins and Storage Admins may sign in locally. Keep this as the emergency access when the identity provider is down. |
| `disabled` | Nobody signs in locally to this organisation. A password reset sends no email. |

```js
await mscd('PATCH', '/admin/organization', { localLogin: 'admins_only' })
```

With `admins_only` or `disabled`, a user who is disabled in your identity provider cannot keep working through a local password.

## 10. Connect file repositories

MSCD keeps evidence and documents in repositories. Every organisation has a Managed Vault: encrypted object storage inside MSCD, ready after installation. You can add SharePoint Online and Google Shared Drives, which MSCD links to without copying the files. Each repository has one root folder per management system, and users can browse and link files only below the root folder of their system.

Repository changes need the Storage Admin or Tenant Admin role, and the licence must include the adapter (`m365` or `google_drive`). The storage gateway connects to Microsoft and Google over HTTPS (section 18).

### 10.1 SharePoint Online

MSCD uses an app registration with the `Sites.Selected` permission, so it reaches only the sites you grant.

1. In the Entra admin center, register an application (for example "MSCD repository"). Under API permissions, add Microsoft Graph, Application permission `Sites.Selected`, and grant admin consent.
2. Create a certificate for the app and upload its public part (`mscd-sp.crt`) under Certificates and secrets:

   ```bash
   openssl req -x509 -newkey rsa:3072 -nodes -days 730 -subj "/CN=MSCD repository" \
     -keyout mscd-sp.key -out mscd-sp.crt
   ```

3. Grant the app write access to your compliance site, for example with PnP PowerShell:

   ```powershell
   Grant-PnPAzureADAppSitePermission -AppId <application id> -DisplayName "MSCD repository" -Site https://acme.sharepoint.com/sites/compliance -Permissions Write
   ```

4. Find the ids with Graph Explorer: the site id (`GET https://graph.microsoft.com/v1.0/sites/acme.sharepoint.com:/sites/compliance`), the document library (`GET .../sites/<site id>/drives`) and the folder ids (`GET .../drives/<drive id>/root:/Compliance` and one folder per system, for example `Compliance/ISMS`).
5. Create the repository in the MSCD console (section 7). The keys of `roots` are the codes of your management systems:

   ```js
   const sp = await mscd('POST', '/admin/storage/repositories', {
     slug: 'sharepoint', name: 'SharePoint Compliance', adapter: 'm365',
     modes: ['link', 'pass_through'], ownershipType: 'organizational',
     metadataMinimization: false, retentionConfirmed: true,
     config: {
       siteId: '<site id>', driveId: '<drive id>', rootFolderId: '<Compliance folder id>',
       roots: { isms: { folderId: '<ISMS folder id>', path: 'Compliance/ISMS' } },
     },
   })
   ```

6. Store the credential. It goes straight to the storage gateway, which encrypts it; MSCD never stores it in clear text. Paste the PEM files between the backquotes:

   ```js
   await mscd('PUT', `/admin/storage/repositories/${sp.ref}/credentials`, {
     kind: 'm365_certificate',
     secret: {
       tenantId: '<tenant id>', clientId: '<application id>',
       certificatePem: `<content of mscd-sp.crt>`,
       privateKeyPem: `<content of mscd-sp.key>`,
     },
   })
   await mscd('POST', `/admin/storage/repositories/${sp.ref}/test`)
   ```

   Delete `mscd-sp.key` from your workstation afterwards.

### 10.2 Google Shared Drive

1. In Google Cloud, create a project, enable the Google Drive API and create a service account with a JSON key.
2. In Google Drive, add the service account email as a Content manager of the Shared Drive.
3. Note the Shared Drive id and the folder ids (the last part of each folder's address in the browser).
4. In the MSCD console:

   ```js
   const gd = await mscd('POST', '/admin/storage/repositories', {
     slug: 'gdrive', name: 'Google Shared Drive', adapter: 'google_drive',
     modes: ['link', 'pass_through'], ownershipType: 'organizational',
     metadataMinimization: false, retentionConfirmed: true,
     config: {
       driveId: '<shared drive id>', rootFolderId: '<Compliance folder id>',
       roots: { bcms: { folderId: '<BCMS folder id>', path: 'Compliance/BCMS' } },
     },
   })
   await mscd('PUT', `/admin/storage/repositories/${gd.ref}/credentials`, {
     kind: 'google_service_account',
     secret: { clientEmail: '<client_email from the JSON key>', privateKeyPem: `<private_key from the JSON key>` },
   })
   await mscd('POST', `/admin/storage/repositories/${gd.ref}/test`)
   ```

### 10.3 Root folders per management system

To add a system to a repository later, change its `roots` (all roots are sent together). A change of the configuration needs the credential again, so repeat the `credentials` command afterwards:

```js
await mscd('PATCH', `/admin/storage/repositories/${sp.ref}`, { config: {
  siteId: '<site id>', driveId: '<drive id>', rootFolderId: '<Compliance folder id>',
  roots: {
    isms: { folderId: '<ISMS folder id>', path: 'Compliance/ISMS' },
    qms: { folderId: '<QMS folder id>', path: 'Compliance/QMS' },
  },
} })
```

## 11. Your own PostgreSQL or S3 storage

By default the bundle runs PostgreSQL and SeaweedFS on the same server. You can use your own PostgreSQL 15 or later, your own S3-compatible storage, or both. Decide before the first installation: moving data later is a separate project.

The steps below prepare the install directory before `install.sh` runs for the first time. The installer keeps files that exist.

### 11.1 Your own PostgreSQL

1. Your database administrator creates an empty database (for example `mscd`) and gives you an administrator account for it.

2. Choose three passwords (for example `openssl rand -hex 24` each) and write the role addresses, one per file:

   ```bash
   sudo install -d -m 0700 /opt/mscd/secrets
   cd /opt/mscd/secrets
   echo -n 'postgres://mscd_migrator:<password 1>@db.acme.co.id:5432/mscd?sslmode=require' | sudo tee db-migrator.url >/dev/null
   echo -n 'postgres://mscd_app:<password 2>@db.acme.co.id:5432/mscd?sslmode=require' | sudo tee db-app.url >/dev/null
   echo -n 'postgres://mscd_pack_installer:<password 3>@db.acme.co.id:5432/mscd?sslmode=require' | sudo tee db-pack.url >/dev/null
   echo -n unused | sudo tee postgres-admin.password postgres-roles.env >/dev/null
   ```

   The last two files belong to the bundled PostgreSQL and stay unused.

3. Create the MSCD roles with the administrator account (from the bundle directory; the server image must be loaded first):

   ```bash
   sudo docker load -i images/mscd-server-<version>-amd64.tar.gz
   sudo docker run --rm \
     -e MSCD_DATABASE_ADMIN_URL='postgres://<admin user>:<admin password>@db.acme.co.id:5432/mscd?sslmode=require' \
     -e MSCD_DATABASE_MIGRATOR_URL="$(sudo cat /opt/mscd/secrets/db-migrator.url)" \
     -e MSCD_DATABASE_URL="$(sudo cat /opt/mscd/secrets/db-app.url)" \
     -e MSCD_DATABASE_PACK_URL="$(sudo cat /opt/mscd/secrets/db-pack.url)" \
     cyberlentera/mscd-server:<version> db bootstrap --with-report-role
   ```

   It prints `db bootstrap: database mscd ready`. The administrator account is not stored anywhere.

4. Turn off the bundled PostgreSQL:

   ```bash
   echo 'COMPOSE_PROFILES=bundled-s3' | sudo tee /opt/mscd/.env >/dev/null
   sudo chmod 0600 /opt/mscd/.env
   ```

5. Run `sudo ./install.sh` as in section 4. It adds the other settings to `.env` and keeps yours.

### 11.2 Your own S3 storage

1. Create a bucket (for example `mscd-vault`) and an access key with read and write access to it. Turn on versioning, and object lock if your storage supports it.

2. Write the key and the settings:

   ```bash
   sudo install -d -m 0700 /opt/mscd/secrets
   cd /opt/mscd/secrets
   echo -n '<access key id>' | sudo tee s3.access >/dev/null
   echo -n '<secret access key>' | sudo tee s3.secret >/dev/null
   echo -n unused | sudo tee s3.json >/dev/null
   sudo tee -a /opt/mscd/.env >/dev/null <<'EOF'
   MSCD_S3_ENDPOINT=https://s3.acme.co.id
   MSCD_S3_BUCKET=mscd-vault
   MSCD_S3_REGION=us-east-1
   EOF
   sudo chmod 0600 /opt/mscd/.env
   ```

   `s3.json` belongs to the bundled SeaweedFS and stays unused.

3. Turn off the bundled SeaweedFS: set `COMPOSE_PROFILES` in `/opt/mscd/.env` to `bundled-db` (or to nothing, `COMPOSE_PROFILES=`, when you also use your own PostgreSQL).

4. Run `sudo ./install.sh` as in section 4.

The storage gateway reaches your PostgreSQL and S3 storage through the `egress` network. Allow these connections in your firewall (section 18).

## 12. Install on Kubernetes with Helm

The chart `helm/mscd-<version>.tgz` runs web, api, worker and storage-gateway as Deployments, and `migrate` as a Job before every install and upgrade. It needs your PostgreSQL 15 or later (prepared as in section 11.1, steps 1 to 3) and your S3 storage (section 11.2, step 1). `helm show values helm/mscd-<version>.tgz` lists every setting with its description.

1. Push the two MSCD images to your registry:

   ```bash
   REGISTRY=registry.acme.co.id
   for f in images/mscd-web-*.tar.gz images/mscd-server-*.tar.gz; do docker load -i "$f"; done
   for i in mscd-web mscd-server; do
     docker tag "cyberlentera/$i:<version>" "$REGISTRY/cyberlentera/$i:<version>"
     docker push "$REGISTRY/cyberlentera/$i:<version>"
   done
   ```

2. Create the namespace with the restricted Pod Security Standard:

   ```bash
   kubectl create namespace mscd
   kubectl label namespace mscd pod-security.kubernetes.io/enforce=restricted
   ```

3. Create the secrets. Each component gets its own Secret, and each pod mounts only its own, so the storage key exists only in the storage gateway and the application key never there. With the release name `mscd`:

   | Secret | Files |
   |---|---|
   | `mscd-api` | `db-app.url`, `platform.key`, `gateway.token` |
   | `mscd-worker` | `db-app.url`, `platform.key`, `gateway.token`, `db-pack.url`, `audit-anchor.key` |
   | `mscd-gateway` | `storage.key`, `s3.access`, `s3.secret`, `gateway.token` |
   | `mscd-migrate` | `db-migrator.url`, `db-pack.url` |

   ```bash
   mkdir -m 0700 mscd-secrets && cd mscd-secrets
   # db-*.url from section 11.1, s3.access and s3.secret from section 11.2
   openssl rand -base64 32 | tr -d '\n' > platform.key
   openssl rand -base64 32 | tr -d '\n' > storage.key
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > gateway.token
   docker run --rm --network none -v "$PWD:/out" cyberlentera/mscd-server:<version> keys generate --out /out/keys
   cp keys/audit-anchor.key keys/audit-anchor.pub . && rm -rf keys
   kubectl -n mscd create secret generic mscd-api --from-file=db-app.url --from-file=platform.key --from-file=gateway.token
   kubectl -n mscd create secret generic mscd-worker --from-file=db-app.url --from-file=platform.key \
     --from-file=gateway.token --from-file=db-pack.url --from-file=audit-anchor.key
   kubectl -n mscd create secret generic mscd-gateway --from-file=storage.key --from-file=s3.access \
     --from-file=s3.secret --from-file=gateway.token
   kubectl -n mscd create secret generic mscd-migrate --from-file=db-migrator.url --from-file=db-pack.url
   ```

   Keep the folder `mscd-secrets` in your secrets vault (section 13). For an SMTP login, add `smtp.password` to the api and worker Secrets and set `secrets.smtpPassword: true`.

4. Create the TLS secret of the ingress: `kubectl -n mscd create secret tls mscd-tls --cert=fullchain.pem --key=mscd.key`.

5. Copy the reference values next to the bundle directory, so later versions can use them, and edit the copy:

   ```bash
   cp helm/values-ha.yaml ../my-values.yaml
   ```

   | Setting | Set to |
   |---|---|
   | `image.server.repository`, `image.web.repository` | Your registry paths from step 1 |
   | `profile.http.public_url` | `https://<host name>` |
   | `profile.mail.from`, `profile.mail.smtp` | Your SMTP relay |
   | `profile.gateway.vault.endpoint`, `.bucket`, `.region` | Your S3 storage |
   | `ingress.className`, `ingress.hosts`, `ingress.tls` | Your ingress class and host name |
   | `ingress.trustedCidrs` | Address range of your ingress controller pods. The web pods take the client address from `X-Forwarded-For` only from these. |
   | `api.trustedProxyCidrs` | Pod address range of your cluster (where the web pods run). The api takes the client address only from these. |
   | `networkPolicy.ingressFrom` | The namespace of your ingress controller. Empty allows any source. |
   | `networkPolicy.database.cidrs`, `.objectStore.cidrs`, `.smtp.cidrs` | Addresses of your PostgreSQL, S3 storage and SMTP relay |
   | `certManager.enabled` | `true` when cert-manager issues the internal certificates; otherwise set `certs.generate: true` |

6. Install and check:

   ```bash
   helm install mscd helm/mscd-<version>.tgz --namespace mscd -f ../my-values.yaml --wait --timeout 15m
   helm -n mscd test mscd
   ```

   The `migrate` Job runs first and applies every database change and the framework packs. `helm test` prints `Phase: Succeeded`.

7. Create the organisation and the first administrator. The commands run in the worker pod, which reaches the database and the storage gateway; the migrator address is passed for this one command only:

   ```bash
   MIGRATOR_URL=$(kubectl -n mscd get secret mscd-migrate -o jsonpath='{.data.db-migrator\.url}' | base64 -d)
   kubectl -n mscd exec deploy/mscd-worker -- env MSCD_DATABASE_MIGRATOR_URL="$MIGRATOR_URL" \
     node apps/server/dist/main.js tenant create --slug acme --name "PT Acme Indonesia"
   kubectl -n mscd exec deploy/mscd-worker -- env MSCD_DATABASE_MIGRATOR_URL="$MIGRATOR_URL" \
     node apps/server/dist/main.js admin create-user --email ana.wijaya@acme.co.id --tenant-admin
   unset MIGRATOR_URL
   ```

   The second command prints the one-time invitation link (section 5). For the licence, the installation id is in the table `platform.installation` of your database (section 6).

Upgrades: push the new images, then `helm upgrade mscd helm/mscd-<new version>.tgz -n mscd -f ../my-values.yaml --wait --timeout 15m`. The `migrate` Job runs before any pod is replaced. Roll back with `helm history mscd -n mscd` and `helm rollback mscd <revision> -n mscd`.

## 13. Secrets and keys

`/opt/mscd/secrets` holds everything MSCD needs to open its data. Each file is readable only by the service that uses it.

| File | Purpose |
|---|---|
| `platform.key` | Encrypts sign-in secrets, identity provider secrets and repository credentials |
| `storage.key` | Encrypts the data keys of the Managed Vault files (storage gateway only) |
| `gateway.token`, `gateway.token.previous` | Shared token of api, worker and storage gateway |
| `db-*.url`, `postgres-admin.password`, `postgres-roles.env` | Database passwords |
| `s3.access`, `s3.secret`, `s3.json` | Object storage key |
| `audit-anchor.key`, `audit-anchor.pub` | Signs the audit trail anchors (worker only); the public key checks them |
| `ca.crt`, `ca.key`, `gateway.*`, `api.*`, `worker.*` | Internal certificate authority and the certificates for the encrypted connection to the storage gateway |
| `smtp.password` | SMTP password, when your relay needs one |

**Back up this folder.** Without `platform.key` and `storage.key`, a database backup and the stored files cannot be opened. Keep a copy in your secrets vault, separate from the data backups (section 15). The installer creates missing files and never overwrites existing ones. The internal certificates are renewed automatically by `install.sh` and `upgrade.sh` when fewer than 30 days remain.

### Rotate the gateway token

Do this once a year, or at once when the token may have leaked:

```bash
cd /opt/mscd
sudo cp secrets/gateway.token secrets/gateway.token.previous
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | sudo tee secrets/gateway.token >/dev/null
sudo docker compose up -d --force-recreate storage-gateway api worker
```

The secret files are mounted one by one, so the three services must be recreated to read the new token. While they restart, the gateway accepts the old and the new token. When all services are healthy again (`sudo docker compose ps`), retire the old token:

```bash
sudo truncate -s 0 secrets/gateway.token.previous
sudo docker compose up -d --force-recreate storage-gateway
```

On Kubernetes, add the old token as `gateway.token.previous` to the `mscd-gateway` Secret, put the new token into all three Secrets (`mscd-api`, `mscd-worker`, `mscd-gateway`), restart the Deployments with `kubectl -n mscd rollout restart deployment`, then remove `gateway.token.previous`.

## 14. Audit trail and anchors

Every change in MSCD writes an entry to an audit trail in the same database transaction. Each entry carries the hash of the entry before it, so the entries form a chain.

Every night the worker checks every chain and writes a signed anchor: the newest entry number and its hash, signed with `audit-anchor.key`. The anchor is kept in three places outside the chain itself:

- one log line `{"event":"audit.anchor", ...}` in the worker log, for your log platform or SIEM,
- an object `audit-anchors/<chain>/<date>.json` in the Managed Vault storage (with object lock when your storage supports it),
- a table in the database, which you can download as a file of signed lines.

What this proves:

- The chain detects any change, removal or insertion of an entry made through the application, because the hashes no longer match. The nightly check reports it (metric `mscd_audit_chain_broken`).
- Together with the anchors kept outside the database, it also detects a rewrite by someone with full database rights. Such a person could recompute the chain, but cannot forge a signed anchor for the rewritten chain without `audit-anchor.key`, which only the worker holds. Compare the anchors in your log platform or in your downloaded files with the chain.

To make the anchors useful, send the worker log to your log platform (section 16), keep object lock on the vault bucket when possible, and download the anchors regularly (Tenant Admin, console of section 7):

```js
const r = await fetch('/api/v1/admin/audit-trail/anchors'); console.log(await r.text())
```

`await mscd('GET', '/admin/audit-trail/verify')` runs the chain check on demand. Keep `secrets/audit-anchor.pub` with your audit records: it checks the anchor signatures.

## 15. Backups, upgrades and rollback

### 15.1 What to back up

| What | Where | How often |
|---|---|---|
| Database | Volume `mscd_pgdata`, or your PostgreSQL | Daily, and before every upgrade |
| Managed Vault files | Volume `mscd_s3data`, or your S3 storage | Daily, and before every upgrade |
| Secrets and settings | `/opt/mscd/secrets`, `.env`, `tls/` | After installation and after every change |

Files in SharePoint and Google Drive stay in those systems and their own backups.

### 15.2 Back up (bundled PostgreSQL and SeaweedFS)

```bash
cd /opt/mscd
B=/var/backups/mscd/$(date +%F)
sudo install -d -m 0700 "$B"
# Database: a consistent dump while MSCD runs
sudo docker compose exec -T postgres pg_dump -U postgres -d mscd --format=custom | sudo tee "$B/mscd.dump" >/dev/null
# Managed Vault files: stop the object store for a consistent copy (users cannot upload during this time)
sudo docker compose stop objectstore
sudo docker run --rm --entrypoint tar -v mscd_s3data:/data:ro -v "$B:/backup" postgres:16.15-alpine czf /backup/s3data.tar.gz -C /data .
sudo docker compose start objectstore
# Secrets and settings
sudo tar czf "$B/mscd-config.tar.gz" -C /opt mscd/.env mscd/secrets mscd/tls
```

The archive `mscd-config.tar.gz` holds the encryption keys: store it separately from the data backups, encrypted, with restricted access. With your own PostgreSQL and S3 storage, use their backup tools, for example `pg_dump` and bucket replication or versioning.

### 15.3 Restore

On the same server, or on a new server with the same MSCD version:

1. Restore the settings and secrets: `sudo tar xzf mscd-config.tar.gz -C /opt`
2. Run `sudo ./install.sh --yes` from the bundle directory of the same version. It uses the restored settings and keys.
3. Restore the data:

   ```bash
   cd /opt/mscd
   sudo docker compose stop web api worker storage-gateway objectstore
   sudo docker run --rm --entrypoint sh -v mscd_s3data:/data -v /var/backups/mscd/<date>:/backup:ro postgres:16.15-alpine \
     -c 'rm -rf /data/* && tar xzf /backup/s3data.tar.gz -C /data'
   sudo docker compose exec -T postgres pg_restore -U postgres -d postgres --clean --if-exists --create < /var/backups/mscd/<date>/mscd.dump
   sudo docker compose up -d --wait
   ```

Test a restore on a separate server at least once a year.

### 15.4 Upgrade

Before every upgrade, take a backup (15.2). Then put the three files of the new release next to the old bundle directory, check and extract them (section 3), and run the new `upgrade.sh`:

```bash
cd mscd-onprem-<new version>
sudo ./upgrade.sh
```

What `upgrade.sh` does:

1. Checks the server, the bundle checksums and the signature.
2. Loads the new images and tests the new web image on its own. If the test fails, nothing changes.
3. Saves your current settings in `/opt/mscd/backups/`.
4. Runs the database changes of the new version while the old version keeps running. If they fail, nothing else changes, the old version keeps running and the log of `migrate` is shown.
5. Replaces the services and checks them through the published ports. If the new version does not become healthy, the previous version starts again automatically.

Settings, secrets, certificates and data are kept. Users see a short interruption while the services are replaced.

Options: `--dir DIR`, `--verify-key FILE`, `--skip-signature-check` (not recommended), `--skip-canary` (not recommended), `--timeout SECONDS` (default 600), `--yes`.

### 15.5 Roll back

```bash
sudo /opt/mscd/upgrade.sh --rollback
```

This starts the previous images with the settings saved before the last upgrade. Database changes are made so that the previous release still works with them, so a rollback keeps your data. To undo the database changes themselves, restore the backup taken before the upgrade (15.3).

The previous images stay on the server for a rollback. When you no longer need them, remove them, for example `sudo docker image rm cyberlentera/mscd-web:<old version> cyberlentera/mscd-server:<old version>`.

## 16. Everyday operations

Run these in the install directory (`cd /opt/mscd`):

| Task | Command |
|---|---|
| Status | `sudo docker compose ps` |
| Logs | `sudo docker compose logs --tail 100 api worker storage-gateway web` |
| Follow the logs | `sudo docker compose logs -f api worker` |
| Restart | `sudo docker compose restart` |
| Stop and start | `sudo docker compose stop`, `sudo docker compose up -d --wait` |
| Change a setting | Run `sudo ./install.sh` again from the bundle directory with the new option |
| Invite a Tenant Admin | `sudo docker compose run --rm cli admin create-user --email <email> --tenant-admin` |
| Verify an email domain for automatic accounts | `sudo docker compose run --rm cli tenant verify-domain --org <slug> --domain <domain> --by "<your name>"` |
| Server version | `sudo docker compose run --rm cli --version` |

The `cli` service runs operator commands of the MSCD server in a one-off container and removes it afterwards.

Logs are JSON lines, rotated at 10 MB with three files kept per container. Forward them to your log platform with the Docker logging driver of your choice, or collect them from `/var/lib/docker/containers`. They contain no passwords, tokens or sign-in codes.

Settings live in `/opt/mscd/.env`. You can also edit that file and apply it with `sudo docker compose up -d --wait`. Only one MSCD installation can run on a Docker host.

## 17. Troubleshooting

Start with the script output: every `FAIL` line has a `Fix:` line under it. Then check the status and the logs:

```bash
cd /opt/mscd
sudo docker compose ps -a
sudo docker compose logs --tail 100 migrate api worker storage-gateway
```

Each server component reports its own readiness, with the reason when it is not ready:

```bash
sudo docker compose exec api wget -qO- http://127.0.0.1:3000/readyz
sudo docker compose exec worker wget -qO- http://127.0.0.1:9464/readyz
sudo docker compose exec storage-gateway wget -qO- http://127.0.0.1:9464/readyz
```

A Platform Operator account (set up with CyberLentera support) can download a diagnostics archive with `POST /api/v1/ops/diagnostics` (settings without secrets, versions, database change state, queues, the last 1,000 log lines, metrics) and see the health of every component with `GET /api/v1/ops/health`. Send the archive to CyberLentera support; it contains no secret.

| Symptom | Likely cause | Fix |
|---|---|---|
| `FAIL Cannot reach the Docker daemon` | Docker is stopped, or the user has no access to it | Start Docker. Run the script with `sudo`. |
| `FAIL User <name> cannot create /opt/mscd` | Installing without `sudo` into the default directory | Run with `sudo`, or pass `--dir ~/mscd` |
| `FAIL Port 443 (HTTPS) is already in use by another program` | Another web server uses the port | Stop it, or choose another port with `--https-port` |
| `FAIL Checksum mismatch: <file>` | The bundle was damaged in transfer | Copy the bundle again and check it with `sha256sum -c` |
| `FAIL The bundle is signed, but there is no public key to check it with` | `mscd-release.pub` is not next to the bundle directory | Put it there, or pass `--verify-key FILE` |
| `FAIL Bundle signature does not match` | The bundle was not made by CyberLentera, or the wrong key was used | Do not install. Contact CyberLentera support. |
| `ERROR Name your organisation with --org-slug` | `--yes` without the organisation | Add `--org-slug` and `--org-name` |
| `FAIL The database volume mscd_pgdata of an earlier installation exists, but its passwords are gone` | The `secrets` folder was deleted, but the data was kept | Restore `secrets` from your backup. Only for a fresh start: `sudo docker volume rm mscd_pgdata mscd_s3data` (this deletes all data). |
| `migrate` shows `exited (1)` | A database change or pack installation failed | Read `sudo docker compose logs migrate`. Fix the cause (for example the database connection) and run `sudo ./install.sh --yes` again. |
| api not healthy; the log says it cannot connect to the database | Wrong address or password in `secrets/db-app.url`, or a firewall blocks your own PostgreSQL | Check the address, and that the server reaches the database port |
| storage-gateway not healthy; the log names the object storage | Wrong S3 address or key, or the bucket does not exist | Check `MSCD_S3_ENDPOINT`, `secrets/s3.access` and `secrets/s3.secret` |
| Users can sign in but uploads fail | The storage gateway is not ready, or the object storage is full | Check `storage-gateway` readiness and the free disk space |
| Emails do not arrive | SMTP relay address, port or login wrong, or the relay refuses the sender | Run `sudo ./install.sh --yes --smtp-host ... --mail-from ...` again. The worker log shows the relay's answer. |
| Everything is read-only, with a licence banner | The licence and its grace period ended, or the licence cannot be verified | Install a new licence (section 6) |
| `LIC-USERS` when inviting users | No licence yet, or the licence allows no more users | Install a licence, or ask CyberLentera for one with more users |
| `LIC-BINDING` when installing a licence | The licence was made for another installation id | Send the installation id of section 6 to CyberLentera |
| Sign-in with the identity provider ends with an error page | Redirect URI, client secret or tenant id wrong | Run the provider test of section 8 and compare the redirect URI |
| Background jobs stop running and the health view shows `job-outbox` as degraded | The Valkey queue was unreachable for a long time | Fix Valkey, then: `sudo docker compose exec postgres psql -U postgres -d mscd -c "UPDATE platform.job_outbox SET attempts = 0, run_at = now() WHERE dispatched_at IS NULL AND attempts >= 12"` |
| `The new settings did not work and were not kept` | MSCD did not start with the new settings | MSCD runs again with the previous settings. Fix the problem shown and run the installer again. |
| `upgrade.sh` ends with `Upgrade failed and was rolled back` | The new version failed its health check | The previous version is running. Send the printed log lines to CyberLentera support. |
| Some internal networks cannot reach the server after Docker was installed | Docker's networks overlap an internal subnet | Set `default-address-pools` in `/etc/docker/daemon.json` and `MSCD_SUBNET` in `.env` to unused ranges, then restart Docker |
| `curl` on the server returns a proxy error | `HTTPS_PROXY` is set in the shell | Add `--noproxy '*'` to the `curl` command |
| Browser warns about the certificate | Self-signed certificate | Install a certificate from your CA (section 4.4) |

## 18. Network and firewall

Inbound:

| Port | From | Purpose |
|---|---|---|
| 443/TCP (or `--https-port`) | User networks | HTTPS. The only port users need. |
| 80/TCP (or `--http-port`) | User networks or load balancers | Redirect to HTTPS, and `/healthz` for load balancer checks. Optional. |

Outbound, only for what you use (from the `egress` network of the server):

| Destination | From | Needed for |
|---|---|---|
| Your SMTP relay | api, worker, cli | Email: invitations, password reset, notifications |
| Your identity provider, for example `login.microsoftonline.com:443` | api | Sign-in with that provider |
| `graph.microsoft.com:443`, `login.microsoftonline.com:443` | storage-gateway | SharePoint repositories |
| `www.googleapis.com:443`, `oauth2.googleapis.com:443` | storage-gateway | Google Drive repositories |
| Your PostgreSQL (5432) | api, worker, migrate, cli | Only with your own PostgreSQL |
| Your S3 storage | storage-gateway | Only with your own S3 storage |

MSCD sends no telemetry and contacts CyberLentera for nothing. Licences and packs arrive as files. Browsers load everything from the MSCD server; the optional Google Fonts stay off unless you turn on `--external-fonts on`.

## 19. Uninstall

Stop and remove the containers and networks, keeping the data, settings, secrets and images:

```bash
sudo /opt/mscd/uninstall.sh
```

Start again with `cd /opt/mscd && sudo docker compose up -d --wait`, or with `install.sh`.

Remove everything: the data volumes, the install directory with its secrets, the MSCD images and the `mscd` account. This cannot be undone, so take a backup first:

```bash
sudo /opt/mscd/uninstall.sh --purge
```

Both commands ask for confirmation. Add `--yes` to skip it. For an installation in another directory, pass `--dir DIR`. On Kubernetes: `helm uninstall mscd -n mscd`, then delete the Secrets and the database when you no longer need them.

## 20. Security summary

Built in:

- Every MSCD container runs without root, with a read-only file system, no Linux capabilities and no privilege escalation, and with limits on CPU and memory.
- Each service receives only its own secret files. The storage gateway is the only component that holds the storage key and talks to file repositories; the api and worker reach it over mutual TLS with certificates of an internal CA.
- The database, object storage and queue have no outbound network.
- TLS 1.2 and 1.3 only. HTTP redirects to HTTPS. Security headers on every response, including a strict Content-Security-Policy.
- Local accounts always use multi-factor sign-in. Sessions, CSRF protection, rate limits and account lockout are on by default.
- Every change is recorded in a hash-chained audit trail with signed anchors kept outside the database (section 14).
- The release images contain no development keys, test settings or demo data; this is checked before every release. The images are scanned for known vulnerabilities (`SECURITY-SCAN.txt`), and the bundle signature is checked on every install and upgrade.

Recommended:

1. Keep `mscd-release.pub` next to every bundle so the installer checks the signature.
2. Use a certificate from your CA and turn on HSTS.
3. Open the HTTPS port only to user networks. Close the HTTP port when nothing needs the redirect.
4. Connect your identity provider and set the local sign-in policy to `admins_only` (sections 8 and 9).
5. Back up the `secrets` folder separately from the data, and test a restore (section 15).
6. Send the logs to your log platform and keep the audit anchors outside MSCD (section 14).
7. Rotate the gateway token every year (section 13).
8. Keep the host operating system and Docker Engine patched, and install new MSCD releases when they are published.

## 21. Try MSCD on a test server

For evaluations, MSCD can run with its demo organisations on a test server directly from the source repository, without a bundle. The demo uses public demo keys and sample data: never put real data into it, and never expose it as a production system.

On a Linux server with Docker and the Compose plugin, from a clone of the repository:

```bash
bash deploy/scripts/deploy-demo.sh
```

The script builds the demo images from the checkout, starts the stack (`deploy/compose/docker-compose.yml` with the overlays `docker-compose.demo.yml` and `docker-compose.vps.yml`) and prints the address and the demo sign-in. Settings, as environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `MSCD_DEMO_PUBLIC_URL` | `http://<first server address>` | Address people open in the browser |
| `MSCD_PUBLIC_PORT` | 80 | Published web port |
| `MSCD_DEMO_RESET=1` | | Delete the demo data and seed it again |

The repository also has a GitHub Actions workflow "Deploy demo" (`.github/workflows/deploy-demo.yml`), started by hand from the Actions tab. It connects to the test server over SSH and runs the same script. It needs the repository secrets `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY`, optionally the variables `VPS_PORT` and `MSCD_DEMO_PUBLIC_URL`, and a clone of the repository in `~/mscd` on the server.
