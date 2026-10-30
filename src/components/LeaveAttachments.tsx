import { useState } from "react";
import { Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { imageToDataUrl, MAX_LEAVE_ATTACHMENTS } from "@/lib/leave-attachments";

/** Small thumbnails; a click opens the picture full size. */
export function AttachmentThumbs({
  images,
  onRemove,
}: {
  images: string[];
  onRemove?: (index: number) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map((src, index) => (
          <div key={index} className="relative">
            <button type="button" onClick={() => setOpen(src)} aria-label="View attachment">
              <img src={src} alt="" className="h-14 w-14 rounded-lg border object-cover" />
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label="Remove attachment"
                className="absolute -right-1.5 -top-1.5 rounded-full bg-rose-600 p-0.5 text-white"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      {open && (
        <div
          role="dialog"
          aria-label="Attachment"
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <img src={open} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

/** "Attach image" button with its thumbnails, for the leave form. */
export function AttachmentPicker({
  images,
  onChange,
}: {
  images: string[];
  onChange: (images: string[]) => void;
}) {
  async function pick(files: FileList | null) {
    const picked = Array.from(files ?? []).slice(0, MAX_LEAVE_ATTACHMENTS - images.length);
    try {
      const added = await Promise.all(picked.map((file) => imageToDataUrl(file)));
      onChange([...images, ...added]);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  return (
    <div className="space-y-2">
      {images.length < MAX_LEAVE_ATTACHMENTS && (
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-xs font-bold hover:bg-muted">
          <Paperclip className="h-3.5 w-3.5" /> Attach image (up to {MAX_LEAVE_ATTACHMENTS})
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void pick(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
      )}
      <AttachmentThumbs images={images} onRemove={(i) => onChange(images.filter((_, n) => n !== i))} />
    </div>
  );
}
