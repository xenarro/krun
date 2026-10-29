{{- define "krun.fullname" -}}
{{ .Release.Name }}
{{- end }}

{{- define "krun.publicServiceName" -}}
{{- $release := .Release.Name -}}
{{- if and (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $release) (ne $release "krun-gateway-internal") -}}
{{- $release -}}
{{- else -}}
{{- $public := printf "krun-%s" ($release | replace "." "-") | trunc 63 | trimSuffix "-" -}}
{{- if eq $public "krun-gateway-internal" -}}
{{- printf "krun-%s" $public -}}
{{- else -}}
{{- $public -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "krun.headlessServiceName" -}}
{{- $public := include "krun.publicServiceName" . -}}
{{- $headless := printf "%s-headless" ($public | trunc 54 | trimSuffix "-") -}}
{{- $headless -}}
{{- end }}

{{- define "krun.labels" -}}
app.kubernetes.io/name: krun
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end }}

{{- define "krun.selectorLabels" -}}
app.kubernetes.io/name: krun
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
app.kubernetes.io/component: {{ .component | quote }}
{{- end }}

{{- define "krun.gatewaySelector" -}}
app.kubernetes.io/name: krun
app.kubernetes.io/instance: {{ .Release.Name | quote }}
krun.io/gateway: "true"
{{- end }}

{{- define "krun.image" -}}
{{ printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) | quote }}
{{- end }}

{{- define "krun.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "krun.containerSecurityContext" -}}
{{ include "krun.podSecurityContext" . }}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end }}

{{- define "krun.probes" -}}
readinessProbe:
  httpGet: {path: /readyz, port: {{ . }}}
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
livenessProbe:
  httpGet: {path: /healthz, port: {{ . }}}
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
{{- end }}

{{- define "krun.configEnv" -}}
{{- range $name, $value := .Values.config }}
- name: {{ printf "KRUN_%s" (regexReplaceAll "([a-z0-9])([A-Z])" $name "${1}_${2}" | upper) }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}

{{- define "krun.processEnv" -}}
{{ include "krun.configEnv" .root }}
- name: KRUN_DB_MODE
  value: {{ .root.Values.db.mode | quote }}
{{- if eq .root.Values.db.mode "postgres" }}
- name: KRUN_DB_DSN
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.db.postgres.existingSecret | quote }}
      key: dsn
{{- else }}
- name: KRUN_DB_PATH
  value: /data/krun.db
{{- end }}
- name: KRUN_NAMESPACE
  value: {{ .root.Release.Namespace | quote }}
- name: KRUN_JOBS_NAMESPACE
  value: {{ .root.Values.jobsNamespace.name | quote }}
- name: KRUN_GATEWAY_INTERNAL_URL
  value: {{ printf "http://krun-gateway-internal.%s.svc:8081" .root.Release.Namespace | quote }}
{{- if .root.Values.objectStorage.enabled }}
{{- range $entry := list (dict "env" "KRUN_S3_ENDPOINT" "value" .root.Values.objectStorage.endpoint) (dict "env" "KRUN_S3_BUCKET" "value" .root.Values.objectStorage.bucket) (dict "env" "KRUN_S3_REGION" "value" .root.Values.objectStorage.region) }}
- name: {{ $entry.env }}
  value: {{ $entry.value | quote }}
{{- end }}
{{- range $entry := list (dict "env" "KRUN_S3_ACCESS_KEY" "key" "accessKey") (dict "env" "KRUN_S3_SECRET_KEY" "key" "secretKey") }}
- name: {{ $entry.env }}
  valueFrom:
    secretKeyRef:
      name: {{ $.root.Values.objectStorage.existingSecret | quote }}
      key: {{ $entry.key }}
{{- end }}
{{- end }}
{{- if .root.Values.webhooks.allowedHosts }}
- name: KRUN_WEBHOOK_ALLOWED_HOSTS
  value: {{ join "," .root.Values.webhooks.allowedHosts | quote }}
- name: KRUN_WEBHOOK_ALLOWED_CIDRS
  value: {{ join "," .root.Values.webhooks.allowedCIDRs | quote }}
{{- if eq .component "scheduler" }}
- name: KRUN_WEBHOOK_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.webhooks.existingSecret | quote }}
      key: secret
{{- end }}
{{- end }}
{{- if .root.Values.observability.otlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .root.Values.observability.otlpEndpoint | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ printf "krun-%s" .component | quote }}
- name: OTEL_TRACES_SAMPLER
  value: "parentbased_traceidratio"
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ .root.Values.observability.tracesSampleRatio | quote }}
{{- end }}
{{- if eq .component "scheduler" }}
{{- if .root.Values.jobsNamespace.userNamespaces }}
- name: KRUN_JOB_HOST_USERS
  value: "false"
{{- end }}
- name: KRUN_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- end }}
{{- end }}

{{- define "krun.podLifecycle" -}}
{{- with .Values.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
{{- end }}

{{- define "krun.litestreamContainer" -}}
resources:
  {{- toYaml .Values.scheduler.resources | nindent 2 }}
securityContext:
  {{- include "krun.containerSecurityContext" . | nindent 2 }}
env:
  {{- range $key := list "LITESTREAM_ACCESS_KEY_ID" "LITESTREAM_SECRET_ACCESS_KEY" }}
  - name: {{ $key }}
    valueFrom:
      secretKeyRef:
        name: {{ $.Values.db.embedded.litestream.existingSecret | quote }}
        key: {{ $key }}
  {{- end }}
volumeMounts:
  - {name: data, mountPath: /data}
  - {name: tmp, mountPath: /tmp}
{{- end }}

{{- define "krun.schedulerStrategy" -}}
type: RollingUpdate
rollingUpdate:
  maxSurge: 1
  maxUnavailable: 0
{{- end }}
