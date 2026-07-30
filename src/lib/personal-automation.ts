import { collection, getDocs, query, updateDoc, where } from "firebase/firestore";
import { db } from "./firebase";
import type { Employee, PunchType } from "./types";

export type PersonalAutomationEvent = "punch_in" | "punch_out";

export interface PersonalAutomationProfile {
  id: string;
  ownerUid: string;
  employeeId: string;
  employeeName: string;
  enabled: boolean;
  status: "punched_in" | "punched_out";
  isPunchedIn: boolean;
  event: PersonalAutomationEvent | "snapshot";
  eventId: string;
  punchId?: string;
  punchType?: PunchType;
  date?: string;
  occurredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function personalAutomationEventForPunch(punchType: PunchType): PersonalAutomationEvent {
  return punchType === "in" || punchType === "extra_in" ? "punch_in" : "punch_out";
}

export async function publishPersonalAttendanceEvent(input: {
  ownerUid: string;
  employee: Employee;
  punchId: string;
  punchType: PunchType;
  date: string;
  occurredAt: Date;
}) {
  const profiles = await getDocs(
    query(collection(db(), "automationProfiles"), where("ownerUid", "==", input.ownerUid)),
  );
  if (profiles.empty) return;

  const event = personalAutomationEventForPunch(input.punchType);
  const status = event === "punch_in" ? "punched_in" : "punched_out";
  const update = {
    employeeId: input.employee.id,
    employeeName: input.employee.name,
    status,
    isPunchedIn: event === "punch_in",
    event,
    eventId: input.punchId,
    punchId: input.punchId,
    punchType: input.punchType,
    date: input.date,
    occurredAt: input.occurredAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await Promise.all(profiles.docs.map((profile) => updateDoc(profile.ref, update)));
}
