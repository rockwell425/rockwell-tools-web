#!/usr/bin/env bash
set -Eeuo pipefail
BASE_URL="${1:-https://tools.rockwell1453.tech}"
EXPECTED_SHA256="309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

echo "[1/4] 检查首页版本……"
HTML="$(curl --fail --silent --show-error --location --connect-timeout 20 "$BASE_URL/?verify=0.1.3")"
grep -q 'Web 0.1.3' <<<"$HTML" || { echo '首页不是 0.1.3，可能尚未覆盖成功或仍被上游缓存。' >&2; exit 1; }

echo "[2/4] 检查 Service Worker……"
SW="$(curl --fail --silent --show-error --location --connect-timeout 20 "$BASE_URL/sw.js?verify=0.1.3")"
grep -q 'rockwelltools-web-v0.1.3' <<<"$SW" || { echo 'sw.js 不是 0.1.3。' >&2; exit 1; }

echo "[3/4] 下载站内模型并校验……"
curl --fail --silent --show-error --location --connect-timeout 20 -o "$TMP_FILE" "$BASE_URL/models/u2netp.onnx"
ACTUAL="$(sha256sum "$TMP_FILE" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED_SHA256" ]] || { echo "模型校验失败：$ACTUAL" >&2; exit 1; }

echo "[4/4] 通过：页面、Service Worker、同域模型均可用。"
