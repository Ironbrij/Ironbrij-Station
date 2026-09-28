import test from "node:test";
import assert from "node:assert/strict";
import { getEmployeeHoliday, getEmployeeHolidayDates } from "../src/lib/attendance.ts";
import { buildAttendanceSessions } from "../src/lib/attendance-sessions.ts";
import {
  australianPublicHolidays,
  employeeWorkStates,
  fromNager,
  isNationalHoliday,
  regionCodes,
  regionLabel,
  loadAustralianPublicHolidays,
  shareHolidays,
} from "../src/lib/holidays.ts";
import { COMPANY_ID, type Company, type Employee, type Punch } from "../src/lib/types.ts";

const DATE = "2026-09-10"; // a Thursday
const at = (time: string) => new Date(`${DATE}T${time}:00Z`);

// Someone who works for two clients. Holidays are saved on the main company.
const employee = {
  id: "emp",
  name: "Maria Santos",
  email: "maria@example.com",
  companyId: "alpha",
  companyIds: ["alpha", "beta"],
  state: "NSW",
  status: "active",
  inviteStatus: "accepted",
  timezone: "UTC",
  shiftTimezone: "UTC",
  shiftStartTime: "09:00",
  shiftEndTime: "17:00",
  workingDays: [0, 1, 2, 3, 4, 5, 6],
} as Employee;

