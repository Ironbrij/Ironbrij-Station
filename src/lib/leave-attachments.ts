export const MAX_LEAVE_ATTACHMENTS = 3;

/**
 * Shrinks a picked image to a small JPEG data URL (about 100 KB), so it can sit
 * on the leave request itself: no storage bucket, and three fit well under
 * Firestore's 1 MB document limit.
 */
export async function imageToDataUrl(file: File, maxSide = 1100): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Only images can be attached.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read that image.");
  context.fillStyle = "#fff"; // transparent PNGs would turn black as JPEG
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

/**
 * Puts the pictures in Firebase Storage and returns their links. If Storage is
 * unavailable the small data URLs are kept as they are, so the request still
 * goes through with its pictures.
 */
export async function uploadAttachments(images: string[], employeeId: string): Promise<string[]> {
  if (images.length === 0) return images;
  try {
    const { getStorage, ref, uploadBytes, getDownloadURL } = await import("firebase/storage");
    (await import("@/lib/firebase")).db(); // makes sure the Firebase app is initialised
    const storage = getStorage();
    const stamp = Date.now();
    return await Promise.all(
      images.map(async (image, index) => {
        const blob = await (await fetch(image)).blob();
        const file = ref(storage, `leave-attachments/${employeeId}/${stamp}-${index}.jpg`);
        await uploadBytes(file, blob, { contentType: "image/jpeg" });
        return getDownloadURL(file);
      }),
    );
  } catch {
    return images;
  }
}

/** Only small JPEG data URLs and our own Storage links reach an email or the page. */
export function validAttachments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" &&
        ((item.startsWith("data:image/jpeg;base64,") && item.length < 400_000) ||
          (item.startsWith("https://firebasestorage.googleapis.com/") && item.length < 2_000)),
    )
    .slice(0, MAX_LEAVE_ATTACHMENTS);
}
