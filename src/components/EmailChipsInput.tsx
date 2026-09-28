import { useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { parseClientEmails } from "@/lib/client-emails";
import { resolveProfilePhoto } from "@/lib/profile-photo";
import type { Employee } from "@/lib/types";

/**
 * Email addresses as chips, the way a mail app shows recipients: a photo or
 * initial, the person's name when we know them, and a cross to take one off.
 * Enter, a comma or the + button adds what is typed; pasting a list adds all.
 */

const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#4f46e5"];

function colorFor(email: string) {
  let hash = 0;
  for (const char of email) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function Avatar({ email, name, photo }: { email: string; name?: string; photo?: string }) {
  const [broken, setBroken] = useState(false);
  if (photo && !broken) {
    return (
      <img
        src={photo}
        alt=""
        onError={() => setBroken(true)}
        className="h-6 w-6 shrink-0 rounded-full object-cover"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
      style={{ backgroundColor: colorFor(email) }}
    >
      {(name || email).charAt(0).toUpperCase()}
    </span>
  );
}

export function EmailChipsInput({
  value,
  onChange,
  people = [],
  placeholder = "Add an email address",
  id,
}: {
  value: string[];
  onChange: (emails: string[]) => void;
  /** People we know, for names, photos and suggestions. */
  people?: Pick<Employee, "name" | "email" | "photoUrl" | "photoURL" | "status">[];
  placeholder?: string;
  id?: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const byEmail = useMemo(() => {
    const map = new Map<string, { name?: string; photo?: string }>();
    for (const person of people) {
      const email = person.email?.trim().toLowerCase();
      if (email) map.set(email, { name: person.name?.trim(), photo: resolveProfilePhoto(person) });
    }
    return map;
  }, [people]);

  const term = text.trim().toLowerCase();
  const suggestions = term
    ? people
        .filter((person) => person.status !== "inactive" && person.email)
        .filter((person) => !value.includes(person.email.trim().toLowerCase()))
        .filter((person) =>
          `${person.name ?? ""} ${person.email}`.toLowerCase().includes(term),
        )
        .slice(0, 5)
    : [];

  function add(raw: string) {
    const typed = raw
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (typed.length === 0) {
      inputRef.current?.focus();
      return;
    }
    const valid = parseClientEmails(typed);
    const invalid = typed.filter((item) => !valid.includes(item.toLowerCase()));
    if (valid.length > 0) onChange([...new Set([...value, ...valid])]);
    setText(invalid.join(", "));
    setError(invalid.length > 0 ? `Not an email address: ${invalid.join(", ")}` : "");
  }

  function remove(email: string) {
    onChange(value.filter((item) => item !== email));
  }

  return (
    <div className="relative">
      <div
        onClick={() => inputRef.current?.focus()}
        className={`flex min-h-[42px] w-full flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-sm cursor-text ${
          focused ? "ring-2 ring-primary/20 border-primary/50" : ""
        } ${error ? "border-rose-400" : ""}`}
      >
        {value.map((email) => {
          const known = byEmail.get(email);
          return (
            <span
              key={email}
              title={email}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background py-0.5 pl-0.5 pr-1.5 text-[13px] font-medium text-foreground shadow-xs"
            >
              <Avatar email={email} name={known?.name} photo={known?.photo} />
              <span className="truncate">{known?.name || email}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  remove(email);
                }}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Remove ${email}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="email"
          autoComplete="off"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "," || event.key === ";") {
              event.preventDefault();
              add(text);
            } else if (event.key === "Backspace" && text === "" && value.length > 0) {
              remove(value[value.length - 1]);
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (/[\s,;]/.test(pasted.trim())) {
              event.preventDefault();
              add(`${text} ${pasted}`);
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Leaving the box keeps what was typed, so an address typed and then
            // Send clicked is still sent.
            if (text.trim()) add(text);
          }}
          placeholder={value.length === 0 ? placeholder : ""}
          className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            add(text);
          }}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-primary hover:bg-primary/10"
          aria-label="Add email"
          title="Add email"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {suggestions.length > 0 && focused && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-card shadow-lift">
          {suggestions.map((person) => (
            <li key={person.email}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange([...new Set([...value, person.email.trim().toLowerCase()])]);
                  setText("");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <Avatar
                  email={person.email}
                  name={person.name}
                  photo={resolveProfilePhoto(person)}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{person.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {person.email}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-[11px] font-semibold text-rose-600">{error}</p>}
      {value.length > 0 && !error && (
        <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-400">
          ✓ {value.length} {value.length === 1 ? "address" : "addresses"} set up to receive
          emails
        </p>
      )}
    </div>
  );
}
