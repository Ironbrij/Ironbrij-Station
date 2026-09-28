/**
 * The master admin API key, from the ADMIN_API_KEY secret only. It used to fall
 * back to a key written in the source, which is public, so anyone could use it.
 * With no secret set there is no master key and only minted tokens work.
 */
export function adminMasterKey(): string | null {
  const key = process.env.ADMIN_API_KEY?.trim();
  return key && key.length >= 32 ? key : null;
}

