import { AlertTriangle, CalendarDays, LayoutDashboard } from "lucide-react";
import { companyClientEmails } from "@/lib/client-emails";
import { formatEmailDate } from "@/lib/email-template";
import { companyState, describeRegions } from "@/lib/holidays";
import { normalizeCompanyId } from "@/lib/company-context";
import type { Company, CompanyHoliday, Employee } from "@/lib/types";

/**
 * The side panel of the company page: what needs fixing so holidays and client
 * emails reach every company, and the holidays coming up.
 */
export function CompanyOverviewCard({
  calendar,
  companies,
  employees,
  todayStr,
  onEdit,
}: {
  /** The main company, which holds the saved holiday calendar. */
  calendar: Company;
  companies: Company[];
  employees: Employee[];
  todayStr: string;
  onEdit: (company: Company) => void;
}) {
  const active = companies.filter((company) => !company.archived && company.status !== "archived");
  const noState = active.filter((company) => !companyState(company));
  const noClientEmail = active.filter(
    (company) => !company.isMain && companyClientEmails(company).length === 0,
  );
  const activePeople = employees.filter((employee) => employee.status === "active").length;

  const ahead = [
    ...(calendar.holidays ?? []).map((date): CompanyHoliday => ({
      id: `legacy-${date}`,
      date,
      targetType: "all",
    })),
    ...(calendar.holidayAssignments ?? []),
  ]
    .filter((holiday) => holiday.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = ahead.slice(0, 6);

  const companyName = (id: string) =>
    companies.find((company) => normalizeCompanyId(company.id) === normalizeCompanyId(id))?.name ||
    id;
  const who = (holiday: CompanyHoliday) => {
    if (holiday.targetType === "states") return describeRegions(holiday.stateCodes ?? []);
    if (holiday.companyIds?.length) return holiday.companyIds.map(companyName).join(", ");
    if (holiday.targetType === "departments") return "Chosen departments";
    if (holiday.targetType === "employees") return "Chosen people";
    return "Everyone";
  };

  const attention = (title: string, hint: string, list: Company[]) =>
    list.length > 0 && (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" /> {title} ({list.length})
        </div>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
        <div className="flex flex-wrap gap-1">
          {list.slice(0, 12).map((company) => (
            <button
              key={company.id || company.name}
              type="button"
              onClick={() => onEdit(company)}
              className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-semibold hover:bg-muted"
              title={`Edit ${company.name}`}
            >
              {company.name}
            </button>
          ))}
          {list.length > 12 && (
            <span className="px-1 py-0.5 text-[11px] text-muted-foreground">
              and {list.length - 12} more
            </span>
          )}
        </div>
      </div>
    );

  return (
    <div className="rounded-xl border bg-card p-5 shadow-lift space-y-4">
      <h2 className="font-bold text-primary flex items-center gap-2">
        <LayoutDashboard className="h-4 w-4" /> At a glance
      </h2>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { value: active.length, label: "Active companies" },
          { value: activePeople, label: "Active people" },
          { value: ahead.length, label: "Holidays ahead" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-secondary/30 p-2.5">
            <div className="text-xl font-bold text-primary">{stat.value}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {attention(
        "No state set",
        "State holidays and daylight saving emails won't reach these. Click one to set its state.",
        noState,
      )}
      {attention(
        "No client email",
        "These clients get no holiday, leave, report or daylight saving emails.",
        noClientEmail,
      )}
      {noState.length === 0 && noClientEmail.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Every active company has a state and a client email.
        </p>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
          <CalendarDays className="h-3.5 w-3.5 text-purple-600" /> Next holidays
        </div>
        {upcoming.length === 0 ? (
          <p className="text-xs text-muted-foreground">No holidays added yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {upcoming.map((holiday) => (
              <li key={holiday.id} className="p-2.5">
                <div className="text-sm font-semibold">{holiday.name || "Company Holiday"}</div>
                <div className="text-[11px] text-muted-foreground">
                  {formatEmailDate(holiday.date)} · {who(holiday)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
