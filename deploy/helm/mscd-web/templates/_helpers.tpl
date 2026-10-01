{{/* Chart name. */}}
{{- define "mscd-web.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Release full name, used for resource names. */}}
{{- define "mscd-web.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "mscd-web.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "mscd-web.labels" -}}
helm.sh/chart: {{ include "mscd-web.chart" . }}
{{ include "mscd-web.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: mscd
{{- end }}

{{- define "mscd-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mscd-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}

{{- define "mscd-web.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "mscd-web.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "mscd-web.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}

{{/* True when more than one pod can run, so a disruption budget makes sense. */}}
{{- define "mscd-web.multiPod" -}}
{{- if or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1) }}true{{ end }}
{{- end }}

{{/* Host name for the redirect: config.domain, else the first ingress host. */}}
{{- define "mscd-web.domain" -}}
{{- if .Values.config.domain }}
{{- .Values.config.domain }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- (index .Values.ingress.hosts 0).host }}
{{- end }}
{{- end }}
