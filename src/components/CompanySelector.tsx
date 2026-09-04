import { useState, useMemo, useRef, useEffect } from "react";
import { Building2, Check, ChevronDown, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COMPANY_ID, type Company } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";

interface CompanySelectorProps {
  variant?: "header" | "dashboard" | "inline";
  className?: string;
  onCompanyChange?: (companyId: string) => void;
  activeShiftCompanyIds?: string[];
  allowAll?: boolean;
}

export function CompanySelector({
  variant = "header",
  className = "",
  onCompanyChange,
  activeShiftCompanyIds = [],
  allowAll,
}: CompanySelectorProps) {
  const { companies, activeCompanyId, setActiveCompanyId, isAdmin } = useAuth();
  const showAllOption = allowAll ?? (isAdmin || variant === "dashboard");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setSearch("");
    }
  }, [open]);

  const activeCompany = useMemo(() => {
    if (activeCompanyId === "all") {
      return {
        id: "all",
        name: "All Companies",
      };
    }
    return (
      companies.find((c) => (c.id || COMPANY_ID) === activeCompanyId) ||
      companies[0] || {
        id: COMPANY_ID,
        name: "Main Company",
      }
    );
  }, [companies, activeCompanyId]);

  const filteredCompanies = useMemo(() => {
    if (!search.trim()) return companies;
    const q = search.toLowerCase().trim();
    return companies.filter((c) => {
      const matchName = c.name?.toLowerCase().includes(q);
      const matchCode = c.code?.toLowerCase().includes(q);
      const matchId = c.id?.toLowerCase().includes(q);
      return matchName || matchCode || matchId;
    });
  }, [companies, search]);

  function handleSelect(companyId: string) {
    const targetId = companyId || COMPANY_ID;
    if (targetId === activeCompanyId) {
      setOpen(false);
      return;
    }

    if (
      targetId !== "all" &&
      activeShiftCompanyIds.length > 0 &&
      !activeShiftCompanyIds.includes(targetId)
    ) {
      const activeName =
        companies.find((item) => (item.id || COMPANY_ID) === activeShiftCompanyIds[0])?.name ||
        "another company";
      const shouldContinue = window.confirm(
        `You are still clocked in to ${activeName}. Switching company will not close that active shift. Continue?`,
      );
      if (!shouldContinue) return;
    }

    setActiveCompanyId(targetId);
    if (onCompanyChange) {
      onCompanyChange(targetId);
    }
    setOpen(false);
  }

  // If there's only 1 company and no 'all' option allowed, show a simple static badge
  if (companies.length <= 1 && !showAllOption) {
    return (
      <div
        className={`flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs font-bold text-foreground ${className}`}
      >
        <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="truncate max-w-[160px]">{activeCompany.name}</span>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === "dashboard" ? (
          <button
            type="button"
            className={`btn-lift flex items-center justify-between gap-2.5 rounded-xl border border-primary/30 bg-card px-3.5 py-2 text-xs font-bold text-foreground shadow-xs hover:border-primary/60 hover:bg-muted/40 transition-all ${className}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <Building2 className="h-3.5 w-3.5" />
              </div>
              <div className="text-left truncate">
                <span className="text-[10px] text-muted-foreground block font-semibold uppercase leading-none">
                  Company Context
                </span>
                <span className="truncate font-extrabold text-foreground text-xs block leading-tight mt-0.5">
                  {activeCompanyId === "all" ? `All Companies (${companies.length})` : activeCompany.name}
                </span>
              </div>
            </div>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </button>
        ) : (
          <button
            type="button"
            className={`btn-lift flex shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1 text-xs font-bold text-foreground hover:bg-muted/70 hover:border-primary/40 transition-all ${className}`}
            title="Switch Active Company"
          >
            <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="max-w-[130px] sm:max-w-[180px] truncate text-left">
              {activeCompanyId === "all" ? "All Companies" : activeCompany.name}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 opacity-70" />
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 p-0 shadow-2xl rounded-2xl border bg-card overflow-hidden z-50 animate-in zoom-in-95 duration-100"
      >
        {/* Header & Search Bar */}
        <div className="p-3 border-b bg-muted/30 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold text-primary flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" /> Select Company ({companies.length})
            </span>
            <span className="text-[10px] text-muted-foreground font-semibold">Type to filter</span>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search companies by name or code..."
              className="w-full rounded-lg border bg-background pl-8 pr-7 py-1.5 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-primary transition-all"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-2 p-0.5 rounded text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Company Options List */}
        <div className="max-h-64 overflow-y-auto p-1.5 divide-y divide-border/40">
          {showAllOption &&
            (!search.trim() ||
              "all companies".includes(search.toLowerCase().trim()) ||
              "all".includes(search.toLowerCase().trim())) && (
              <button
                type="button"
                onClick={() => handleSelect("all")}
                className={`w-full text-left p-2.5 rounded-xl flex items-center justify-between gap-3 text-xs transition-all ${
                  activeCompanyId === "all"
                    ? "bg-primary/10 text-primary font-extrabold shadow-2xs"
                    : "hover:bg-accent/60 text-foreground font-medium"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-lg border text-xs shrink-0 font-bold ${
                      activeCompanyId === "all"
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted text-muted-foreground border-border"
                    }`}
                  >
                    <Building2 className="h-3.5 w-3.5" />
                  </div>

                  <div className="truncate">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate block font-bold">All Companies</span>
                      <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded bg-primary/15 text-primary">
                        All ({companies.length})
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground block truncate">
                      Consolidated view of all team members & activity
                    </span>
                  </div>
                </div>

                {activeCompanyId === "all" && (
                  <Check className="h-4 w-4 text-primary shrink-0 font-bold" />
                )}
              </button>
            )}

          {filteredCompanies.length === 0 && !showAllOption ? (
            <div className="py-6 text-center text-xs text-muted-foreground font-medium">
              No companies match "{search}".
            </div>
          ) : (
            filteredCompanies.map((c) => {
              const cId = c.id || COMPANY_ID;
              const isSelected = cId === activeCompanyId;
              const hasActiveShift = activeShiftCompanyIds.includes(cId);

              return (
                <button
                  key={cId}
                  type="button"
                  onClick={() => handleSelect(cId)}
                  className={`w-full text-left p-2.5 rounded-xl flex items-center justify-between gap-3 text-xs transition-all ${
                    isSelected
                      ? "bg-primary/10 text-primary font-extrabold shadow-2xs"
                      : "hover:bg-accent/60 text-foreground font-medium"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-lg border text-xs shrink-0 font-bold ${
                        isSelected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {c.logoUrl ? (
                        <img
                          src={c.logoUrl}
                          alt={c.name}
                          className="h-full w-full object-contain rounded-lg"
                        />
                      ) : (
                        c.name?.slice(0, 2).toUpperCase() || "CO"
                      )}
                    </div>

                    <div className="truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate block font-bold">{c.name}</span>
                        {c.isMain && (
                          <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300">
                            Main
                          </span>
                        )}
                        {c.code && (
                          <span className="text-[9px] font-mono text-muted-foreground">
                            [{c.code}]
                          </span>
                        )}
                      </div>
                      {hasActiveShift && (
                        <span className="text-[10px] text-amber-700 font-bold flex items-center gap-1 mt-0.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                          Active shift running
                        </span>
                      )}
                    </div>
                  </div>

                  {isSelected && <Check className="h-4 w-4 text-primary shrink-0 font-bold" />}
                </button>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="p-2 border-t bg-muted/20 text-[11px] text-muted-foreground text-center font-medium">
          Selecting a company isolates all views to that company.
        </div>
      </PopoverContent>
    </Popover>
  );
}
