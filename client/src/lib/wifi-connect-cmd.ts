/** Match firmware PM_WIFI_SSID_MAX / PM_WIFI_PSK_MAX. */
export const WIFI_SSID_MAX_LEN = 32;
export const WIFI_PSK_MAX_LEN = 64;

/**
 * Quote a CLI argument the way firmware tokenizers expect:
 * double quotes, with \ and " escaped. Always quotes so spaces / apostrophes
 * in SSID or PSK cannot be mis-split (BLE notify or GET /cmd).
 */
export function quoteCliArg(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build `wifi connect …` for provisioning. Empty password becomes "".
 * Callers should validate lengths with {@link validateWifiCredentials} first.
 */
export function formatWifiConnectCmd(ssid: string, password: string): string {
  return `wifi connect ${quoteCliArg(ssid)} ${quoteCliArg(password)}`;
}

export type WifiCredentialError =
  | { ok: true; ssid: string; password: string }
  | { ok: false; message: string };

/** Trim SSID only (PSK may legally have leading/trailing spaces). */
export function validateWifiCredentials(ssidRaw: string, passwordRaw: string): WifiCredentialError {
  const ssid = ssidRaw.trim();
  const password = passwordRaw;

  if (ssid.length === 0) {
    return { ok: false, message: 'SSID is required.' };
  }
  if (ssid.length > WIFI_SSID_MAX_LEN) {
    return { ok: false, message: `SSID is too long (max ${WIFI_SSID_MAX_LEN} characters).` };
  }
  if (password.length > WIFI_PSK_MAX_LEN) {
    return { ok: false, message: `Password is too long (max ${WIFI_PSK_MAX_LEN} characters).` };
  }
  return { ok: true, ssid, password };
}
