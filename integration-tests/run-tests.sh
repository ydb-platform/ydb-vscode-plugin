#!/usr/bin/env bash
# Run YDB integration tests: starts local YDB + MinIO, runs tests, cleans up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

YDB_IMAGE="ghcr.io/ydb-platform/local-ydb:25.4"
YDB_CONTAINER="ydb-it"
YDB_PORT=2136
YDB_DATA_DIR="/tmp/ydb-it-data"
YDB_CONFIG_PATH="/ydb_data/cluster/kikimr_configs/config.yaml"
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

port_open() {
    # Use bash built-in /dev/tcp — works everywhere without nc
    (echo >/dev/tcp/localhost/"$1") 2>/dev/null
}

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

# ── start YDB ────────────────────────────────────────────────────────────────
# YDB_USE_IN_MEMORY_PDISKS=false is required: Topics, Views, and Resource Pools
# do not work with in-memory pdisks. YDB_PDISK_SIZE is in bytes (64 GB sparse).
log "Starting YDB ${YDB_IMAGE} ..."
$RT run -d \
    --name "${YDB_CONTAINER}" \
    --network=host \
    -v "${YDB_DATA_DIR}:/ydb_data" \
    -e YDB_USE_IN_MEMORY_PDISKS=false \
    -e YDB_PDISK_SIZE=68719476736 \
    -e GRPC_PORT="${YDB_PORT}" \
    "${YDB_IMAGE}" >/dev/null

# ── wait for YDB to become available ─────────────────────────────────────────
log "Waiting for YDB on port ${YDB_PORT} ..."
for i in $(seq 1 "${WAIT_TIMEOUT}"); do
    if port_open "${YDB_PORT}"; then
        log "YDB ready after ${i}s"
        break
    fi
    if [ "${i}" -eq "${WAIT_TIMEOUT}" ]; then
        $RT logs "${YDB_CONTAINER}" >&2
        die "YDB did not start within ${WAIT_TIMEOUT}s"
    fi
    sleep 1
done

# ── enable required feature flags ────────────────────────────────────────────
# Copy config out, patch on host, copy back, restart container.
log "Enabling feature flags and grpc replication service ..."
TMP_CONFIG="/tmp/ydb-it-config.yaml"
$RT cp "${YDB_CONTAINER}:${YDB_CONFIG_PATH}" "${TMP_CONFIG}"

# Add feature flags if not already present
if ! grep -q 'enable_resource_pools' "${TMP_CONFIG}"; then
    sed -i '/^feature_flags:/a\  enable_resource_pools: true\n  enable_external_data_sources: true\n  enable_streaming_queries: true' "${TMP_CONFIG}"
fi

# Add grpc replication service if not already present
if ! grep -q 'replication' "${TMP_CONFIG}"; then
    sed -i '/^grpc_config:/,/^[^ ]/ { /services:/a\  - replication
    }' "${TMP_CONFIG}"
fi

$RT cp "${TMP_CONFIG}" "${YDB_CONTAINER}:${YDB_CONFIG_PATH}"
rm -f "${TMP_CONFIG}"

# Restart the container so ydbd picks up the new config.
$RT restart "${YDB_CONTAINER}"
log "Waiting for YDB to restart with updated config ..."
for i in $(seq 1 "${WAIT_TIMEOUT}"); do
    if port_open "${YDB_PORT}"; then
        log "YDB restarted after ${i}s"
        break
    fi
    if [ "${i}" -eq "${WAIT_TIMEOUT}" ]; then
        $RT logs "${YDB_CONTAINER}" >&2
        die "YDB did not restart within ${WAIT_TIMEOUT}s"
    fi
    sleep 1
done

# ── install dependencies & compile ───────────────────────────────────────────
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
