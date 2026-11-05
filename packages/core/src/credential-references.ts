import type { ModelsDocument } from "./domain";

function collectCredentialReferences(value: unknown): Set<string> {
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      // Windows bridge: `… --secret-get "<id>" --data-dir "<dir>"`.
      for (const match of value.matchAll(/--secret-get\s+"([A-Za-z0-9][A-Za-z0-9._-]{0,127})"/g)) found.add(match[1]);
      // Linux libsecret: `<secret-tool path> lookup service omp-switch credential <id>` (unquoted by contract).
      for (const match of value.matchAll(/secret-tool\s+lookup\s+service\s+omp-switch\s+credential\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})/g)) found.add(match[1]);
      // Linux age: `age -d -i "<identity>" "<userData>/secrets/<id>.age"` (double-quoted, spaces possible).
      for (const match of value.matchAll(/secrets\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.age/g)) found.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) scan(item);
    }
  };
  scan(value);
  return found;
}

/** References that protect credentials still used by provider apiKeys or headers from deletion. */
export function collectReferencedCredentialIds(models: ModelsDocument): Set<string> {
  return collectCredentialReferences(models.providers ?? {});
}

/** Read a single saved credential reference without resolving a secret or executing the command. */
export function credentialIdFromApiKey(apiKey: unknown): string | undefined {
  if (typeof apiKey !== "string" || !apiKey.trimStart().startsWith("!")) return undefined;
  const ids = collectCredentialReferences(apiKey);
  return ids.size === 1 ? ids.values().next().value : undefined;
}
