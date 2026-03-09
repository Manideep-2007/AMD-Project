# Database Backup & Restore Runbook

**Scope:** PostgreSQL 16 (`nexusops` database)  
**Retention policy:** 30 days daily full dumps, 7 days WAL-based PITR  
**RPO target:** 1 hour | **RTO target:** 30 minutes  
**SOC 2 control:** A1.2 (availability), CC6.1 (logical access to backups)

---

## 1. Prerequisites

```bash
# Required tools
psql --version     # >= 16
pg_dump --version  # >= 16
aws --version      # >= 2 (for S3 off-site upload)

# Required environment variables
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=nexusops
export PGUSER=nexusops_app
# PGPASSWORD should come from a secret manager, not the shell:
export PGPASSWORD=$(vault kv get -field=password secret/nexusops/db)

# S3 bucket for off-site storage
export BACKUP_BUCKET=s3://nexusops-db-backups
```

---

## 2. Manual Full Backup

```bash
# Set a datestamped filename
BACKUP_FILE="nexusops_$(date +%Y%m%dT%H%M%SZ).dump"

# Create a custom-format dump (compressed, parallelisable restore)
pg_dump \
  --format=custom \
  --compress=9 \
  --no-acl \
  --no-owner \
  --file="/tmp/${BACKUP_FILE}" \
  "${PGDATABASE}"

# Verify the dump is not empty and the header is valid
pg_restore --list "/tmp/${BACKUP_FILE}" | head -20

# Upload to S3 with server-side encryption
aws s3 cp \
  "/tmp/${BACKUP_FILE}" \
  "${BACKUP_BUCKET}/full/${BACKUP_FILE}" \
  --sse aws:kms \
  --storage-class STANDARD_IA

# Remove the local copy once uploaded
rm "/tmp/${BACKUP_FILE}"
echo "Backup complete: ${BACKUP_BUCKET}/full/${BACKUP_FILE}"
```

---

## 3. Automated Backup (cron / Docker label)

### 3a. Cron (host or VM)

Add to `crontab -e` on the DB host:

```cron
# Daily full backup at 02:00 UTC
0 2 * * *  /opt/nexusops/scripts/backup-db.sh >> /var/log/nexusops-backup.log 2>&1
```

Create `/opt/nexusops/scripts/backup-db.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

source /opt/nexusops/.env.backup   # exports PGHOST, PGPASSWORD, BACKUP_BUCKET

BACKUP_FILE="nexusops_$(date +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --compress=9 --no-acl --no-owner \
  --file="/tmp/${BACKUP_FILE}" "${PGDATABASE:-nexusops}"

pg_restore --list "/tmp/${BACKUP_FILE}" > /dev/null  # smoke test

aws s3 cp "/tmp/${BACKUP_FILE}" "${BACKUP_BUCKET}/full/${BACKUP_FILE}" \
  --sse aws:kms --storage-class STANDARD_IA

rm "/tmp/${BACKUP_FILE}"

# Prune dumps older than 30 days from S3
aws s3 ls "${BACKUP_BUCKET}/full/" | awk '{print $4}' | while read -r obj; do
  obj_date=$(echo "$obj" | grep -oP '\d{8}')
  cutoff=$(date -d "30 days ago" +%Y%m%d 2>/dev/null || date -v-30d +%Y%m%d)
  [[ "$obj_date" < "$cutoff" ]] && aws s3 rm "${BACKUP_BUCKET}/full/${obj}"
done

echo "[$(date -u +%FT%TZ)] Backup completed: ${BACKUP_FILE}"
```

### 3b. Docker Compose label (Ofelia scheduler)

Add to `docker-compose.yml` alongside the `postgres` service:

```yaml
  db-backup:
    image: schickling/postgres-backup-s3
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DATABASE: nexusops
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      S3_BUCKET: ${BACKUP_BUCKET}
      S3_PREFIX: full/
      SCHEDULE: "@daily"
      S3_SSE: aws:kms
    networks:
      - internal
    restart: unless-stopped
```

---

## 4. Point-in-Time Recovery (PITR) Setup

PITR requires WAL archiving to be enabled in `postgresql.conf`:

```conf
# postgresql.conf — add/edit these lines
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p ${BACKUP_BUCKET}/wal/%f --sse aws:kms'
archive_timeout = 300    # archive at least every 5 minutes
```

Restart Postgres after changing `postgresql.conf`:

```bash
pg_ctlcluster 16 main reload
# or in Docker:
docker compose restart postgres
```

Verify archiving is active:

```sql
SELECT pg_walfile_name(pg_current_wal_lsn()), archived_count, last_archived_wal
FROM pg_stat_archiver;
```

---

## 5. Restore from Full Dump

