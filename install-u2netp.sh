#!/usr/bin/env bash
set -Eeuo pipefail

SITE_ROOT="${1:-/var/www/rockwell-tools-web}"
MODEL_DIR="${SITE_ROOT}/models"
MODEL_PATH="${MODEL_DIR}/u2netp.onnx"
EXPECTED_SHA256="309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
OFFICIAL_URL="https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
MIRROR_URL="https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx?download=true"

mkdir -p "${MODEL_DIR}"
TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

download() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 \
      --output "${TMP_FILE}" "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget --tries=3 --timeout=30 --output-document="${TMP_FILE}" "${url}"
  else
    echo "缺少 curl/wget。请先执行：sudo apt update && sudo apt install -y curl" >&2
    return 127
  fi
}

echo "[1/4] 下载 U²-NetP 模型……"
if ! download "${OFFICIAL_URL}"; then
  echo "官方地址下载失败，改用校验值相同的备用镜像……"
  : > "${TMP_FILE}"
  download "${MIRROR_URL}"
fi

echo "[2/4] 校验 SHA-256……"
ACTUAL_SHA256="$(sha256sum "${TMP_FILE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "校验失败。" >&2
  echo "期望：${EXPECTED_SHA256}" >&2
  echo "实际：${ACTUAL_SHA256}" >&2
  exit 1
fi

echo "[3/4] 安装模型……"
install -m 0644 "${TMP_FILE}" "${MODEL_PATH}"
if id www-data >/dev/null 2>&1; then
  chown www-data:www-data "${MODEL_PATH}" || true
fi

echo "[4/4] 完成"
ls -lh "${MODEL_PATH}"
echo "${ACTUAL_SHA256}  ${MODEL_PATH}"
echo "请刷新 https://tools.rockwell1453.tech 。浏览器端不会再访问 GitHub；模型由本站同域提供。"
