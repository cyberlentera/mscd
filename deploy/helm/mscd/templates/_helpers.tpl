{{/* Chart name. */}}
{{- define "mscd.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Release full name, the prefix of every resource name. Kept short enough for component suffixes. */}}
{{- define "mscd.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 40 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 40 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 40 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "mscd.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Selector labels of one component: include "mscd.selectorLabels" (list $ "api") */}}
{{- define "mscd.selectorLabels" -}}
{{- $ctx := index . 0 -}}
app.kubernetes.io/name: {{ include "mscd.name" $ctx }}
app.kubernetes.io/instance: {{ $ctx.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{/* Common labels of one component: include "mscd.labels" (list $ "api") */}}
{{- define "mscd.labels" -}}
{{- $ctx := index . 0 -}}
helm.sh/chart: {{ include "mscd.chart" $ctx }}
{{ include "mscd.selectorLabels" . }}
app.kubernetes.io/version: {{ $ctx.Values.image.server.tag | default $ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ $ctx.Release.Service }}
app.kubernetes.io/part-of: mscd
{{- end }}

{{/* Labels every pod of the release carries (NetworkPolicy default deny). */}}
{{- define "mscd.releaseSelector" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: mscd
{{- end }}

{{- define "mscd.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "mscd.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "mscd.serverImage" -}}
{{- printf "%s:%s" .Values.image.server.repository (.Values.image.server.tag | default .Chart.AppVersion) }}
{{- end }}

{{- define "mscd.webImage" -}}
{{- printf "%s:%s" .Values.image.web.repository (.Values.image.web.tag | default .Chart.AppVersion) }}
{{- end }}

{{/* Name of the Secret of a component: include "mscd.secretName" (list $ "api") */}}
{{- define "mscd.secretName" -}}
{{- $ctx := index . 0 -}}
{{- $component := index . 1 -}}
{{- $existing := index $ctx.Values.secrets.existingSecret $component | default "" -}}
{{- if and $existing (not $ctx.Values.secrets.create) }}
{{- $existing }}
{{- else }}
{{- printf "%s-%s" (include "mscd.fullname" $ctx) $component }}
{{- end }}
{{- end }}

{{/* Name of the TLS Secret of a component (gateway, api, worker). */}}
{{- define "mscd.tlsSecretName" -}}
{{- printf "%s-%s-tls" (include "mscd.fullname" (index . 0)) (index . 1) }}
{{- end }}

{{/* "true" when the chart generates the internal certificates with Helm. */}}
{{- define "mscd.certsGenerate" -}}
{{- $generate := .Values.certs.generate -}}
{{- if kindIs "invalid" $generate }}{{ $generate = .Values.secrets.create }}{{ end -}}
{{- if and $generate (not .Values.certManager.enabled) }}true{{ end -}}
{{- end }}

{{/* "true" when the api, worker and gateway talk mTLS (profile gateway.tls.mode). */}}
{{- define "mscd.mtls" -}}
{{- $server := .Values.profile.gateway.tls.mode | toString -}}
{{- $client := .Values.profile.storage.gateway.tls.mode | toString -}}
{{- if ne $server $client }}
{{- fail (printf "profile gateway.tls.mode (%s) and storage.gateway.tls.mode (%s) must be equal" $server $client) }}
{{- end }}
{{- if eq $server "mtls" }}true{{ end -}}
{{- end }}

{{- define "mscd.apiHost" -}}
{{- printf "%s-api" (include "mscd.fullname" .) }}
{{- end }}

{{- define "mscd.gatewayHost" -}}
{{- printf "%s-gateway" (include "mscd.fullname" .) }}
{{- end }}

{{- define "mscd.webHost" -}}
{{- printf "%s-web" (include "mscd.fullname" .) }}
{{- end }}

{{- define "mscd.postgresHost" -}}
{{- printf "%s-postgres" (include "mscd.fullname" .) }}
{{- end }}

{{- define "mscd.objectstoreHost" -}}
{{- printf "%s-objectstore" (include "mscd.fullname" .) }}
{{- end }}

{{/* Fixed ports of the server components. */}}
{{- define "mscd.apiPort" -}}3000{{- end }}
{{- define "mscd.gatewayPort" -}}8443{{- end }}
{{- define "mscd.metricsPort" -}}9464{{- end }}

{{/*
The deployment profile (I.1): .Values.profile with the keys the chart owns set
over it. Rendered once per template that needs it; the result is the same each
time (no random values).
*/}}
{{- define "mscd.profile" -}}
{{- $p := deepCopy .Values.profile -}}
{{- $mtls := include "mscd.mtls" . -}}
{{- if not .Values.api.trustedProxyCidrs }}
{{- fail "api.trustedProxyCidrs must name the address ranges of the web pods (http.trust_proxy, F.12)" }}
{{- end }}
{{- $scheme := ternary "https" "http" (eq $mtls "true") -}}
{{- $kmsPrevious := list -}}
{{- if and (kindIs "map" $p.kms) (kindIs "map" $p.kms.file) $p.kms.file.previous_paths }}{{ $kmsPrevious = $p.kms.file.previous_paths }}{{ end -}}
{{- $_ := set $p "kms" (dict "provider" "file" "file" (dict "path" "/run/secrets/platform.key" "previous_paths" $kmsPrevious)) -}}
{{- $clientTls := dict "mode" "off" "ca_file" nil "cert_file" nil "key_file" nil -}}
{{- if $mtls }}
{{- $clientTls = dict "mode" "mtls" "ca_file" "/run/secrets/ca.crt" "cert_file" "/run/secrets/client.crt" "key_file" "/run/secrets/client.key" -}}
{{- end }}
{{- $storage := deepCopy (default (dict) $p.storage) -}}
{{- $_ = set $storage "gateway" (dict "url" (printf "%s://%s:%s" $scheme (include "mscd.gatewayHost" .) (include "mscd.gatewayPort" .)) "token_file" "/run/secrets/gateway.token" "tls" $clientTls) -}}
{{- $_ = set $p "storage" $storage -}}
{{- $http := deepCopy (default (dict) $p.http) -}}
{{- $_ = set $http "port" 3000 -}}
{{- $_ = set $http "trust_proxy" (dict "cidrs" .Values.api.trustedProxyCidrs) -}}
{{- $_ = set $p "http" $http -}}
{{- $database := deepCopy (default (dict) $p.database) -}}
{{- $_ = set $database "url_file" "/run/secrets/db-app.url" -}}
{{- $_ = set $database "migrator_url_file" "/run/secrets/db-migrator.url" -}}
{{- $_ = set $database "pack_installer_url_file" "/run/secrets/db-pack.url" -}}
{{- $_ = set $database "admin_url_file" nil -}}
{{- $_ = set $p "database" $database -}}
{{- $_ = set $p "audit" (dict "anchor_key_file" "/run/secrets/audit-anchor.key") -}}
{{- $observability := deepCopy (default (dict) $p.observability) -}}
{{- $_ = set $observability "metrics_port" 9464 -}}
{{- $_ = set $p "observability" $observability -}}
{{- $mail := deepCopy (default (dict) $p.mail) -}}
{{- $smtp := deepCopy (default (dict) $mail.smtp) -}}
{{- if not (hasKey $smtp "user") }}{{ $_ = set $smtp "user" nil }}{{ end -}}
{{- $_ = set $smtp "password_file" (ternary "/run/secrets/smtp.password" nil .Values.secrets.smtpPassword) -}}
{{- $_ = set $mail "smtp" $smtp -}}
{{- $_ = set $p "mail" $mail -}}
{{- $gateway := deepCopy (default (dict) $p.gateway) -}}
{{- $_ = set $gateway "port" 8443 -}}
{{- $_ = set $gateway "token_files" (list "/run/secrets/gateway.token" "/run/secrets/gateway.token.previous") -}}
{{- $storagePrevious := list -}}
{{- if and (kindIs "map" $gateway.kms) (kindIs "map" $gateway.kms.file) $gateway.kms.file.previous_paths }}{{ $storagePrevious = $gateway.kms.file.previous_paths }}{{ end -}}
{{- $_ = set $gateway "kms" (dict "provider" "file" "file" (dict "path" "/run/secrets/storage.key" "previous_paths" $storagePrevious)) -}}
{{- $serverTls := dict "mode" "off" "ca_file" nil "cert_file" nil "key_file" nil -}}
{{- if $mtls }}
{{- $serverTls = dict "mode" "mtls" "ca_file" "/run/secrets/ca.crt" "cert_file" "/run/secrets/gateway.crt" "key_file" "/run/secrets/gateway.key" -}}
{{- end }}
{{- $_ = set $gateway "tls" $serverTls -}}
{{- $vault := deepCopy (default (dict) $gateway.vault) -}}
{{- $_ = set $vault "access_key_file" "/run/secrets/s3.access" -}}
{{- $_ = set $vault "secret_key_file" "/run/secrets/s3.secret" -}}
{{- if .Values.testServices.enabled }}
{{- $_ = set $vault "endpoint" (printf "http://%s:8333" (include "mscd.objectstoreHost" .)) -}}
{{- $_ = set $vault "bucket" "mscd-vault" -}}
{{- $_ = set $vault "force_path_style" true -}}
{{- end }}
{{- $_ = set $gateway "vault" $vault -}}
{{- $_ = set $p "gateway" $gateway -}}
{{- /* A key set to null in a values file is removed by Helm; the profile needs it present. */ -}}
{{- $nullable := list (list "packs" "channel_url") (list "telemetry" "otlp_endpoint") (list "demo" "fixed_today") (list "demo" "keycloak") -}}
{{- range $nullable }}
{{- $section := index $p (index . 0) -}}
{{- if and (kindIs "map" $section) (not (hasKey $section (index . 1))) }}{{ $_ = set $section (index . 1) nil }}{{ end -}}
{{- end }}
{{- $jobs := default (dict) $p.jobs -}}
{{- if and (kindIs "map" $jobs) (kindIs "map" $jobs.bullmq) (not (hasKey $jobs.bullmq "url")) }}{{ $_ = set $jobs.bullmq "url" nil }}{{ end -}}
{{- toYaml $p }}
{{- end }}

{{/* Host and port of a URL for NetworkPolicy ports: include "mscd.urlPort" "http://host:8333" */}}
{{- define "mscd.urlPort" -}}
{{- $u := urlParse . -}}
{{- $hostPort := splitList ":" $u.host -}}
{{- if gt (len $hostPort) 1 }}{{ last $hostPort }}{{ else if eq $u.scheme "https" }}443{{ else }}80{{ end -}}
{{- end }}

{{/* Pod placement and common pod settings of one component: include "mscd.podPlacement" (list $ "api") */}}
{{- define "mscd.podPlacement" -}}
{{- $ctx := index . 0 -}}
{{- $component := index . 1 -}}
{{- if $ctx.Values.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: {{ $ctx.Values.topologySpread.topologyKey }}
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "mscd.selectorLabels" (list $ctx $component) | nindent 8 }}
{{- end }}
{{- with $ctx.Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $ctx.Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $ctx.Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $ctx.Values.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- with $ctx.Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* Replica count of a Deployment that may be autoscaled: include "mscd.replicas" (list $ "api" .Values.api) */}}
{{- define "mscd.replicas" -}}
{{- $ctx := index . 0 -}}
{{- $component := index . 1 -}}
{{- $values := index . 2 -}}
{{- if and $values.autoscaling $values.autoscaling.enabled }}
{{- /* Keep the count the autoscaler chose, and never start below minReplicas. */ -}}
{{- $replicas := int $values.autoscaling.minReplicas -}}
{{- $current := lookup "apps/v1" "Deployment" $ctx.Release.Namespace (printf "%s-%s" (include "mscd.fullname" $ctx) $component) -}}
{{- if $current }}{{ $replicas = max $replicas (int $current.spec.replicas) }}{{ end -}}
{{- $replicas }}
{{- else }}
{{- $values.replicaCount }}
{{- end }}
{{- end }}

{{/* True when more than one pod of a component can run. */}}
{{- define "mscd.multiPod" -}}
{{- $values := . -}}
{{- if or (and $values.autoscaling $values.autoscaling.enabled) (gt (int $values.replicaCount) 1) }}true{{ end -}}
{{- end }}

{{/* Host name for the web redirect: web.config.domain, else the first ingress host. */}}
{{- define "mscd.domain" -}}
{{- if .Values.web.config.domain }}
{{- .Values.web.config.domain }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- first .Values.ingress.hosts }}
{{- end }}
{{- end }}

{{/*
Server container shared settings: include "mscd.serverEnv" (list $ extraEnv)
MSCD_PROFILE_FILE points at the mounted ConfigMap.
*/}}
{{- define "mscd.serverEnv" -}}
{{- $ctx := index . 0 -}}
- name: MSCD_PROFILE_FILE
  value: /etc/mscd/profile.yaml
- name: NODE_ENV
  value: production
{{- with index . 1 }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Volumes of a server pod: the profile, /tmp and the projected secrets. include "mscd.serverVolumes" (list $ "api" "client") */}}
{{- define "mscd.serverVolumes" -}}
{{- $ctx := index . 0 -}}
{{- $component := index . 1 -}}
{{- $certAs := index . 2 -}}
- name: profile
  configMap:
    name: {{ include "mscd.fullname" $ctx }}-profile
- name: tmp
  emptyDir:
    medium: Memory
    sizeLimit: 64Mi
- name: secrets
  projected:
    defaultMode: 0440
    sources:
      - secret:
          name: {{ include "mscd.secretName" (list $ctx $component) }}
      {{- if include "mscd.mtls" $ctx }}
      - secret:
          name: {{ include "mscd.tlsSecretName" (list $ctx $component) }}
          items:
            - key: ca.crt
              path: ca.crt
            - key: tls.crt
              path: {{ $certAs }}.crt
            - key: tls.key
              path: {{ $certAs }}.key
      {{- end }}
{{- end }}

{{- define "mscd.serverVolumeMounts" -}}
- name: profile
  mountPath: /etc/mscd
  readOnly: true
- name: tmp
  mountPath: /tmp
- name: secrets
  mountPath: /run/secrets
  readOnly: true
{{- end }}

{{/* HTTP probes of a server container on a named port. include "mscd.serverProbes" (list $ "http") */}}
{{- define "mscd.serverProbes" -}}
{{- $ctx := index . 0 -}}
{{- $port := index . 1 -}}
startupProbe:
  httpGet:
    path: /healthz
    port: {{ $port }}
  {{- toYaml $ctx.Values.probes.startup | nindent 2 }}
readinessProbe:
  httpGet:
    path: /readyz
    port: {{ $port }}
  {{- toYaml $ctx.Values.probes.readiness | nindent 2 }}
livenessProbe:
  httpGet:
    path: /healthz
    port: {{ $port }}
  {{- toYaml $ctx.Values.probes.liveness | nindent 2 }}
{{- end }}

{{/* Pod annotations that roll the pods when the profile or the chart-made secrets change. */}}
{{- define "mscd.podAnnotations" -}}
checksum/profile: {{ include "mscd.profile" . | sha256sum }}
{{- with .Values.podAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* A secret value: the given value, else the existing Secret key (base64), else the fallback. include "mscd.pickSecret" (list given existing fallback) */}}
{{- define "mscd.pickSecret" -}}
{{- $given := index . 0 -}}
{{- $existing := index . 1 -}}
{{- $fallback := index . 2 -}}
{{- if $given }}{{ $given }}{{ else if $existing }}{{ b64dec $existing }}{{ else }}{{ $fallback }}{{ end -}}
{{- end }}
