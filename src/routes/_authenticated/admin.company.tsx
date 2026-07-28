import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COMPANY_ID, type Company } from "@/lib/types";
import { ymd } from "@/lib/time";
import { toast } from "sonner";
import { X, Building2, Image as ImageIcon, Calendar, PartyPopper, Check } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/company")({
  head: () => ({
    meta: [
      { title: "Company Settings — Time Station Admin" },
      { name: "description", content: "Manage company branding, logo, and holidays." },
      { property: "og:title", content: "Company Settings — Time Station Admin" },
      { property: "og:description", content: "Manage company branding, logo, and holidays." },
    ],
  }),
  component: CompanyPage,
});

function CompanyPage() {
  const [company, setCompany] = useState<Company>({
    name: "ironbrij",
    defaultShiftHours: 8,
    holidays: [],
    workingDays: [1, 2, 3, 4, 5],
    lateGraceMinutes: 1,
    logoUrl: "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg",
  });
  const [busy, setBusy] = useState(false);
  const [newHoliday, setNewHoliday] = useState("");

  const todayStr = ymd(new Date());
  const isTodayHoliday = company.holidays.includes(todayStr);

  useEffect(() => {
    const unsub = onSnapshot(doc(db(), "companies", COMPANY_ID), (s) => {
      if (s.exists()) {
        const data = s.data() as Company;
        setCompany({
          name: data.name || "ironbrij",
          defaultShiftHours: data.defaultShiftHours ?? 8,
          holidays: data.holidays ?? [],
          workingDays: data.workingDays ?? [1, 2, 3, 4, 5],
          lateGraceMinutes: data.lateGraceMinutes ?? 1,
          logoUrl:
            data.logoUrl ||
            "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg",
        });
      }
    });
    return () => unsub();
  }, []);

  async function save(updatedCompany?: Company) {
    setBusy(true);
    const target = updatedCompany || company;
    try {
      const payload: Company = {
        name: target.name.trim() || "ironbrij",
        defaultShiftHours: target.defaultShiftHours || 8,
        holidays: target.holidays,
        workingDays: target.workingDays,
        lateGraceMinutes: Math.max(0, target.lateGraceMinutes ?? 1),
        logoUrl:
          target.logoUrl?.trim() ||
          "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg",
      };
      await setDoc(doc(db(), "companies", COMPANY_ID), payload, { merge: true });
      toast.success("Company settings and holidays updated successfully!");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTodayHoliday() {
    let updatedHolidays: string[];
    if (isTodayHoliday) {
      updatedHolidays = company.holidays.filter((h) => h !== todayStr);
      toast.info(`Removed Today (${todayStr}) from Company Holidays.`);
    } else {
      updatedHolidays = [...company.holidays, todayStr].sort();
      toast.success(`Today (${todayStr}) declared as Company Holiday for all employees!`);
    }

    const updated = { ...company, holidays: updatedHolidays };
    setCompany(updated);
    await save(updated);
  }

  async function addHoliday() {
    if (!newHoliday) return;
    if (company.holidays.includes(newHoliday)) return;
    const updated = { ...company, holidays: [...company.holidays, newHoliday].sort() };
    setCompany(updated);
    setNewHoliday("");
    await save(updated);
  }

  async function removeHoliday(d: string) {
    const updated = { ...company, holidays: company.holidays.filter((h) => h !== d) };
    setCompany(updated);
    await save(updated);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <Building2 className="h-6 w-6 text-primary" /> Company Settings & Holiday Manager
        </h1>
        <p className="text-sm text-muted-foreground">
          Configure company branding, declare company-wide holidays, and manage shift parameters.
        </p>
      </div>

      {/* Quick Holiday Toggle Switch */}
      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="font-extrabold text-base text-primary flex items-center gap-2">
              <PartyPopper className="h-5 w-5 text-purple-600" /> Today's Company Off Status
            </h3>
            <p className="text-xs text-muted-foreground font-medium mt-0.5">
              Declaring today off blocks regular shifts for all employees.
            </p>
          </div>

          <button
            disabled={busy}
            onClick={toggleTodayHoliday}
            className={`btn-lift px-5 py-2.5 rounded-xl font-extrabold text-xs flex items-center gap-2 shadow-sm transition-all shrink-0 ${
              isTodayHoliday
                ? "bg-rose-600 hover:bg-rose-700 text-white"
                : "bg-purple-600 hover:bg-purple-700 text-white"
            }`}
          >
            {isTodayHoliday ? (
              <>
                <X className="h-4 w-4" /> Cancel Today's Holiday
              </>
            ) : (
              <>
                <PartyPopper className="h-4 w-4" /> Declare Today as Holiday ({todayStr})
              </>
            )}
          </button>
        </div>

        {isTodayHoliday && (
          <div className="p-3.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-900 dark:text-purple-300 text-xs font-bold flex items-center gap-2">
            <Check className="h-4 w-4 text-purple-600 shrink-0" />
            Today ({todayStr}) is active as a Company Holiday! Regular shifts are off.
          </div>
        )}
      </div>

      {/* Live Brand Preview */}
      <div className="rounded-xl border bg-card p-6 space-y-3 shadow-lift">
        <h3 className="text-xs font-bold text-primary uppercase tracking-wider flex items-center gap-1.5">
          <ImageIcon className="h-4 w-4" /> Live Header & Brand Logo Preview
        </h3>
        <div className="p-4 rounded-xl bg-secondary/30 border flex items-center gap-4">
          {company.logoUrl ? (
            <img
              src={company.logoUrl}
              alt={company.name}
              className="h-16 w-16 object-contain rounded-xl border bg-background shadow-md shrink-0"
              onError={(e) => {
                (e.target as HTMLElement).style.display = "none";
              }}
            />
          ) : (
            <div className="h-16 w-16 rounded-xl bg-primary/10 text-primary flex items-center justify-center border border-primary/20 font-bold text-xl shrink-0">
              {(company.name || "i")[0].toUpperCase()}
            </div>
          )}
          <div className="space-y-1">
            <div className="text-2xl font-black text-primary">{company.name || "ironbrij"}</div>
            <div className="text-xs text-muted-foreground font-mono break-all max-w-md">
              {company.logoUrl}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 space-y-4 shadow-lift">
        <div>
          <label className="text-sm font-semibold">Company Name</label>
          <input
            value={company.name}
            onChange={(e) => setCompany({ ...company, name: e.target.value })}
            placeholder="ironbrij"
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-bold text-primary outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div>
          <label className="text-sm font-semibold">Logo Image URL</label>
          <input
            value={company.logoUrl ?? ""}
            onChange={(e) => setCompany({ ...company, logoUrl: e.target.value })}
            placeholder="https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg"
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-mono text-xs outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div>
          <label className="text-sm font-semibold">Default Shift Duration (Hours)</label>
          <input
            type="number"
            value={company.defaultShiftHours}
            onChange={(e) =>
              setCompany({ ...company, defaultShiftHours: parseFloat(e.target.value) || 8 })
            }
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-bold"
          />
        </div>
      </div>

      {/* Scheduled Holidays List */}
      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-3">
        <h2 className="font-bold text-primary flex items-center gap-2">
          <Calendar className="h-4 w-4 text-primary" /> Scheduled Company Holidays (
          {company.holidays.length})
        </h2>
        <p className="text-xs text-muted-foreground">
          Add specific dates to off the company. Regular shifts are disabled for employees on these
          dates.
        </p>

        <div className="flex gap-2">
          <input
            type="date"
            value={newHoliday}
            onChange={(e) => setNewHoliday(e.target.value)}
            className="rounded-md border px-3 py-2 text-sm bg-background font-medium"
          />
          <button
            onClick={addHoliday}
            className="btn-lift rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-bold"
          >
            Add Holiday Date
          </button>
        </div>

        <ul className="flex flex-wrap gap-2 pt-2">
          {company.holidays.map((h) => (
            <li
              key={h}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-extrabold bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20"
            >
              <span>🎉 {h}</span>
              <button onClick={() => removeHoliday(h)} title="Remove holiday">
                <X className="h-3.5 w-3.5 text-rose-500 hover:scale-110 transition-transform" />
              </button>
            </li>
          ))}
          {company.holidays.length === 0 && (
            <li className="text-sm text-muted-foreground italic">No holidays set.</li>
          )}
        </ul>
      </div>

      <button
        disabled={busy}
        onClick={() => save()}
        className="btn-lift rounded-md bg-primary text-primary-foreground px-8 py-3 text-sm font-bold shadow-md"
      >
        {busy ? "Saving Settings..." : "Save Company Branding & Settings"}
      </button>
    </div>
  );
}
