export function MunchingBuddyMascot({
  isOverdue,
}: {
  isOverdue: boolean;
  durationMinutes?: number;
}) {
  return (
    <div className="relative flex items-center justify-center -mb-2 z-10 select-none">
      {isOverdue ? (
        // Elegant Resting / Break Complete Character
        <div className="relative flex flex-col items-center">
          <svg
            width="72"
            height="52"
            viewBox="0 0 72 52"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-sm"
          >
            {/* Takeout cup / container */}
            <rect
              x="46"
              y="22"
              width="18"
              height="20"
              rx="3"
              fill="#FDBA74"
              stroke="#EA580C"
              strokeWidth="1.5"
            />
            <line x1="49" y1="28" x2="61" y2="28" stroke="#EA580C" strokeWidth="1.5" />

            {/* Resting Buddy Head */}
            <circle cx="30" cy="26" r="18" fill="#FEF08A" stroke="#D97706" strokeWidth="2" />
            {/* Peaceful Sleeping Eyes */}
            <path
              d="M20 25 Q 24 29 28 25"
              stroke="#92400E"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M32 25 Q 36 29 40 25"
              stroke="#92400E"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
            {/* Smile */}
            <path
              d="M28 32 Q 30 35 32 32"
              stroke="#92400E"
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
            />
            {/* Rosy Cheeks */}
            <circle cx="19" cy="29" r="2.5" fill="#F87171" opacity="0.6" />
            <circle cx="41" cy="29" r="2.5" fill="#F87171" opacity="0.6" />
          </svg>
        </div>
      ) : (
        // Beautiful Character Eating at Top of Card
        <div className="relative flex flex-col items-center">
          {/* Subtle rising steam */}
          <div className="absolute -top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 opacity-70 pointer-events-none">
            <span className="w-1 h-2.5 bg-amber-400/80 rounded-full animate-pulse" />
            <span className="w-1 h-3.5 bg-amber-500/80 rounded-full animate-pulse delay-100" />
            <span className="w-1 h-2 bg-amber-400/80 rounded-full animate-pulse delay-200" />
          </div>

          <svg
            width="76"
            height="56"
            viewBox="0 0 76 56"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-md"
          >
            {/* Character Head */}
            <circle cx="38" cy="24" r="18" fill="#FEF08A" stroke="#D97706" strokeWidth="2" />

            {/* Happy Eyes (^_^) */}
            <path
              d="M27 22 Q 31 18 35 22"
              stroke="#92400E"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M41 22 Q 45 18 49 22"
              stroke="#92400E"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />

            {/* Cheerful Munching Smile */}
            <ellipse cx="38" cy="27" rx="3.5" ry="3" fill="#B91C1C" />

            {/* Rosy Cheeks */}
            <circle cx="26" cy="26" r="2.5" fill="#F87171" opacity="0.7" />
            <circle cx="50" cy="26" r="2.5" fill="#F87171" opacity="0.7" />

            {/* Food / Noodle Bowl */}
            <path
              d="M24 34 C 24 48 52 48 52 34 Z"
              fill="#F97316"
              stroke="#C2410C"
              strokeWidth="2"
            />
            <ellipse
              cx="38"
              cy="34"
              rx="14"
              ry="3.5"
              fill="#FDE047"
              stroke="#C2410C"
              strokeWidth="1.5"
            />

            {/* Chopsticks */}
            <line
              x1="42"
              y1="24"
              x2="58"
              y2="16"
              stroke="#78350F"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
            <line
              x1="40"
              y1="26"
              x2="56"
              y2="18"
              stroke="#78350F"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
