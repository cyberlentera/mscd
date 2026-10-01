# MSCD On-Premise Installation Guide

MSCD (Management System Compliance Dashboard) by CyberLentera, release 1.0.0.

Install and run MSCD on your own servers with Docker Compose (one server) or Helm (Kubernetes), including air-gapped networks.

## Contents

1. [What you get](#1-what-you-get)
2. [System requirements](#2-system-requirements)
3. [Quick start](#3-quick-start)
4. [Air-gapped install](#4-air-gapped-install)
5. [TLS options](#5-tls-options)
6. [Kubernetes with Helm](#6-kubernetes-with-helm)
7. [Verification checklist](#7-verification-checklist)
8. [Everyday operations](#8-everyday-operations)
9. [Upgrade and rollback](#9-upgrade-and-rollback)
10. [Uninstall](#10-uninstall)
11. [Backup](#11-backup)
12. [Troubleshooting](#12-troubleshooting)
13. [Firewall and ports](#13-firewall-and-ports)
14. [Security hardening](#14-security-hardening)

## 1. What you get

You receive three files:

| File | Purpose |
|---|---|
| `mscd-onprem-1.0.0.tar.gz` | The offline bundle |
| `mscd-onprem-1.0.0.tar.gz.sha256` | Checksum of the bundle. It shows that the copy is complete. |
| `mscd-release.pub` | CyberLentera public key. It proves that CyberLentera made the bundle. |

Keep the three files together in one directory. The installer looks for `mscd-release.pub` next to the extracted bundle directory and checks the bundle signature with it.

Inside the bundle:

| Path | Contents |
|---|---|
| `install.sh` | Checks the server, installs or reconfigures MSCD |
| `upgrade.sh` | Moves an installation to this version, with automatic rollback |
| `uninstall.sh` | Removes MSCD |
| `images/` | The MSCD container image (loaded with `docker load`) |
| `compose/` | Docker Compose file and settings template |
| `helm/` | Helm chart (`mscd-web-1.0.0.tgz`) and production values (`values-ha.yaml`) |
| `nginx/` | Web server configuration, for review (it is built into the image) |
| `SHA256SUMS`, `SHA256SUMS.sig` | Checksums of every file, and their signature |
| `SECURITY-SCAN.txt` | Result of the vulnerability scan of the image, made before the release was signed |
| `VERSION`, `BUNDLE-INFO` | Release details |
| `INSTALL-ONPREM.md` | This guide |

Nothing is downloaded during installation. The server needs no internet access.

**About this release.** Release 1.0.0 is the MSCD web application with built-in sample data (a fictional organisation). It runs as one web container. The full platform release adds the API, background workers, the database and file storage described in section 2. Use this release to evaluate MSCD, train users and prepare your infrastructure.

## 2. System requirements

### This release

| Item | Requirement |
|---|---|
| Operating system | 64-bit Linux on x86-64 that runs Docker Engine 24 or later |
| CPU | 1 vCPU |
| Memory | 1 GB (the container is limited to 256 MB) |
| Disk | 2 GB free for Docker data, 100 MB for `/opt/mscd` |
| Software | Docker Engine 24+, Docker Compose plugin 2.20+, `openssl`, `sha256sum`, `tar`, and `curl` for the final checks |
| Kubernetes (optional) | Kubernetes 1.25+, Helm 3, an internal container registry, an ingress controller, and metrics-server for autoscaling |
| Browsers | Current Chrome, Edge or Firefox |

Tested with Ubuntu 24.04 LTS, Docker Engine 29.6.2, Docker Compose 5.3.1, k3s 1.34.1 and Helm 3.22.

Run the scripts with `sudo`. The installer then creates a system account named `mscd`, and the container runs as that account.

A member of the `docker` group can install without `sudo` into a directory that user owns, for example `--dir ~/mscd`. The container then runs with that user's ID, and the TLS key belongs to that user. Use `sudo` when you want the dedicated `mscd` account.

### Full platform release (for capacity planning)

The full platform runs these components. You can use your own PostgreSQL, object storage, SMTP, identity provider and backup services.

| Component | Role | Technology |
|---|---|---|
| web | User interface | NGINX container (this release) |
| api | Application API, access control, business rules, licence checks | Application container |
| worker | Scheduled and background jobs: evidence freshness, link checks, notifications, evidence packs, imports | Application container |
| storage-gateway | The only component that talks to file repositories (Microsoft 365, Google Drive, file shares, S3) | Application container |
| database | Structured data and audit trail | PostgreSQL 15 or later, primary and replica |
| queue and cache | Job queue and session cache | Redis, or a PostgreSQL-based queue for small installations |
| object storage | Managed Vault files, evidence packs, imports | S3-compatible storage |
| secrets | Data encryption keys and connector credentials | HashiCorp Vault, an HSM, or an encrypted key file |

Indicative sizing:

| Profile | Users and management systems | Resources |
|---|---|---|
| Small (Docker Compose) | Up to 150 users, 1 to 2 management systems | 1 VM: 8 vCPU, 32 GB RAM, 500 GB SSD; local object storage |
| Medium (Kubernetes) | Up to 1,000 users, up to 6 management systems | 3 worker nodes with 8 vCPU and 32 GB RAM each; PostgreSQL primary and replica; 2 TB object storage |
| Large (Kubernetes) | More than 1,000 users or many subsidiaries | Sized with your infrastructure team |

These figures are indicative. Validate them with a load test before you make them a contractual requirement.

## 3. Quick start

Copy the three files to one directory on the server, then run:

```bash
sha256sum -c mscd-onprem-1.0.0.tar.gz.sha256
tar xzf mscd-onprem-1.0.0.tar.gz
cd mscd-onprem-1.0.0
sudo ./install.sh --verify-key ../mscd-release.pub
```

The installer checks the server and the bundle signature, asks for the host name, the ports and the certificate type, then starts MSCD and prints the address to open. Press Enter to accept a default. Each answer is checked right away, and the question repeats when an answer is not valid.

To install without questions:

```bash
sudo ./install.sh --yes --domain mscd.example.co.id --self-signed --verify-key ../mscd-release.pub
```

Without `sudo`, as a member of the `docker` group, add a directory you own:

```bash
./install.sh --yes --dir ~/mscd --domain mscd.example.co.id --self-signed --verify-key ../mscd-release.pub
```

A successful run ends like this:

```text
==> Verifying
  PASS  HTTP  http://127.0.0.1:80/healthz returned 200
  PASS  HTTPS https://127.0.0.1:443/healthz returned 200
  PASS  HTTPS https://127.0.0.1:443/ returned 200
  PASS  HTTP  http://127.0.0.1:80/ redirects to HTTPS

MSCD 1.0.0 is running.

  Open          https://mscd.example.co.id/
  Install dir   /opt/mscd
  Status        cd /opt/mscd && docker compose ps
  Logs          docker logs mscd-web
  Uninstall     sudo /opt/mscd/uninstall.sh

  The certificate is self-signed, so browsers show a warning. Its SHA-256 fingerprint is
  65:6B:8C:DB:6B:AD:41:3F:E1:23:EA:99:D1:29:7D:9C:11:2B:29:8B:D0:B6:72:C0:F5:BA:B7:AA:CE:4B:1F:AF
  To use a certificate from your CA, run this again with --tls-cert and --tls-key.
```

How the installer protects a running system:

- All checks run before anything changes. When a check fails, the installer prints `FAIL` with a `Fix:` line and stops. Nothing is changed.
- A new certificate is first loaded by NGINX in a test container without network. The installed certificate is replaced only when that test passes.
- When MSCD does not become healthy with new settings, the installer puts back the previous settings and certificate and starts MSCD again.
- Running `install.sh` again is safe. It keeps your settings and only changes what you pass.

Installer options (`./install.sh --help` shows the same list):

| Option | Default | Purpose |
|---|---|---|
| `--domain NAME` | Server host name | Name users open in the browser |
| `--http-port PORT` | 80 | HTTP port on the server |
| `--https-port PORT` | 443 | HTTPS port on the server |
| `--bind-address IP` | 0.0.0.0 | Listen on one IPv4 address only |
| `--self-signed` | Used for new installs | Generate a self-signed certificate |
| `--tls-cert FILE`, `--tls-key FILE` | | Use your certificate and key (PEM) |
| `--http-redirect on/off` | on | Redirect HTTP to HTTPS |
| `--hsts on/off` | off | Send Strict-Transport-Security |
| `--external-fonts on/off` | off | Allow the optional Google Fonts |
| `--verify-key FILE` | `../mscd-release.pub` when present | Public key for the bundle signature |
| `--skip-signature-check` | | Install a signed bundle without checking its signature. Not recommended. |
| `--dir DIR` | /opt/mscd | Install directory |
| `--timeout SECONDS` | 180 | How long to wait for the health check |
| `--yes` | | Ask no questions. Required when there is no terminal, for example in automation. |

Keep the extracted bundle directory. `install.sh` and `upgrade.sh` run from it.

## 4. Air-gapped install

The bundle is self-contained, so the steps are the same as the quick start. Check the files at each hand-over.

1. On the machine that received the release, check the bundle:

   ```bash
   sha256sum -c mscd-onprem-1.0.0.tar.gz.sha256
   ```

2. Check the public key itself once. Compare its fingerprint with the one CyberLentera publishes on the support portal:

   ```bash
   openssl pkey -pubin -in mscd-release.pub -outform DER | sha256sum
   ```

3. Move `mscd-onprem-1.0.0.tar.gz`, `mscd-onprem-1.0.0.tar.gz.sha256` and `mscd-release.pub` to one directory on the server with your approved transfer method.

4. On the server, check the bundle again and extract it:

   ```bash
   sha256sum -c mscd-onprem-1.0.0.tar.gz.sha256
   tar xzf mscd-onprem-1.0.0.tar.gz
   cd mscd-onprem-1.0.0
   ```

5. Optionally, check the signature and every file by hand before running any script:

   ```bash
   openssl dgst -sha256 -verify ../mscd-release.pub -signature SHA256SUMS.sig SHA256SUMS
   sha256sum -c --quiet SHA256SUMS
   ```

   The first command prints `Verified OK`. The second prints nothing when all files match.

6. Install. The installer checks the signature and every file again:

   ```bash
   sudo ./install.sh --yes --domain mscd.example.co.id --self-signed --verify-key ../mscd-release.pub
   ```

The application makes no outbound connections. Browsers load everything from the MSCD server. The optional Google Fonts stay off unless you enable `--external-fonts on`.

## 5. TLS options

MSCD always serves HTTPS. Choose where the certificate comes from.

| Option | Use for | How |
|---|---|---|
| Self-signed | Pilots and labs | `--self-signed` (default for a new install). Browsers show a warning. |
| Certificate from your CA | Production | `--tls-cert` and `--tls-key` |
| TLS at your load balancer | Existing reverse proxy or load balancer | Forward to the HTTPS port, or to the HTTP port with `--http-redirect off` |
| TLS at the Kubernetes Ingress | Kubernetes | See section 6 |

To install or replace a certificate from your CA:

```bash
sudo ./install.sh --yes --tls-cert /etc/pki/mscd/fullchain.pem --tls-key /etc/pki/mscd/mscd.key --hsts on
```

Certificate requirements:

- PEM format: the files start with `-----BEGIN CERTIFICATE-----` and `-----BEGIN PRIVATE KEY-----` (or `BEGIN RSA PRIVATE KEY`, `BEGIN EC PRIVATE KEY`).
- Server certificate first, followed by the intermediate certificates.
- The private key has no passphrase.
- The certificate lists the host name users open.

A `.cer`, `.der` or `.crt` file from Windows is often in DER format. Convert it to PEM first:

```bash
openssl x509 -inform DER -in mscd.cer -out mscd.pem
```

The installer checks the format, that the key matches the certificate, that the certificate has not expired (it warns when less than 30 days remain), and that it covers the host name. It then loads the new pair in NGINX in a test container. Only when that works does it replace the installed pair and restart MSCD. The previous pair is kept as `tls.crt.bak` and `tls.key.bak`. Renew the same way.

Turn on HSTS (`--hsts on`) only with a certificate that browsers trust. The installer keeps HSTS off for self-signed certificates.

If TLS ends at your load balancer and it forwards plain HTTP:

```bash
sudo ./install.sh --yes --http-redirect off
```

The certificate and key are stored in `/opt/mscd/tls/`. The key is readable only by the account the container runs as.

## 6. Kubernetes with Helm

Use Kubernetes for production. You need `kubectl` and `helm` access to the cluster, an internal registry that the cluster can pull from, an ingress controller, and metrics-server (the autoscaler in `values-ha.yaml` uses it). The chart needs no other images, so it works on air-gapped clusters.

1. From the extracted bundle, load the image and push it to your registry:

   ```bash
   docker load -i images/mscd-web-1.0.0-amd64.tar.gz
   REGISTRY=registry.example.internal:5000
   docker tag cyberlentera/mscd-web:1.0.0 "$REGISTRY/cyberlentera/mscd-web:1.0.0"
   docker push "$REGISTRY/cyberlentera/mscd-web:1.0.0"
   ```

2. Create the namespace with the restricted Pod Security Standard, and the TLS secret for the Ingress:

   ```bash
   kubectl create namespace mscd
   kubectl label namespace mscd pod-security.kubernetes.io/enforce=restricted
   kubectl -n mscd create secret tls mscd-tls --cert=fullchain.pem --key=mscd.key
   ```

   `fullchain.pem` and `mscd.key` are your certificate (with intermediates) and key for the host name users open.

3. Copy the production values next to the bundle directory, so later versions can use them too, and edit the copy:

   ```bash
   cp helm/values-ha.yaml ../my-values.yaml
   ```

   In `my-values.yaml`, set:

   | Setting | Set to |
   |---|---|
   | `image.repository` | Your registry path, for example `registry.example.internal:5000/cyberlentera/mscd-web` |
   | `ingress.className` | Your ingress class, for example `nginx` or `traefik` |
   | `ingress.hosts[0].host` and `ingress.tls[0].hosts` | The host name users open |
   | `networkPolicy.ingressFrom` | The namespace of your ingress controller |

4. Install and check:

   ```bash
   helm install mscd-web helm/mscd-web-1.0.0.tgz --namespace mscd -f ../my-values.yaml --wait
   kubectl -n mscd rollout status deployment/mscd-web
   helm -n mscd test mscd-web
   ```

   `helm test` prints `Phase: Succeeded` when the app answers through its Service. With the release name `mscd-web`, all resources are named `mscd-web`. Another release name, such as `mscd`, gives resources named `mscd-mscd-web`.

5. Turn on the HTTP to HTTPS redirect and HSTS in your ingress controller, through `ingress.annotations` or the controller settings. ingress-nginx redirects hosts that have TLS by default and sends HSTS by default. On Traefik, add a redirect middleware and a headers middleware with `stsSeconds`.

What the chart sets up:

| Item | Default |
|---|---|
| Pods | Non-root user 101, read-only root filesystem, all capabilities dropped, seccomp `RuntimeDefault`, no service account token |
| Probes | Readiness and liveness on `/healthz` |
| Updates | Rolling. A pod stops only after its replacement is ready, and keeps serving for 5 seconds while it leaves rotation. |
| NetworkPolicy | Inbound only on the web port; no outbound traffic |
| `values-ha.yaml` | 3 to 6 pods with autoscaling on CPU (needs metrics-server), disruption budget of 2, spread across nodes, Ingress with TLS |

For HTTPS inside the pod as well (end-to-end TLS), set `tls.enabled=true` and `tls.secretName` to a `kubernetes.io/tls` secret. `helm show values helm/mscd-web-1.0.0.tgz` lists every setting with its description.

## 7. Verification checklist

Run these on the MSCD server after installing (the examples use the default ports).

| Check | Command | Expected |
|---|---|---|
| Container is healthy | `cd /opt/mscd && docker compose ps` | `Up ... (healthy)` |
| Health endpoint | `curl -k https://127.0.0.1/healthz` | `ok` |
| App page over HTTPS | `curl -kI https://127.0.0.1/` | `HTTP/2 200` and a `content-security-policy` header |
| HTTP redirects | `curl -I http://127.0.0.1/` | `301` with `Location: https://<host name>/` |
| Running version | `docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' mscd-web` | `1.0.0` |
| Certificate | `echo \| openssl s_client -connect 127.0.0.1:443 2>/dev/null \| openssl x509 -noout -subject -enddate` | Your host name and expiry date |

Then, from a user workstation:

1. Open `https://<host name>/`. A self-signed certificate shows a browser warning until you trust it or install a CA certificate.
2. The Portfolio Overview of the sample organisation "PT Nusantara Digital Teknologi" appears.
3. Open a few menu items and switch the language (EN/ID) at the top right.

## 8. Everyday operations

| Task | Command |
|---|---|
| Status | `cd /opt/mscd && docker compose ps` |
| Logs | `docker logs --tail 50 mscd-web` |
| Restart | `cd /opt/mscd && docker compose restart` |
| Change a setting | Run `sudo ./install.sh` again with the new option, from the bundle directory |

Settings live in `/opt/mscd/.env`. You can also edit that file and apply it with `cd /opt/mscd && docker compose up -d`.

Only one MSCD installation can run on a Docker host. When you point the installer at a second directory, it stops with `FAIL MSCD is already installed in /opt/mscd`.

## 9. Upgrade and rollback

### Docker Compose

Put the three files of the new release in one directory, next to the old bundle, and run the new `upgrade.sh`:

```bash
sha256sum -c mscd-onprem-1.0.1.tar.gz.sha256
tar xzf mscd-onprem-1.0.1.tar.gz
cd mscd-onprem-1.0.1
sudo ./upgrade.sh --verify-key ../mscd-release.pub
```

What `upgrade.sh` does:

1. Checks the server, the bundle checksums and the signature, the same way as the installer.
2. Loads the new image and starts it once on its own with your settings and certificate. If this test fails, the upgrade stops and the running version is not touched. The script removes the image that failed, or prints the command to remove it.
3. Saves your current settings in `/opt/mscd/backups/`.
4. Switches to the new version and checks it through the published ports.
5. If the new version does not become healthy, it restores the previous version automatically and exits with an error.

Settings and certificates are kept. Users see a brief interruption, about one second, while the container is replaced.

To return to the previous version later:

```bash
sudo /opt/mscd/upgrade.sh --rollback
```

The previous image stays on the server for rollback. When you no longer need it, remove it:

```bash
docker image rm cyberlentera/mscd-web:1.0.0
```

After that, a rollback first needs the image again. Load it from the old bundle, then run the rollback:

```bash
docker load -i mscd-onprem-1.0.0/images/mscd-web-1.0.0-amd64.tar.gz
sudo /opt/mscd/upgrade.sh --rollback
```

`upgrade.sh` options:

| Option | Default | Purpose |
|---|---|---|
| `--rollback` | | Return to the version and settings saved before the last upgrade |
| `--verify-key FILE` | `../mscd-release.pub` when present | Public key for the bundle signature |
| `--skip-signature-check` | | Upgrade from a signed bundle without checking its signature. Not recommended. |
| `--skip-canary` | | Switch without the test run of the new image. Not recommended. |
| `--dir DIR` | /opt/mscd | Install directory |
| `--timeout SECONDS` | 180 | How long to wait for the health check |
| `--yes` | | Do not ask for confirmation. Required when there is no terminal. |

### Kubernetes

In the new bundle directory, push the new image (step 1 of section 6, with the new version), then:

```bash
helm upgrade mscd-web helm/mscd-web-1.0.1.tgz --namespace mscd -f ../my-values.yaml --atomic --timeout 5m
```

Pods are replaced one at a time, and old pods keep serving until new ones are ready. With `--atomic`, Helm rolls back by itself if the new pods do not become ready in time.

To return to an earlier version later, find its revision number in the `REVISION` column, then roll back to it (revision 1 in this example):

```bash
helm history mscd-web --namespace mscd
helm rollback mscd-web 1 --namespace mscd
```

Always name the revision. Without it, Helm returns to the revision just before the current one, which can be a failed upgrade.

## 10. Uninstall

### Docker Compose

Stop and remove the container, keeping settings, certificates and images:

```bash
sudo /opt/mscd/uninstall.sh
```

Start it again with `cd /opt/mscd && docker compose up -d`.

Remove everything (install directory, certificates, backups, images and the `mscd` account):

```bash
sudo /opt/mscd/uninstall.sh --purge
```

Both commands ask for confirmation. Add `--yes` to skip it; without a terminal, `--yes` is required. For an installation in another directory, run its own `uninstall.sh`, or pass `--dir DIR`.

### Kubernetes

```bash
helm uninstall mscd-web --namespace mscd
kubectl delete namespace mscd
```

## 11. Backup

This release keeps no business data: the sample data is part of the image. Back up the configuration so you can rebuild the server quickly:

```bash
sudo sh -c 'umask 077 && tar czf mscd-config-backup.tar.gz -C /opt mscd/.env mscd/tls mscd/docker-compose.yml'
```

The archive contains the TLS private key, so it is created readable only by root (mode 0600). Store it like any other secret.

To restore, on the same or a new server, extract the backup into `/opt`, then run the installer of the same release from its bundle directory:

```bash
sudo tar xzf mscd-config-backup.tar.gz -C /opt
sudo ./install.sh --yes
```

The installer picks up the restored settings and certificate, and sets the key owner for the `mscd` account of the new server.

The full platform release adds data that needs regular backups: the PostgreSQL database, the object storage, and the encryption keys in your secrets store. Plan these with your backup team before that release.

On Kubernetes, the chart creates no persistent volumes. Keep `my-values.yaml` and the TLS certificate in your configuration repository.

## 12. Troubleshooting

Start with the script output: every `FAIL` line has a `Fix:` line under it. Then check the logs with `docker logs --tail 50 mscd-web`.

| Symptom | Likely cause | Fix |
|---|---|---|
| `FAIL Cannot reach the Docker daemon` | Docker is stopped, or the user has no access to it | Start the Docker service. Run the script with `sudo`. |
| `FAIL User <name> cannot create /opt/mscd` | Installing without `sudo` into the default directory | Run with `sudo`, or pass `--dir ~/mscd` |
| `FAIL User <name> cannot change the MSCD installation in /opt/mscd` | The installation was made with `sudo` | Run the script with `sudo` |
| `FAIL MSCD is already installed in <dir>` | The installer was pointed at a second directory | Use `--dir <dir>`, or uninstall that installation first |
| `FAIL Port 443 (HTTPS) is already in use by another program` | Another web server uses the port | Stop it, or choose another port with `--https-port` |
| `FAIL Checksum mismatch: <file>` | The bundle was damaged or changed in transfer | Copy the bundle again and check it with `sha256sum -c` |
| `FAIL The bundle is signed, but there is no public key to check it with` | `mscd-release.pub` is not next to the bundle directory | Put it there, or pass `--verify-key FILE` |
| `FAIL Cannot read public key file <path>` | Wrong path, or the file is not the public key | Pass the path of `mscd-release.pub` to `--verify-key` |
| `FAIL Bundle signature does not match` | The bundle was not produced by CyberLentera, or the wrong public key was used | Do not install. Contact CyberLentera support. |
| `FAIL ... is not a PEM certificate` | The certificate is in DER format (often `.cer`) | Convert it: `openssl x509 -inform DER -in mscd.cer -out mscd.pem` |
| `FAIL The certificate and the key do not belong together` | Wrong key file, or the server certificate is not first in the file | Use the key created with this certificate, and put the server certificate first |
| `FAIL ... protected by a passphrase` | Encrypted private key | Export the key without a passphrase |
| `FAIL NGINX cannot load the new certificate and key` | A damaged certificate in the chain file | Check the intermediate certificates in the file. The installed certificate stays in use. |
| `The new settings did not work and were not kept` | MSCD did not start with the new settings, for example a listen address that is not on this server | MSCD runs again with the previous settings. Fix the problem shown and run the installer again. |
| `ERROR MSCD 1.0.0 is installed. Use ./upgrade.sh` | `install.sh` from a newer bundle was run on an older installation | Run `./upgrade.sh` from the new bundle |
| `ERROR No terminal for the ... questions` | The script runs from automation or with input redirected | Add `--yes` |
| Install works on the server, but other computers cannot connect | Host firewall or network firewall | Open the HTTPS port (and HTTP if used) for user networks |
| Browser warns about the certificate | Self-signed certificate | Install a CA certificate (section 5), or trust the self-signed one in the browser |
| Container keeps restarting; log says `tls.key is not readable` | Key file owner or mode was changed by hand | Run `sudo ./install.sh --yes` again; it restores the owner and mode |
| `upgrade.sh` ends with `Upgrade failed and was rolled back` | The new version failed its health check | The previous version is running. Send the printed log lines to CyberLentera support. |
| `FAIL Image cyberlentera/mscd-web:1.0.0 is no longer on this host` during `--rollback` | The previous image was removed | Nothing was changed. Load the image from its bundle (`docker load -i mscd-onprem-1.0.0/images/mscd-web-1.0.0-amd64.tar.gz`) and run the rollback again. |
| `curl` on the server returns a proxy error | `HTTPS_PROXY` is set for the shell | Add `--noproxy '*'` to the `curl` command |
| Some internal networks cannot reach the server after Docker was installed | Docker's bridge network overlaps an internal subnet | Set `default-address-pools` in `/etc/docker/daemon.json` to an unused range and restart Docker |
| Alternative font pairings look like system fonts | Google Fonts are off by default | Expected offline. Use `--external-fonts on` if browsers have internet access. |
| Kubernetes pods show `ImagePullBackOff` | Wrong `image.repository`, or the cluster cannot pull from the registry | Check with `kubectl -n mscd describe pod`, fix the registry path or pull secret |
| HorizontalPodAutoscaler shows `<unknown>` targets | metrics-server is not installed | Install metrics-server, or set `autoscaling.enabled=false` |
| Ingress returns 502 or 504 | NetworkPolicy does not allow your ingress controller | Set `networkPolicy.ingressFrom` to the controller's namespace |
| Pods are rejected with `violates PodSecurity` | The security settings in the values were changed | Keep the chart defaults for `podSecurityContext` and `securityContext` |

## 13. Firewall and ports

### This release

| Port | Direction | Purpose | Needed |
|---|---|---|---|
| 443/TCP (or `--https-port`) | From user networks to the MSCD server | HTTPS | Yes |
| 80/TCP (or `--http-port`) | From user networks or load balancers | Redirect to HTTPS, and `/healthz` for load balancer checks | Optional |
| None | From the MSCD server to the internet | The application needs no outbound access | |
| 443/TCP to `fonts.googleapis.com` and `fonts.gstatic.com` | From user browsers | Optional font pairings, only with `--external-fonts on` | No |

Inside the container, NGINX listens on 8080 (HTTP) and 8443 (HTTPS). On Kubernetes, the Service exposes port 80 (and 443 with `tls.enabled`), and users connect through your ingress controller.

### Full platform release (for planning)

storage-gateway is the only component that connects to file repositories. The api also needs outbound access when you use a cloud identity provider or online updates.

| Destination | From component | Needed |
|---|---|---|
| `graph.microsoft.com`, `login.microsoftonline.com` (443) | storage-gateway | Only with the Microsoft 365 adapter |
| `www.googleapis.com`, `oauth2.googleapis.com` (443) | storage-gateway | Only with the Google Drive adapter |
| `login.microsoftonline.com` (443) | api | Only for sign-in with Microsoft Entra ID |
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` (443) | api | Only for sign-in with Google |
| CyberLentera update and pack channel | api | Only if you choose online updates or online Framework Pack updates |
| Your on-premise identity provider (AD FS, Keycloak, LDAP), SMTP relay, file shares, internal S3 | api, worker, storage-gateway | As configured, inside your network |

You can send all outbound HTTPS from api and storage-gateway through your proxy.

## 14. Security hardening

Built in:

- The container never runs as root. With Docker Compose installed through `sudo`, it runs as the dedicated `mscd` account. Installed by a `docker` group member, it runs with that user's ID. On Kubernetes, it runs as user 101.
- Read-only root filesystem, all Linux capabilities dropped, no privilege escalation, and limits on CPU, memory and processes.
- TLS 1.2 and 1.3 only, with forward-secret ciphers. HTTP redirects to HTTPS by default, always to the configured host name.
- Security headers on every response, including `/healthz`, error pages and the HTTP redirect: Content-Security-Policy (scripts only from the MSCD server), X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and Cross-Origin policies.
- No outbound connections and no telemetry. The page loads no external fonts unless you turn them on.
- The image is built on a current NGINX and Alpine release and scanned for known vulnerabilities before the release is signed. `SECURITY-SCAN.txt` in the bundle shows the result.
- The bundle signature is checked on every install and upgrade.
- The TLS key is readable only by the account the container runs as (the `mscd` account with `sudo`, otherwise the installing user), and `/opt/mscd/.env` only by its owner.
- Container logs rotate at 10 MB, three files kept.
- On Kubernetes: restricted Pod Security Standard, a NetworkPolicy that denies outbound traffic, and no service account token in the pods.

Recommended:

1. Keep `mscd-release.pub` next to every bundle, so the installer checks the signature (section 4).
2. Use a certificate from your CA and turn on HSTS.
3. Allow the HTTPS port only from user networks. If the server has several interfaces, listen on one with `--bind-address`.
4. Close the HTTP port when nothing needs the redirect or the `/healthz` check.
5. Scan the image again in your own registry, and install new MSCD releases when they are published.
6. Keep the host operating system and Docker Engine patched.
7. Send container logs to your log platform. They are available with `docker logs mscd-web`.
