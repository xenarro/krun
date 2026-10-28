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
{{- end }}
- name: KRUN_JOBS_NAMESPACE
  value: {{ .root.Values.jobsNamespace.name | quote }}
- name: KRUN_GATEWAY_INTERNAL_URL
  value: {{ printf "http://krun-gateway-internal.%s.svc:8081" .root.Release.Namespace | quote }}
{{- if eq .component "scheduler" }}
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

{{- define "krun.schedulerStrategy" -}}
type: RollingUpdate
rollingUpdate:
  maxSurge: 1
  maxUnavailable: 0
{{- end }}
