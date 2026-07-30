import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function ProfileAvatar({
  name,
  photoUrl,
  className,
}: {
  name: string;
  photoUrl?: string;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const showImage = Boolean(photoUrl && failedUrl !== photoUrl);

  useEffect(() => {
    if (failedUrl !== photoUrl) setFailedUrl(undefined);
  }, [photoUrl, failedUrl]);

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      <span>{getInitials(name)}</span>
      {showImage && (
        <img
          src={photoUrl}
          alt={`${name} profile`}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(photoUrl)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function getInitials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("") || "?"
  );
}
