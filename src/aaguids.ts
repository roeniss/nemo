// Maps WebAuthn AAGUIDs to friendly authenticator names. The AAGUID identifies
// the make/model of the authenticator that created a passkey, so we can show
// "iCloud Keychain" instead of meaningless transport hints like "hybrid, internal".
export const AAGUIDS: Record<string, string> = {
  // Apple
  "fbfc3007-154e-4ecc-8032-51d60de6b4c2": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (macOS)",
  // Google
  "ea9b8d66-4d01-1d21-3c4c-7960b7bb0b11": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  // Microsoft / Windows Hello
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  // YubiKey
  "2fc0579f-8113-47ea-b116-bb5a8db9202a": "YubiKey 5",
  "73bb0cd4-e502-49b8-9c6f-b59445bf720b": "YubiKey 5C NFC",
  "c1f9a0bc-1dd2-404a-b27f-8e29047a43fd": "YubiKey 5Ci",
  "85203421-48f9-4355-9bc8-8a53846e5083": "YubiKey 5Ci FIPS",
  // 1Password
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  // Bitwarden
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  // Samsung
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
  // Generic / Android
  "b93fd961-f2e6-462f-b122-82002247de78": "Android Fingerprint",
};

export function aaguidToName(aaguid: string | null | undefined): string {
  if (!aaguid) return "Passkey";
  return AAGUIDS[aaguid.toLowerCase()] ?? "Passkey";
}
