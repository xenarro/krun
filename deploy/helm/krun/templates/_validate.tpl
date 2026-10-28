{{- define "krun.validate" -}}
{{- if not (trim .Values.apiKeys.existingSecret) -}}
{{- fail "apiKeys.existingSecret must name an existing Secret containing keys.yaml" -}}
{{- end -}}
{{- if not (has .Values.db.mode (list "postgres" "embedded")) -}}
{{- fail "db.mode must be postgres or embedded" -}}
{{- end -}}
{{- if and (eq .Values.db.mode "postgres") (not (trim .Values.db.postgres.existingSecret)) -}}
{{- fail "db.postgres.existingSecret must name an existing Secret containing dsn in postgres mode" -}}
{{- end -}}
{{- end -}}