```bash
# Download the target dump
BACKUP_FILE="nexusops_20260306T020012Z.dump"  # replace with actual filename
aws s3 cp "${BACKUP_BUCKET}/full/${BACKUP_FILE}" "/tmp/${BACKUP_FILE}"

# (Optional) inspect what will be restored
pg_restore --list "/tmp/${BACKUP_FILE}" | less

# Drop and recreate the target database
# WARNING: This destroys all current data — confirm with a second operator before proceeding
psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='nexusops' AND pid <> pg_backend_pid();"
psql -c "DROP DATABASE IF EXISTS nexusops;"
psql -c "CREATE DATABASE nexusops OWNER nexusops_app;"

# Restore
pg_restore \
  --dbname=nexusops \
  --no-acl \
  --no-owner \
  --jobs=4 \
  "/tmp/${BACKUP_FILE}"

echo "Restore complete. Run verification checks (Section 7)."
```

---

## 6. Point-in-Time Restore

```bash
# 1. Stop the application
docker compose stop api worker proxy

# 2. Stop Postgres
docker compose stop postgres

# 3. Restore base backup WAL location
# (Assumes you have a base backup — this example uses pg_basebackup)
# If you only have a logical dump, PITR is not possible from that dump alone.
# PITR requires a base backup + WAL segments.

# 4. Create recovery config
cat > /var/lib/postgresql/16/main/recovery.conf << EOF
restore_command = 'aws s3 cp ${BACKUP_BUCKET}/wal/%f %p'
recovery_target_time = '2026-03-06 14:30:00 UTC'  # adjust to desired point
recovery_target_action = 'promote'
EOF

# 5. Start Postgres in recovery mode
docker compose start postgres

# 6. Monitor recovery progress
docker compose logs -f postgres | grep -E "recovery|redo|consistent"

# 7. Verify (see Section 7), then restart the application
docker compose start api worker proxy
```

---

## 7. Post-Restore Verification Checklist

Run these checks after any restore before re-opening traffic to the application.

```bash
# Connect to the restored database
psql --dbname=nexusops

-- 7a. Row count sanity checks (compare against last-known-good baseline)
SELECT 'workspaces',   COUNT(*) FROM workspaces   UNION ALL
SELECT 'agents',       COUNT(*) FROM agents        UNION ALL
SELECT 'tasks',        COUNT(*) FROM tasks         UNION ALL
SELECT 'audit_events', COUNT(*) FROM audit_events  UNION ALL
SELECT 'tool_calls',   COUNT(*) FROM tool_calls;

-- 7b. Verify audit chain integrity for all workspaces
-- (calls the built-in chain verifier via the API)
```

```bash
# 7c. Via the NexusOps API (once the API is back up)
curl -s -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  http://localhost:3000/api/v1/audit/verify \
  | jq '.workspaces[] | select(.valid == false)'
# Expected output: empty (no broken chains)

# 7d. Confirm immutability triggers are present
psql --dbname=nexusops -c "
SELECT trigger_name, event_object_table, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;"

# Expected triggers:
# audit_events_immutable, compliance_artifacts_immutable,
# tool_calls_immutable, policy_evaluations_immutable,
# tasks_no_delete, tasks_immutable_fields,
# task_approvals_no_delete, task_approvals_decision_immutable

# 7e. Smoke test — run database migrations to confirm schema is current
cd packages/db && pnpm prisma migrate status
```

---

## 8. Backup Rotation & Retention

| Backup type  | Retention | Storage class   |
|--------------|-----------|-----------------|
| Daily dump   | 30 days   | S3 STANDARD_IA  |
| Weekly dump  | 12 months | S3 GLACIER_IR   |
| WAL segments | 7 days    | S3 STANDARD_IA  |

Automate weekly promotion in the backup script by checking `$(date +%u)` (day of week):

```bash
if [[ "$(date +%u)" == "7" ]]; then
  aws s3 cp "/tmp/${BACKUP_FILE}" "${BACKUP_BUCKET}/weekly/${BACKUP_FILE}" \
    --sse aws:kms --storage-class GLACIER_IR
fi
```

---

## 9. Access Control

- Backup S3 bucket uses **bucket policy with explicit deny** for all non-backup IAM roles
- The backup IAM role has `s3:PutObject` + `s3:GetObject` on `${BACKUP_BUCKET}/*` only — no `s3:DeleteObject`
- Restores require a second operator to issue `DROP DATABASE` and must be logged in the incident management system
- Rotation of `PGPASSWORD` does not invalidate existing backups (dumps contain data, not credentials)

---

## 10. Escalation

| Situation                         | Owner          | SLA    |
|-----------------------------------|----------------|--------|
| Backup job failed (alert fires)   | On-call SRE    | 1 h    |
| Audit chain broken post-restore   | Data Eng lead  | 2 h    |
| Full restore drill (quarterly)    | DevOps + Sec   | Planned|

Alert: `nexusops-backup-failure` PagerDuty policy routes to `#ops-alerts` Slack channel.