const saved = [
  {
    id: COMPANY_ID,
    name: "Main",
    isMain: true,
    defaultShiftHours: 8,
    workingDays: [1, 2, 3, 4, 5],
    holidays: [],
    holidayAssignments: [
      { id: "h1", date: DATE, name: "Alpha closed", targetType: "all", companyIds: ["alpha"] },
    ],
  },
  { id: "alpha", name: "Alpha", defaultShiftHours: 8, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  { id: "beta", name: "Beta", defaultShiftHours: 8, workingDays: [1, 2, 3, 4, 5], holidays: [] },
] as Company[];
const companies = shareHolidays(saved);
const alpha = companies.find((company) => company.id === "alpha")!;
const beta = companies.find((company) => company.id === "beta")!;

test("a client company sees the holidays saved on the main company", () => {
  assert.equal(getEmployeeHoliday(alpha, employee, DATE)?.name, "Alpha closed");
  assert.deepEqual(getEmployeeHolidayDates(alpha, employee), [DATE]);
});

test("work for the other company stays an ordinary day", () => {
  assert.equal(getEmployeeHoliday(beta, employee, DATE), null);
  assert.deepEqual(getEmployeeHolidayDates(beta, employee), []);
});

test("across all companies a holiday for any of theirs still shows", () => {
  const all = shareHolidays([{ ...beta, id: "all" }], saved[0])[0];
  assert.equal(getEmployeeHoliday(all, employee, DATE)?.name, "Alpha closed");
});

test("a state holiday only reaches people in that state", () => {
  const calendar = shareHolidays([{ ...saved[1] }], {
    ...saved[0],
    holidayAssignments: [
      { id: "vic", date: DATE, name: "Melbourne Cup", targetType: "states", stateCodes: ["VIC"] },
    ],
  })[0];
  assert.equal(getEmployeeHoliday(calendar, employee, DATE), null);
  assert.equal(
    getEmployeeHoliday(calendar, { ...employee, state: "VIC" }, DATE)?.name,
    "Melbourne Cup",
  );
});

const punch = (id: string, type: Punch["type"], time: string, companyId: string) =>
  ({
    id,
    employeeId: "emp",
    companyId,
    type,
    timestamp: at(time),
    attendanceDate: DATE,
    shiftTimezone: "UTC",
    scheduledShiftStart: at("09:00").toISOString(),
    scheduledShiftEnd: at("17:00").toISOString(),
  }) as unknown as Punch;

test("hours worked on a holiday are not regular hours, even if it was added later", () => {
  const [session] = buildAttendanceSessions({
    employee,
    punches: [punch("in", "in", "09:00", "alpha"), punch("out", "out", "13:00", "alpha")],
    companies,
    now: at("20:00"),
  });
  assert.equal(session.calc.normalWorkMinutes, 0);
  assert.equal(session.calc.overtimeMinutes, 240);
});

test("the same hours for the open company are regular", () => {
  const [session] = buildAttendanceSessions({
    employee,
    punches: [punch("in", "in", "09:00", "beta"), punch("out", "out", "13:00", "beta")],
    companies,
    now: at("20:00"),
  });
  assert.equal(session.calc.normalWorkMinutes, 240);
});

test("Australian public holidays for 2026 fall on the right days", () => {
  const list = australianPublicHolidays(2026);
  const find = (name: string, state?: string) =>
    list.filter((item) => item.name === name && (!state || item.states.includes(state as never)));
  assert.equal(find("Australia Day")[0].date, "2026-01-26");
  assert.equal(find("Good Friday")[0].date, "2026-04-03");
  assert.equal(find("Easter Monday")[0].date, "2026-04-06");
  assert.equal(find("Anzac Day")[0].date, "2026-04-25");
  assert.deepEqual(find("Anzac Day (observed)")[0], {
    date: "2026-04-27",
    name: "Anzac Day (observed)",
    country: "AU",
    states: ["WA"],
  });
  assert.equal(find("King's Birthday", "NSW")[0].date, "2026-06-08");
  assert.equal(find("King's Birthday", "QLD")[0].date, "2026-10-05");
  assert.equal(find("King's Birthday", "WA")[0].date, "2026-09-28");
  assert.equal(find("Labour Day", "NSW")[0].date, "2026-10-05");
  assert.equal(find("Labour Day", "VIC")[0].date, "2026-03-09");
  assert.equal(find("Melbourne Cup Day")[0].date, "2026-11-03");
  // Christmas 2026 is a Friday, so Boxing Day moves to Monday.
  assert.equal(find("Boxing Day (observed)")[0].date, "2026-12-28");
});

test("weekend holidays get the weekday off", () => {
  // Christmas 2027 is a Saturday, New Year's Day 2028 is a Saturday.
  const list = australianPublicHolidays(2027);
  assert.ok(
    list.some((item) => item.date === "2027-12-27" && item.name === "Christmas Day (observed)"),
  );
  assert.ok(
    list.some((item) => item.date === "2027-12-28" && item.name === "Boxing Day (observed)"),
  );
  assert.ok(
    australianPublicHolidays(2028).some(
      (item) => item.date === "2028-01-03" && item.name === "New Year's Day (observed)",
    ),
  );
});

// State belongs to the company. Maria works for Alpha (NSW) and Beta (VIC).
const inStates = shareHolidays([
  {
    ...saved[0],
    holidayAssignments: [
      { id: "nsw", date: DATE, name: "Labour Day", targetType: "states", stateCodes: ["NSW"] },
    ],
  },
  { ...saved[1], state: "NSW" },
  { ...saved[2], state: "VIC" },
] as Company[]);
const nswCompany = inStates.find((company) => company.id === "alpha")!;
const vicCompany = inStates.find((company) => company.id === "beta")!;
const twoStates = { ...employee, state: undefined } as Employee;

test("a state holiday closes the company in that state", () => {
  assert.equal(getEmployeeHoliday(nswCompany, twoStates, DATE)?.name, "Labour Day");
});

test("the same person's work for a company in another state is a normal day", () => {
  assert.equal(getEmployeeHoliday(vicCompany, twoStates, DATE), null);
});

test("the company's state wins over any state left on the person's profile", () => {
  assert.equal(getEmployeeHoliday(vicCompany, { ...twoStates, state: "NSW" }, DATE), null);
});

test("across all companies the state holiday shows for anyone with an NSW company", () => {
  const all = { ...inStates[0], id: "all" };
  assert.equal(getEmployeeHoliday(all, twoStates, DATE)?.name, "Labour Day");
  assert.equal(
    getEmployeeHoliday(all, { ...twoStates, companyId: "beta", companyIds: ["beta"] }, DATE),
    null,
  );
});

test("people are told which states they work in", () => {
  assert.deepEqual(employeeWorkStates(twoStates, inStates), ["NSW", "VIC"]);
  assert.deepEqual(employeeWorkStates({ companyId: "beta", companyIds: [] }, inStates), ["VIC"]);
});

test("Nager.Date's list keeps national days national and state days to their states", () => {
  const list = fromNager([
    { date: "2026-01-26", localName: "Australia Day", counties: null, types: ["Public"] },
    {
      date: "2026-04-27",
      localName: "Anzac Day",
      counties: ["AU-NSW", "AU-ACT", "AU-WA"],
      types: ["Public"],
    },
    { date: "2026-02-14", localName: "Not a day off", counties: null, types: ["Observance"] },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].states.length, 8);
  assert.deepEqual(list[1].states, ["ACT", "NSW", "WA"]);
});

test("the built-in list is used when Nager.Date cannot be reached", async () => {
  const offline = (async () => new Response("", { status: 503 })) as typeof fetch;
  const result = await loadAustralianPublicHolidays(2031, offline);
  assert.equal(result.source, "built-in");
  assert.ok(result.holidays.some((item) => item.name === "Christmas Day"));
});

test("a holiday for some people in a state covers only their work there", () => {
  // What the planner saves for "NSW, only Maria": her id and the NSW companies.
  const picked = shareHolidays([
    {
      ...saved[0],
      holidayAssignments: [
        {
          id: "p",
          date: DATE,
          name: "Maria's day",
          targetType: "employees",
          employeeIds: ["emp"],
          stateCodes: ["NSW"],
          companyIds: ["alpha"],
        },
      ],
    },
    { ...saved[1], state: "NSW" },
    { ...saved[2], state: "VIC" },
  ] as Company[]);
  const [, nsw, vic] = picked;
  assert.equal(getEmployeeHoliday(nsw, twoStates, DATE)?.name, "Maria's day");
  assert.equal(getEmployeeHoliday(vic, twoStates, DATE), null);
  assert.equal(getEmployeeHoliday(nsw, { ...twoStates, id: "someone-else" }, DATE), null);
});

test("New Zealand and UK holidays keep their regions", () => {
  const nz = fromNager(
    [
      { date: "2026-02-06", localName: "Waitangi Day", counties: null, types: ["Public"] },
      {
        date: "2026-01-26",
        localName: "Auckland Anniversary Day",
        counties: ["NZ-AUK", "NZ-NTL"],
        types: ["Public"],
      },
    ],
    "NZ",
  );
  assert.equal(nz[0].name, "Auckland Anniversary Day");
  assert.deepEqual(nz[0].states, ["NZ-AUK", "NZ-NTL"]);
  assert.equal(nz[1].states.length, 17);
  assert.equal(isNationalHoliday(nz[1]), true);
  const uk = fromNager(
    [{ date: "2026-11-30", localName: "Saint Andrew's Day", counties: ["GB-SCT"] }],
    "GB",
  );
  assert.deepEqual(uk[0].states, ["GB-SCT"]);
  assert.equal(regionLabel("GB-SCT"), "Scotland");
  assert.equal(regionLabel("NZ-TAS"), "Tasman");
  assert.equal(regionLabel("TAS"), "TAS");
});

test("a New Zealand holiday closes New Zealand companies, not Australian ones", () => {
  const calendar = shareHolidays([
    {
      ...saved[0],
      holidayAssignments: [
        {
          id: "wai",
          date: DATE,
          name: "Waitangi Day",
          targetType: "states",
          stateCodes: regionCodes("NZ"),
        },
      ],
    },
    { ...saved[1], state: "NZ-AUK" },
    { ...saved[2], state: "NSW" },
  ] as Company[]);
  const [, auckland, sydney] = calendar;
  const kiwi = { ...twoStates };
  assert.equal(getEmployeeHoliday(auckland, kiwi, DATE)?.name, "Waitangi Day");
  assert.equal(getEmployeeHoliday(sydney, kiwi, DATE), null);
  assert.deepEqual(employeeWorkStates(kiwi, calendar), ["NSW", "NZ-AUK"]);
});

test("a whole country is named as the country", async () => {
  const { describeRegions } = await import("../src/lib/holidays.ts");
  assert.equal(describeRegions(regionCodes("NZ")), "New Zealand");
  assert.equal(describeRegions(["NSW", "VIC"]), "NSW, VIC");
  assert.equal(describeRegions([...regionCodes("GB"), "NSW"]), "United Kingdom, NSW");
});

test("someone not entitled to public holidays works them, unless given the day by name", async () => {
  const { isHolidayAssignedToEmployee } = await import("../src/lib/attendance.ts");
  const employee = {
    id: "ram",
    deptId: "",
    companyId: "default",
    companyIds: ["default"],
    noPublicHolidays: true,
  };
  assert.equal(
    isHolidayAssignedToEmployee({ id: "a", date: "2026-12-25", targetType: "all" }, employee),
    false,
  );
  assert.equal(
    isHolidayAssignedToEmployee(
      { id: "b", date: "2026-12-26", targetType: "employees", employeeIds: ["ram"] },
      employee,
    ),
    true,
  );
  assert.equal(
    isHolidayAssignedToEmployee(
      { id: "a", date: "2026-12-25", targetType: "all" },
      { ...employee, noPublicHolidays: false },
    ),
    true,
  );
});

test("US, Canadian and German holidays keep their states, and national ones cover every state", async () => {
  const { fromNager, regionCodes, isNationalHoliday, regionLabel } =
    await import("../src/lib/holidays.ts");
  const us = fromNager(
    [
      {
        date: "2026-07-03",
        localName: "Independence Day",
        counties: null,
        types: ["Public", "Bank"],
      },
      {
        date: "2026-10-12",
        localName: "Columbus Day",
        counties: ["US-AZ", "US-GA", "US-MA"],
        types: ["Public"],
      },
      { date: "2026-10-12", localName: "Columbus Day", counties: null, types: ["Bank"] },
    ],
    "US",
  );
  assert.equal(us.length, 2);
  assert.ok(isNationalHoliday(us[0]));
  assert.equal(us[0].states.length, regionCodes("US").length);
  assert.deepEqual(us[1].states, ["US-AZ", "US-GA", "US-MA"]);
  assert.equal(regionLabel("US-WA"), "Washington");
  assert.equal(regionLabel("CA-ON"), "Ontario");
  assert.equal(regionLabel("FR-BRE"), "Bretagne");
  const ontario = fromNager(
    [
      {
        date: "2026-08-03",
        localName: "Civic Holiday",
        counties: ["CA-MB", "CA-ON"],
        types: ["Public"],
      },
    ],
    "CA",
  );
  assert.deepEqual(ontario[0].states, ["CA-MB", "CA-ON"]);
});

test("Qatar's holidays are built in, since Nager.Date has none", async () => {
  const { loadPublicHolidays, qatarPublicHolidays } = await import("../src/lib/holidays.ts");
  const list = qatarPublicHolidays(2026);
  const names = list.map((holiday) => `${holiday.date} ${holiday.name}`);
  assert.ok(names.includes("2026-02-10 National Sports Day"));
  assert.ok(names.includes("2026-03-20 Eid al-Fitr (expected)"));
  assert.ok(names.includes("2026-05-29 Eid al-Adha (day 3) (expected)"));
  assert.ok(names.includes("2026-12-18 Qatar National Day"));
  assert.equal(list.length, 8);
  const fetchImpl = (async () => {
    throw new Error("Qatar is not asked of Nager.Date");
  }) as unknown as typeof fetch;
  const loaded = await loadPublicHolidays(2026, "QA", fetchImpl);
  assert.equal(loaded.source, "built-in");
  assert.equal(loaded.holidays.length, 8);
});

test("each state or region keeps its own clock", async () => {
  const { regionTimezone } = await import("../src/lib/holidays.ts");
  assert.equal(regionTimezone("NSW"), "Australia/Sydney");
  assert.equal(regionTimezone("WA"), "Australia/Perth");
  assert.equal(regionTimezone("US-CA"), "America/Los_Angeles");
  assert.equal(regionTimezone("US-WA"), "America/Los_Angeles");
  assert.equal(regionTimezone("US-AZ"), "America/Phoenix");
  assert.equal(regionTimezone("US-FL"), "America/New_York");
  assert.equal(regionTimezone("CA-ON"), "America/Toronto");
  assert.equal(regionTimezone("DE-BY"), "Europe/Berlin");
  assert.equal(regionTimezone("FR-BRE"), "Europe/Paris");
  assert.equal(regionTimezone("QA"), "Asia/Qatar");
  assert.equal(regionTimezone("nowhere"), null);
});
