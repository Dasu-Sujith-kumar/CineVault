import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/desktop-player";

const ASSET_HOST_RE = /^https?:\/\/asset\.localhost\/(.+)$/i;
const ASSET_PROTOCOL_RE = /^asset:\/\/localhost\/(.+)$/i;

function decodeAssetPath(encodedPath: string): string {
  try {
    const decoded = decodeURIComponent(encodedPath);
    if (/^[a-zA-Z]:[\\/]/.test(decoded)) return decoded;
    if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) return decoded.slice(1);
    return decoded;
  } catch {
    return encodedPath;
  }
}

export function assetUrlToFilePath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;

  const hostMatch = trimmed.match(ASSET_HOST_RE);
  if (hostMatch) return decodeAssetPath(hostMatch[1]);

  const protocolMatch = trimmed.match(ASSET_PROTOCOL_RE);
  if (protocolMatch) return decodeAssetPath(protocolMatch[1]);

  return null;
}

export function normalizeStoredImageReference(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return assetUrlToFilePath(trimmed) ?? trimmed;
}

export function isAssetLocalhostUrl(value: string | null | undefined): boolean {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return ASSET_HOST_RE.test(trimmed) || ASSET_PROTOCOL_RE.test(trimmed);
}

export function isRemoteHttpImageUrl(value: string | null | undefined): value is string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(trimmed) && !isAssetLocalhostUrl(trimmed);
}

function isLocalFilePath(value: string): boolean {
  if (/^\/[^/\\]+(?:[?#].*)?$/.test(value)) return false;
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/");
}

export function toImageSrc(value: string | null | undefined, fallback = "/placeholder.svg"): string {
  const normalized = normalizeStoredImageReference(value);
  if (!normalized) return fallback;

  if (isTauriRuntime() && isLocalFilePath(normalized)) {
    return convertFileSrc(normalized);
  }

  return normalized;
}
