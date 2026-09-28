/**
 * Marks someone who works for companies in more than one state: a state holiday
 * may give them one company's day off and not another's.
 */
export function MultiStateBadge({ states }: { states: string[] }) {
  if (states.length < 2) return null;
  return (
    <span
      title={`Works in ${states.join(", ")}. A state holiday only covers their work for companies in that state.`}
      className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-extrabold text-amber-700 dark:text-amber-300"
    >
      Multi-state · {states.join(" · ")}
    </span>
  );
}
