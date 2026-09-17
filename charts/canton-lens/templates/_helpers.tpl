{{- /*
Shared labels, names and validation for canton-lens.
*/ -}}

{{- define "canton-lens.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "canton-lens.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "canton-lens.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "canton-lens.selectorLabels" -}}
app.kubernetes.io/name: {{ include "canton-lens.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "canton-lens.labels" -}}
helm.sh/chart: {{ include "canton-lens.chart" . }}
{{ include "canton-lens.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "canton-lens.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "canton-lens.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "canton-lens.backendFullname" -}}
{{ include "canton-lens.fullname" . }}-backend
{{- end -}}

{{- define "canton-lens.frontendFullname" -}}
{{ include "canton-lens.fullname" . }}-frontend
{{- end -}}

{{- /*
Backend Service DNS host the nginx frontend proxies to. Port comes from backend.service.port.
*/ -}}
{{- define "canton-lens.backendHost" -}}
{{ include "canton-lens.backendFullname" . }}
{{- end -}}

{{- /*
Normalised basePath without trailing slash ("" = root). Values like "/" become "".
*/ -}}
{{- define "canton-lens.basePath" -}}
{{- $p := default "" .Values.config.basePath -}}
{{- $p = trimSuffix "/" $p -}}
{{- if eq $p "/" -}}{{- print "" -}}{{- else -}}{{- print $p -}}{{- end -}}
{{- end -}}

{{- /*
Fail fast on contradictory auth profiles. VITE_AUTH_MODE is baked into the image, so a
mismatch can only be fixed by rebuilding the frontend image, not by re-templating.
*/ -}}
{{- define "canton-lens.validateAuthModes" -}}
{{- $ledger := .Values.config.ledgerAuthMode -}}
{{- $vite := .Values.config.viteAuthMode -}}
{{- if and (eq $vite "shared-identity") (ne $ledger "shared-identity") -}}
{{- fail "config.viteAuthMode=shared-identity requires config.ledgerAuthMode=shared-identity (rebuild the frontend image or change the backend mode)" -}}
{{- end -}}
{{- if and (or (eq $vite "browser-oidc") (eq $vite "institution-bff")) (ne $ledger "caller-bearer") -}}
{{- fail (printf "config.viteAuthMode=%s requires config.ledgerAuthMode=caller-bearer" $vite) -}}
{{- end -}}
{{- if and (eq $ledger "shared-identity") (ne $vite "shared-identity") -}}
{{- fail "config.ledgerAuthMode=shared-identity requires config.viteAuthMode=shared-identity" -}}
{{- end -}}
{{- if and (eq $ledger "caller-bearer") (or (ne (default "" .Values.config.sharedIdentity.issuer) "") (ne (default "" .Values.config.sharedIdentity.clientId) "") (ne (default "" .Values.config.sharedIdentity.clientSecret) "") (ne (default "" .Values.config.sharedIdentity.scopes) "") (ne (default "" .Values.config.sharedIdentity.audience) "") (ne (default "" .Values.config.sharedIdentity.insecureHttpHosts) "")) -}}
{{- fail "config.sharedIdentity.* must stay unset in caller-bearer mode — the backend refuses to start when any SHARED_IDENTITY_* variable is defined at all, empty included" -}}
{{- end -}}
{{- if eq $ledger "shared-identity" -}}
{{- $si := .Values.config.sharedIdentity -}}
{{- $existing := default "" $si.existingSecret.name -}}
{{- if and (eq (default "" $si.issuer) "") -}}{{- fail "config.sharedIdentity.issuer is required in shared-identity mode" -}}{{- end -}}
{{- if and (eq (default "" $si.clientId) "") -}}{{- fail "config.sharedIdentity.clientId is required in shared-identity mode" -}}{{- end -}}
{{- if and (eq (default "" $si.scopes) "") -}}{{- fail "config.sharedIdentity.scopes is required in shared-identity mode" -}}{{- end -}}
{{- if and (eq $existing "") (eq (default "" $si.clientSecret) "") -}}{{- fail "config.sharedIdentity.clientSecret or config.sharedIdentity.existingSecret.name is required in shared-identity mode" -}}{{- end -}}
{{- end -}}
{{- if eq (default "" .Values.config.ledgerBase) "" -}}
{{- fail "config.ledgerBase is required (the Canton JSON API base URL); there is no default" -}}
{{- end -}}
{{- end -}}

{{- /*
Secret name holding SHARED_IDENTITY_CLIENT_SECRET. Either the chart-created secret or an existing one.
*/ -}}
{{- define "canton-lens.sharedIdentitySecretName" -}}
{{- $existing := default "" .Values.config.sharedIdentity.existingSecret.name -}}
{{- if ne $existing "" -}}
{{- print $existing -}}
{{- else -}}
{{ include "canton-lens.fullname" . }}-shared-identity
{{- end -}}
{{- end -}}
