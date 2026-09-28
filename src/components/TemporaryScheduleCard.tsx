import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import {
  getCompanyMembership,
  getEmployeeCompanyIds,
  normalizeCompanyId,
} from "@/lib/company-context";
import { companyClockTimezone, findDstChange } from "@/lib/dst-email";
import { updateIfUnchanged } from "@/lib/guarded-writes";
import { endTemporarySchedule, moveTime, startTemporarySchedule } from "@/lib/temporary-schedule";
import type { Company, Employee } from "@/lib/types";

const WATCHED = [
  "shiftStartTime",
  "shiftEndTime",
  "shifts",
  "companyMemberships",
  "temporarySchedule",
] as const;

/** "09:00" -> "9:00 AM". */
function clock(time?: string): string {
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return "—";
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function shiftTimes(employee: Employee, companyId: string) {
  const membership = getCompanyMembership(employee, companyId);
  return membership.isMultipleShift && membership.shifts?.length
    ? membership.shifts.map((shift) => ({ start: shift.startTime, end: shift.endTime }))
    : [
        {
          start: membership.shiftStartTime || employee.shiftStartTime,
          end: membership.shiftEndTime || employee.shiftEndTime,
        },
      ];
}

/**
 * A switch on the profile for a temporary schedule, such as for daylight
 * saving: it moves the chosen companies' shift times by an hour, keeps the
 * usual times, and puts them back when switched off. Either way the VA and
 * those clients can be emailed the new hours.
 */
export function TemporaryScheduleCard({
  employee,
  companies,
}: {
  employee: Employee;
  companies: Company[];
}) {
  const { user } = useAuth();
  const temporary = employee.temporarySchedule || null;
  const theirCompanies = useMemo(
    () =>
      getEmployeeCompanyIds(employee).map((id) => ({
        id,
        company: companies.find((company) => normalizeCompanyId(company.id) === id),
      })),
    [employee, companies],
  );
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(60);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [emailVa, setEmailVa] = useState(true);
  const [emailClients, setEmailClients] = useState(true);
  const [busy, setBusy] = useState(false);

  const nameOf = (id: string) => theirCompanies.find((item) => item.id === id)?.company?.name || id;

  function startForm() {
    // Companies whose clocks change for daylight saving at some point in the year.
    const now = new Date();
    const changing = theirCompanies
      .filter(({ company }) => company && findDstChange(companyClockTimezone(company), now, 366))
      .map(({ id }) => id);
    setPicked(new Set(changing));
    setMinutes(60);
    setOpen(true);
  }

  async function notify(companyIds: string[], moved: number, started: boolean) {
    if (!user || (!emailVa && !emailClients)) return "";
    try {
      const response = await fetch("/api/schedule-change-notification", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await user.getIdToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          employeeId: employee.id,
          // Clients not to be told are left out; the VA email still covers every company.
          companyIds,
          minutes: moved,
          started,
          emailVa,
          emailClients,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        va?: boolean;
        clients?: number;
      };
      if (!response.ok) return " The emails could not be sent.";
      return ` Emailed ${
        [
          result.va ? "the VA" : "",
          result.clients ? `${result.clients} ${result.clients === 1 ? "client" : "clients"}` : "",
        ]
          .filter(Boolean)
          .join(" and ") || "nobody"
      }.`;
    } catch {
      return " The emails could not be sent.";
    }
  }

  async function turnOn() {
    if (picked.size === 0) {
      toast.error("Pick at least one company whose hours move.");
      return;
    }
    setBusy(true);
    try {
      const ids = [...picked];
      await updateIfUnchanged({
        path: `employees/${employee.id}`,
        baseline: employee as unknown as Record<string, unknown>,
        watched: WATCHED,
        what: `${employee.name || "This employee"}'s schedule`,
        update: {
          ...startTemporarySchedule(employee, ids, minutes),
          updatedAt: new Date().toISOString(),
        },
      });
      const sent = await notify(ids, minutes, true);
      toast.success(`Daylight saving schedule is on.${sent}`);
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message || "Could not change the schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!temporary) return;
    setBusy(true);
    try {
      await updateIfUnchanged({
        path: `employees/${employee.id}`,
        baseline: employee as unknown as Record<string, unknown>,
        watched: WATCHED,
        what: `${employee.name || "This employee"}'s schedule`,
        update: { ...endTemporarySchedule(employee), updatedAt: new Date().toISOString() },
      });
      const sent = await notify(temporary.companyIds, temporary.minutes, false);
      toast.success(`Back to the usual schedule.${sent}`);
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message || "Could not change the schedule.");
    } finally {
      setBusy(false);
    }
  }

  const direction = (value: number) =>
    `${Math.abs(value) === 60 ? "1 hour" : `${Math.abs(value)} minutes`} ${value > 0 ? "later" : "earlier"}`;

  const emailChoices = (
    <div className="space-y-1.5 text-xs">
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={emailVa} onChange={(e) => setEmailVa(e.target.checked)} />
        Email {employee.name || "the VA"} their new hours
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={emailClients}
          onChange={(e) => setEmailClients(e.target.checked)}
        />
        Email the clients (their client email, if Daylight saving is ticked for them)
      </label>
    </div>
  );

  return (
    <div className="mt-4 rounded-lg border p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-primary flex items-center gap-1.5">
            <Clock className="h-4 w-4" /> Daylight saving schedule
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {temporary
              ? `On since ${new Date(temporary.startedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}: shifts for ${temporary.companyIds.map(nameOf).join(", ")} are ${direction(temporary.minutes)} than usual. Switch off to go back to the usual times.`
              : "Off: usual shift times. Switch on to move their shifts by an hour for a while, for example to keep the VA's own hours when a client's clocks change."}
          </p>
        </div>
        <Switch
          checked={Boolean(temporary) || open}
          disabled={busy}
          onCheckedChange={(on) =>
            on ? (temporary ? null : startForm()) : temporary ? setOpen(true) : setOpen(false)
          }
        />
      </div>

      {open && !temporary && (
        <div className="space-y-3 border-t pt-3">
          <div>
            <div className="text-xs font-semibold">Move their shifts</div>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option value={60}>
                1 hour later on the client&apos;s clock (clocks went forward)
              </option>
              <option value={-60}>
                1 hour earlier on the client&apos;s clock (clocks went back)
              </option>
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-semibold">For these companies</div>
            {theirCompanies.map(({ id }) => (
              <label key={id} className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={picked.has(id)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setPicked(next);
                  }}
                />
                <span>
                  <span className="font-semibold">{nameOf(id)}</span>{" "}
                  <span className="text-muted-foreground">
                    {shiftTimes(employee, id)
                      .map(
                        (shift) =>
                          `${clock(shift.start)} – ${clock(shift.end)} → ${
                            picked.has(id)
                              ? `${clock(moveTime(shift.start, minutes))} – ${clock(moveTime(shift.end, minutes))}`
                              : "no change"
                          }`,
                      )
                      .join(", ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {emailChoices}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={turnOn}
              disabled={busy}
              className="btn-lift rounded-md bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Saving…" : "Switch on"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border px-3.5 py-2 text-xs font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {open && temporary && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-xs">
            Put back the usual shift times for {temporary.companyIds.map(nameOf).join(", ")}?
          </p>
          {emailChoices}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={turnOff}
              disabled={busy}
              className="btn-lift rounded-md bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Saving…" : "Back to usual times"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border px-3.5 py-2 text-xs font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
