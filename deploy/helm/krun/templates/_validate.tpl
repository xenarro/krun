{{/*
Compare count quantities without float rounding or int64 multiplication overflow.
Keep the literal in ResourceQuota unchanged. Kubernetes quantity.go/suffix.go
use decimal fixed point, decimal SI/exponents, and binary SI; round up to nanos.
Only the integer part is needed to compare with the integer maxRunning.
*/}}
{{- define "krun.quotaExceeded" -}}
{{- $quantity := toString .Values.jobsNamespace.quota.pods -}}
{{- $number := regexFind "^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)" $quantity -}}
{{- $suffix := trimPrefix $number $quantity -}}
{{- $decimal := dict "" 0 "n" -9 "u" -6 "m" -3 "k" 3 "M" 6 "G" 9 "T" 12 "P" 15 "E" 18 -}}
{{- $binary := dict "Ki" 1 "Mi" 2 "Gi" 3 "Ti" 4 "Pi" 5 "Ei" 6 -}}
{{- if or (eq $number "") (not (or (hasKey $decimal $suffix) (hasKey $binary $suffix) (regexMatch "^[eE][+-]?[0-9]+$" $suffix))) -}}
{{- fail "jobsNamespace.quota.pods must be a Kubernetes count quantity" -}}
{{- end -}}
{{- $negative := hasPrefix "-" $number -}}
{{- $number = trimPrefix "+" (trimPrefix "-" $number) -}}
{{- $fraction := last (splitList "." $number) -}}
{{- $scale := int64 0 -}}
{{- if contains "." $number -}}{{- $scale = sub 0 (len $fraction) -}}{{- end -}}
{{- $digits := regexReplaceAll "^0+" (replace "." "" $number) "" -}}
{{- if hasKey $decimal $suffix -}}
{{- $scale = add $scale (index $decimal $suffix) -}}
{{- else if hasKey $binary $suffix -}}
{{/* Each digit product stays below 10240, even for Ei or a large mantissa. */}}
{{- range until (int (index $binary $suffix)) -}}
{{- $product := "" -}}{{- $carry := int64 0 -}}
{{- range reverse (regexFindAll "[0-9]" $digits -1) -}}
{{- $value := add (mul (atoi .) 1024) $carry -}}
{{- $product = printf "%d%s" (mod $value 10) $product -}}
{{- $carry = div $value 10 -}}
{{- end -}}
{{- if gt $carry 0 -}}{{- $product = printf "%d%s" $carry $product -}}{{- end -}}
{{- $digits = $product -}}
{{- end -}}
{{- else -}}
{{- $scale = add $scale (atoi (substr 1 (len $suffix) $suffix)) -}}
{{- end -}}
{{/* Match Quantity's sub-nano rounding before taking the integer part. */}}
{{- if and (ne $digits "") (lt $scale -9) -}}
{{- $cut := add (len $digits) (add $scale 9) -}}
{{- if le $cut 0 -}}
{{- $digits = "1" -}}
{{- else -}}
{{- $tail := substr (int $cut) (len $digits) $digits -}}
{{- $digits = substr 0 (int $cut) $digits -}}
{{- if regexMatch "[1-9]" $tail -}}
{{- $rounded := "" -}}{{- $carry := int64 1 -}}
{{- range reverse (regexFindAll "[0-9]" $digits -1) -}}
{{- $value := add (atoi .) $carry -}}
{{- $rounded = printf "%d%s" (mod $value 10) $rounded -}}
{{- $carry = div $value 10 -}}
{{- end -}}
{{- if gt $carry 0 -}}{{- $rounded = printf "1%s" $rounded -}}{{- end -}}
{{- $digits = $rounded -}}
{{- end -}}
{{- end -}}
{{- $scale = int64 -9 -}}
{{- end -}}
{{- $max := toString (int64 .Values.config.maxRunning) -}}
{{- $length := add (len $digits) $scale -}}
{{- if eq $digits "" -}}
{{- gt (int64 $max) 0 -}}
{{- else if $negative -}}
true
{{- else if eq $max "0" -}}
false
{{- else if lt $length (int64 (len $max)) -}}
true
{{- else if eq $length (int64 (len $max)) -}}
{{/* Padding is bounded by maxRunning's length, not an untrusted exponent. */}}
{{- $whole := substr 0 (len $max) (printf "%s%s" $digits (repeat (len $max) "0")) -}}
{{- gt $max $whole -}}
{{- else -}}
false
{{- end -}}
{{- end -}}

{{- define "krun.validate" -}}
{{- if not (trim .Values.apiKeys.existingSecret) -}}
{{- fail "apiKeys.existingSecret must name an existing Secret containing keys.yaml" -}}
{{- end -}}
{{- if not (has .Values.db.mode (list "postgres" "embedded")) -}}
{{- fail "db.mode must be postgres or embedded" -}}
{{- end -}}
{{- if and .Values.jobsNamespace.create (eq (include "krun.quotaExceeded" .) "true") -}}
{{- fail "config.maxRunning exceeds jobsNamespace.quota.pods; raise the quota or lower maxRunning" -}}
{{- end -}}
{{- if and .Values.webhooks.allowedHosts (not (trim .Values.webhooks.existingSecret)) -}}
{{- fail "webhooks.existingSecret must name an existing Secret when webhooks.allowedHosts is set" -}}
{{- end -}}
{{- if .Values.objectStorage.enabled -}}
{{- range $key := list "endpoint" "bucket" "existingSecret" -}}
{{- if not (trim (index $.Values.objectStorage $key)) -}}
{{- fail (printf "objectStorage.%s is required when objectStorage.enabled is true" $key) -}}
{{- end -}}
{{- end -}}
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
