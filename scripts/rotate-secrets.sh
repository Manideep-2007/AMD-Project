#!/usr/bin/env bash
# scripts/rotate-secrets.sh — Rotate JWT and encryption secrets
#
# Usage:
#   ./scripts/rotate-secrets.sh [--namespace nexusops] [--dry-run]
#
# Generates new random secrets, updates the K8s secret, and performs
# a rolling restart of all deployments so they pick up new values.
# The old JWT_SECRET remains valid until existing tokens expire (15m).

set -euo pipefail

NAMESPACE="${NAMESPACE:-nexusops}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --namespace=*) NAMESPACE="${arg#*=}" ;;
    --namespace) shift; NAMESPACE="$1" ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

echo "=== NexusOps Secret Rotation ==="
echo "Namespace: $NAMESPACE"
echo "Dry run:   $DRY_RUN"
echo ""

# Generate new secrets
NEW_JWT_SECRET=$(openssl rand -base64 48)
NEW_JWT_REFRESH_SECRET=$(openssl rand -base64 48)
NEW_COOKIE_SECRET=$(openssl rand -base64 32)
NEW_PROXY_SECRET=$(openssl rand -base64 32)
NEW_DB_ENCRYPTION_KEY=$(openssl rand -hex 32)

echo "[1/3] Generated new secrets"

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would patch secret 'nexusops-secrets' in namespace '$NAMESPACE'"
  echo "[DRY RUN] Would restart deployments: api, worker, proxy"
  exit 0
fi

# 2. Patch the Kubernetes secret
echo "[2/3] Patching K8s secret..."
kubectl patch secret nexusops-secrets -n "$NAMESPACE" --type='merge' -p "{
  \"stringData\": {
    \"JWT_SECRET\": \"$NEW_JWT_SECRET\",
    \"JWT_REFRESH_SECRET\": \"$NEW_JWT_REFRESH_SECRET\",
    \"COOKIE_SECRET\": \"$NEW_COOKIE_SECRET\",
    \"PROXY_INTERNAL_SECRET\": \"$NEW_PROXY_SECRET\",
    \"DB_URL_ENCRYPTION_KEY\": \"$NEW_DB_ENCRYPTION_KEY\"
  }
}"

# 3. Rolling restart all deployments to pick up new env
echo "[3/3] Rolling restart of deployments..."
kubectl rollout restart deployment/api deployment/worker deployment/proxy -n "$NAMESPACE"

# Wait for rollouts
kubectl rollout status deployment/api -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/worker -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/proxy -n "$NAMESPACE" --timeout=120s

echo ""
echo "=== Secret rotation complete ==="
echo "Note: Existing access tokens (15m TTL) will expire naturally."
echo "Existing refresh tokens signed with the old JWT_REFRESH_SECRET will be invalid."
echo "Users will need to re-authenticate."
