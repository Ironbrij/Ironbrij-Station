import React from "react";
import { Building2, User } from "lucide-react";
import type { MentionItem } from "@/lib/types";

interface FormattedAnswerTextProps {
  text: string;
  mentions?: MentionItem[];
  className?: string;
}

export const FormattedAnswerText: React.FC<FormattedAnswerTextProps> = ({
  text,
  mentions,
  className = "",
}) => {
  if (!text) return <span className="text-muted-foreground italic">No answer provided</span>;

  // Build a list of tags to highlight
  const tagsToHighlight = new Map<string, MentionItem>();

  if (mentions && mentions.length > 0) {
    mentions.forEach((m) => tagsToHighlight.set(m.displayTag.toLowerCase(), m));
  }

  // Regex pattern matching @words
  const parts = text.split(/(@[A-Za-z0-9_.\- ]+?)(?=\s|$|[.,!?;:])/g);

  return (
    <div className={`whitespace-pre-wrap leading-relaxed ${className}`}>
      {parts.map((part, index) => {
        if (!part.startsWith("@")) {
          return <React.Fragment key={index}>{part}</React.Fragment>;
        }

        const lowerPart = part.toLowerCase().trim();
        const matchedMention = tagsToHighlight.get(lowerPart);
        const isDept = matchedMention?.type === "department";

        return (
          <span
            key={index}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold mx-0.5 transition-colors align-baseline ${
              isDept
                ? "bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800/50"
                : "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800/50"
            }`}
          >
            {isDept ? (
              <Building2 className="h-3 w-3 shrink-0 text-purple-600 dark:text-purple-400" />
            ) : (
              <User className="h-3 w-3 shrink-0 text-blue-600 dark:text-blue-400" />
            )}
            <span>{part}</span>
          </span>
        );
      })}
    </div>
  );
};
