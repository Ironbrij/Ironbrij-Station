import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { Building2, User } from "lucide-react";
import { db } from "@/lib/firebase";
import type { Department, Employee, MentionItem } from "@/lib/types";
import {
  buildMentionCandidates,
  extractMentionsFromText,
  type MentionCandidate,
} from "@/lib/mentions";

interface MentionTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  value: string;
  onChange: (value: string, mentions: MentionItem[]) => void;
  currentEmployee: Employee | null;
  placeholder?: string;
  rows?: number;
  className?: string;
  enableMentions?: boolean;
}

export const MentionTextarea: React.FC<MentionTextareaProps> = ({
  value,
  onChange,
  currentEmployee,
  placeholder,
  rows = 3,
  className = "",
  enableMentions = true,
  disabled,
  ...props
}) => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [triggerIndex, setTriggerIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dropPosition, setDropPosition] = useState<"bottom" | "top">("bottom");

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to employees and departments in Firestore
  useEffect(() => {
    if (!enableMentions) return;

    const unsubEmp = onSnapshot(
      collection(db(), "employees"),
      (snapshot) => {
        setEmployees(
          snapshot.docs.map((doc) => ({
            id: doc.id,
            ...(doc.data() as Omit<Employee, "id">),
          })),
        );
      },
      (err) => console.error("MentionTextarea employees error:", err),
    );

    const unsubDept = onSnapshot(
      collection(db(), "departments"),
      (snapshot) => {
        setDepartments(
          snapshot.docs.map((doc) => ({
            id: doc.id,
            ...(doc.data() as Omit<Department, "id">),
          })),
        );
      },
      (err) => console.error("MentionTextarea departments error:", err),
    );

    return () => {
      unsubEmp();
      unsubDept();
    };
  }, [enableMentions]);

  // Build company-isolated mention candidates
  const candidates = useMemo(() => {
    if (!enableMentions) return [];
    return buildMentionCandidates(employees, departments, currentEmployee);
  }, [employees, departments, currentEmployee, enableMentions]);

  // Filter candidates based on current typed query after @
  const filteredCandidates = useMemo(() => {
    if (!isOpen || triggerIndex === null) return [];
    const q = query.toLowerCase().trim();
    if (!q) return candidates;

    return candidates.filter((c) => {
      const nameMatch = c.name.toLowerCase().includes(q);
      const tagMatch = c.displayTag.toLowerCase().includes(q);
      const subtitleMatch = c.subtitle?.toLowerCase().includes(q);
      const deptMatch = c.deptName?.toLowerCase().includes(q);
      return nameMatch || tagMatch || subtitleMatch || deptMatch;
    });
  }, [isOpen, triggerIndex, query, candidates]);

  // Determine smart drop position (render above if space below is limited)
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      const rect = textareaRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < 220 && rect.top > 220) {
        setDropPosition("top");
      } else {
        setDropPosition("bottom");
      }
    }
  }, [isOpen]);

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCandidates.length, query]);

  // Check cursor position and check for active @ mention trigger
  function checkMentionTrigger(text: string, caretPos: number) {
    if (!enableMentions) return;

    // Search backward from caret position for the last @
    const textBeforeCaret = text.slice(0, caretPos);
    const lastAtPos = textBeforeCaret.lastIndexOf("@");

    if (lastAtPos !== -1) {
      // Check if there is space or newline after @ or before trigger that invalidates trigger
      const charBeforeAt = lastAtPos > 0 ? textBeforeCaret[lastAtPos - 1] : " ";
      const queryText = textBeforeCaret.slice(lastAtPos + 1);

      // Valid trigger if @ is at start or preceded by space/newline, and query doesn't contain newline
      const isValidStart = /\s/.test(charBeforeAt) || lastAtPos === 0;
      const hasNoNewline = !queryText.includes("\n");

      if (isValidStart && hasNoNewline) {
        setTriggerIndex(lastAtPos);
        setQuery(queryText);
        setIsOpen(true);
        return;
      }
    }

    setIsOpen(false);
    setTriggerIndex(null);
    setQuery("");
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newValue = e.target.value;
    const caretPos = e.target.selectionStart || 0;

    checkMentionTrigger(newValue, caretPos);

    const activeMentions = extractMentionsFromText(newValue, candidates);
    onChange(newValue, activeMentions);
  }

  function handleSelectCandidate(candidate: MentionCandidate) {
    if (triggerIndex === null || !textareaRef.current) return;

    const caretPos = textareaRef.current.selectionStart || 0;
    const beforeMention = value.slice(0, triggerIndex);
    const afterMention = value.slice(caretPos);

    const insertedTag = `${candidate.displayTag} `;
    const newValue = beforeMention + insertedTag + afterMention;
    const newCaretPos = beforeMention.length + insertedTag.length;

    const activeMentions = extractMentionsFromText(newValue, candidates);
    onChange(newValue, activeMentions);

    setIsOpen(false);
    setTriggerIndex(null);
    setQuery("");

    // Restore focus and update cursor position
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCaretPos, newCaretPos);
      }
    }, 0);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!isOpen || filteredCandidates.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredCandidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredCandidates.length) % filteredCandidates.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const selected = filteredCandidates[selectedIndex];
      if (selected) {
        handleSelectCandidate(selected);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
    }
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const caretPos = e.currentTarget.selectionStart || 0;
      checkMentionTrigger(value, caretPos);
    }
  }

  function handleClick(e: React.MouseEvent<HTMLTextAreaElement>) {
    const caretPos = e.currentTarget.selectionStart || 0;
    checkMentionTrigger(value, caretPos);
  }

  return (
    <div className="relative w-full">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleTextareaChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleClick}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        {...props}
      />

      {/* Autocomplete Mention Dropdown */}
      {isOpen && filteredCandidates.length > 0 && (
        <div
          ref={dropdownRef}
          className={`absolute z-[99999] max-h-56 w-full max-w-md overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-2xl ring-1 ring-black/10 animate-in fade-in zoom-in-95 duration-100 ${
            dropPosition === "top" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
          style={{ left: 0 }}
        >
          <div className="px-2 py-1 text-[11px] font-bold tracking-wider text-muted-foreground uppercase flex items-center justify-between border-b pb-1 mb-1">
            <span>Tag Person or Department</span>
            <span className="text-[10px] font-semibold text-muted-foreground">↑↓ Navigate • ↵ Select</span>
          </div>

          <div className="space-y-0.5">
            {filteredCandidates.map((candidate, idx) => {
              const isSelected = idx === selectedIndex;
              const isPerson = candidate.type === "person";

              return (
                <button
                  key={`${candidate.type}-${candidate.id}`}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectCandidate(candidate);
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    isSelected
                      ? "bg-primary text-primary-foreground font-bold"
                      : "hover:bg-accent hover:text-accent-foreground text-foreground font-semibold"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-bold ${
                        isSelected
                          ? "bg-primary-foreground/20 text-primary-foreground"
                          : isPerson
                            ? "bg-blue-500/10 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400"
                            : "bg-purple-500/10 text-purple-600 dark:bg-purple-400/20 dark:text-purple-400"
                      }`}
                    >
                      {isPerson ? <User className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
                    </div>

                    <div className="truncate">
                      <div className="font-bold truncate flex items-center gap-1.5">
                        <span className="font-bold">{candidate.name}</span>
                        {isPerson && candidate.deptName && (
                          <span
                            className={`text-[10px] px-1.5 py-0.2 rounded font-semibold truncate ${
                              isSelected
                                ? "bg-primary-foreground/20 text-primary-foreground"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {candidate.deptName}
                          </span>
                        )}
                      </div>
                      {candidate.subtitle && (
                        <div
                          className={`text-[11px] truncate ${
                            isSelected ? "text-primary-foreground/80 font-medium" : "text-muted-foreground"
                          }`}
                        >
                          {candidate.subtitle}
                        </div>
                      )}
                    </div>
                  </div>

                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${
                      isSelected
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : isPerson
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                          : "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                    }`}
                  >
                    {isPerson ? "Person" : "Dept"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
