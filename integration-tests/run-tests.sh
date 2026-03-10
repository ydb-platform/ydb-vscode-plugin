#!/usr/bin/env bash
# Run YDB integration tests: starts local YDB + MinIO, runs tests, cleans up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

YDB_IMAGE="ghcr.io/ydb-platform/local-ydb:25.4"
YDB_CONTAINER="ydb-it"
YDB_PORT=2136
YDB_DATA_DIR="/tmp/ydb-it-data"
WAIT_TIMEOUT=120

MINIO_IMAGE="quay.io/minio/minio:latest"
MINIO_CONTAINER="minio-it"
MINIO_PORT=9000

# ── select container runtime (podman preferred, fallback to docker) ──────────
if command -v podman &>/dev/null; then
    RT=podman
elif command -v docker &>/dev/null; then
    RT=docker
else
    echo "ERROR: neither podman nor docker found" >&2; exit 1
fi

# ── helpers ──────────────────────────────────────────────────────────────────
log()  { echo "[run-tests] $*"; }
die()  { echo "[run-tests] ERROR: $*" >&2; exit 1; }

cleanup() {
    log "Cleaning up containers ..."
    $RT rm -f "${YDB_CONTAINER}" >/dev/null 2>&1 || true
    $RT rm -f "${MINIO_CONTAINER}" >/dev/null 2>&1 || true
    rm -rf "${YDB_DATA_DIR}"
}
trap cleanup EXIT

# ── pull images ──────────────────────────────────────────────────────────────
for img in "${YDB_IMAGE}" "${MINIO_IMAGE}"; do
    log "Pulling ${img} ..."
    $RT pull "${img}"
done

# ── stop existing containers ─────────────────────────────────────────────────
$RT rm -f "${YDB_CONTAINER}" >/dev/null 2>&1 || true
$RT rm -f "${MINIO_CONTAINER}" >/dev/null 2>&1 || true
rm -rf "${YDB_DATA_DIR}"
mkdir -p "${YDB_DATA_DIR}"

# ── start MinIO (S3 for external table tests) ────────────────────────────────
log "Starting MinIO ..."
$RT run -d \
    --name "${MINIO_CONTAINER}" \
    --network=host \
    -e MINIO_ROOT_USER=minioadmin \
    -e MINIO_ROOT_PASSWORD=minioadmin \
    "${MINIO_IMAGE}" server /data --address ":${MINIO_PORT}" >/dev/null

# ── start YDB (first time) to generate default config ────────────────────────
# YDB_USE_IN_MEMORY_PDISKS=false is required: Topics, Views, and Resource Pools
# do not work with in-memory pdisks. YDB_PDISK_SIZE is in bytes (64 GB sparse).
log "Starting YDB ${YDB_IMAGE} to generate config ..."
$RT run -d \
    --name "${YDB_CONTAINER}" \
    --network=host \
    -v "${YDB_DATA_DIR}:/ydb_data" \
    -e YDB_USE_IN_MEMORY_PDISKS=false \
    -e YDB_PDISK_SIZE=68719476736 \
    -e GRPC_PORT="${YDB_PORT}" \
    "${YDB_IMAGE}" >/dev/null

log "Waiting for YDB (health_check) ..."
for i in $(seq 1 "${WAIT_TIMEOUT}"); do
    if $RT exec "${YDB_CONTAINER}" /health_check >/dev/null 2>&1; then
        log "YDB ready after ${i}s"
        break
    fi
    if [ "${i}" -eq "${WAIT_TIMEOUT}" ]; then
        $RT logs "${YDB_CONTAINER}" >&2
        die "YDB did not start within ${WAIT_TIMEOUT}s"
    fi
    sleep 1
done

# ── patch config, then re-run with --config-path ─────────────────────────────
# local_ydb deploy regenerates config.yaml on every start UNLESS --config-path
# is given — in that case it copies the provided file instead of generating.
# We patch the generated config on the host, save it to a separate path,
# then re-run the container pointing --config-path at that file (mounted via -v).
GENERATED_CONFIG="${YDB_DATA_DIR}/cluster/kikimr_configs/config.yaml"
log "Waiting for generated config file ..."
for i in $(seq 1 "${WAIT_TIMEOUT}"); do
    if [ -f "${GENERATED_CONFIG}" ]; then
        log "Config file found after ${i}s"
        break
    fi
    if [ "${i}" -eq "${WAIT_TIMEOUT}" ]; then
        die "Config file did not appear within ${WAIT_TIMEOUT}s"
    fi
    sleep 1
