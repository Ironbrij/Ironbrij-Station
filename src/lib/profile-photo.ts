import type { User } from "firebase/auth";

type ProfilePhotoSource =
  | Pick<User, "photoURL" | "providerData">
  | {
      photoUrl?: string | null;
      photoURL?: string | null;
      picture?: string | null;
      providerData?: Array<{ photoURL?: string | null }>;
    }
  | null
  | undefined;

export function resolveProfilePhoto(...sources: ProfilePhotoSource[]): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    const directCandidates = [
      "photoUrl" in source ? source.photoUrl : undefined,
      source.photoURL,
      "picture" in source ? source.picture : undefined,
      ...("providerData" in source
        ? (source.providerData ?? []).map((provider) => provider.photoURL)
        : []),
    ];

    for (const candidate of directCandidates) {
      const url = candidate?.trim();
      if (url && /^https?:\/\//i.test(url)) return url;
    }
  }
  return undefined;
}
