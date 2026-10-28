{{- define "krun.validate" -}}
{{- if not (trim .Values.apiKeys.existingSecret) -}}
{{- fail "apiKeys.existingSecret must name an existing Secret containing keys.yaml" -}}
{{- end -}}
{{- if not (has .Values.db.mode (list "postgres" "embedded")) -}}
{{- fail "db.mode must be postgres or embedded" -}}
{{- end -}}
{{- if eq .Values.db.mode "embedded" -}}
{{- range $name := list "gateway" "scheduler" -}}
{{- if gt (int (index $.Values $name "replicas")) 1 -}}
{{- fail (printf "%s.replicas must not exceed 1 in embedded mode" $name) -}}
{{- end -}}
{{- end -}}
{{- if .Values.db.embedded.litestream.enabled -}}
{{- if not (trim .Values.db.embedded.litestream.image) -}}
{{- fail "db.embedded.litestream.image must name a pinned image when Litestream is enabled" -}}
{{- end -}}
{{- if not (trim .Values.db.embedded.litestream.existingSecret) -}}
{{- fail "db.embedded.litestream.existingSecret must name an existing Secret when Litestream is enabled" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.db.mode "postgres") (not (trim .Values.db.postgres.existingSecret)) -}}
{{- fail "db.postgres.existingSecret must name an existing Secret containing dsn in postgres mode" -}}
{{- end -}}
{{- end -}}