done

log "Patching config: enabling feature flags and replication gRPC service ..."
PATCHED_CONFIG="/tmp/ydb-it-patched-config.yaml"
cp "${GENERATED_CONFIG}" "${PATCHED_CONFIG}"

if ! grep -q 'enable_resource_pools' "${PATCHED_CONFIG}"; then
    sed -i '/^feature_flags:/a\  enable_resource_pools: true\n  enable_external_data_sources: true\n  enable_streaming_queries: true\n  enable_topic_transfer: true' "${PATCHED_CONFIG}"
fi
if ! grep -q '^\s*- replication' "${PATCHED_CONFIG}"; then
    sed -i '/^  services:$/a\  - replication' "${PATCHED_CONFIG}"
fi

$RT rm -f "${YDB_CONTAINER}" >/dev/null 2>&1
rm -rf "${YDB_DATA_DIR}"
mkdir -p "${YDB_DATA_DIR}"

log "Restarting YDB with patched config ..."
$RT run -d \
    --name "${YDB_CONTAINER}" \
    --network=host \
    -v "${YDB_DATA_DIR}:/ydb_data" \
    -v "${PATCHED_CONFIG}:/tmp/ydb-custom-config.yaml:ro" \
    -e YDB_USE_IN_MEMORY_PDISKS=false \
    -e YDB_PDISK_SIZE=68719476736 \
    -e GRPC_PORT="${YDB_PORT}" \
    "${YDB_IMAGE}" \
    --config-path /tmp/ydb-custom-config.yaml >/dev/null

log "Waiting for YDB to restart with updated config ..."
for i in $(seq 1 "${WAIT_TIMEOUT}"); do
    if $RT exec "${YDB_CONTAINER}" /health_check >/dev/null 2>&1; then
        log "YDB restarted after ${i}s"
        break
    fi
    if [ "${i}" -eq "${WAIT_TIMEOUT}" ]; then
        $RT logs "${YDB_CONTAINER}" >&2
        die "YDB did not restart within ${WAIT_TIMEOUT}s"
    fi
    sleep 1
done

# ── wait for system tables (feature flags) to be fully active ────────────────
# health_check passes when gRPC is up, but schema-shard tablets (which enforce
# feature flags) and system tables like .sys/streaming_queries take longer.
# Poll until .sys/resource_pools is queryable — same guarantee as DBeaver tests.
log "Waiting for feature flags and system tables to be active ..."
for i in $(seq 1 "${WAIT_TIMEOUT}"); do
    if $RT exec "${YDB_CONTAINER}" /ydb \
        --endpoint "grpc://localhost:${YDB_PORT}" \
        --database /local \
        yql -s "SELECT 1 FROM \`.sys/resource_pools\` LIMIT 1" \
        >/dev/null 2>&1; then
        log "System tables active after ${i}s"
        break
    fi
    if [ "${i}" -eq "${WAIT_TIMEOUT}" ]; then
        $RT logs "${YDB_CONTAINER}" >&2
        die "System tables did not become active within ${WAIT_TIMEOUT}s"
    fi
    sleep 1
done

# ── install dependencies ──────────────────────────────────────────────────────
log "Installing dependencies ..."
cd "${PROJECT_DIR}"
npm install --legacy-peer-deps

# ── run integration tests ────────────────────────────────────────────────────
log "Running integration tests against grpc://localhost:${YDB_PORT}/local ..."
EXIT_CODE=0
YDB_ENDPOINT="grpc://localhost:${YDB_PORT}" \
YDB_DATABASE="/local" \
S3_ENDPOINT="http://localhost:${MINIO_PORT}" \
npx vitest run --config "${SCRIPT_DIR}/vitest.config.ts" \
    || EXIT_CODE=$?

exit "${EXIT_CODE}"
