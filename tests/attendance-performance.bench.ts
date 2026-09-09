import { performance } from 'node:perf_hooks';
import { buildLateRecords } from '../src/lib/late-records.ts';
import { getLiveAttendanceStatus, computeRegularWorkedMsForDay } from '../src/lib/attendance.ts';
import type { Employee, Punch } from '../src/lib/types.ts';
const now = new Date('2026-09-09T06:00:00Z');
const employees = Array.from({ length: Number(process.env.BENCH_EMPLOYEES || 5) }, (_, i) => ({
  id: 'employee-' + i, companyId: 'default', companyIds: ['default'], status: 'active', inviteStatus: 'accepted',
  shiftTimezone: 'Asia/Manila', shiftStartTime: '09:00', shiftEndTime: '17:00', workingDays: [0,1,2,3,4,5,6],
}) as Employee);
const punches: Punch[] = [];
for (const employee of employees) {
  for (let day = Number(process.env.BENCH_DAYS || 30) - 1; day >= 0; day--) {
    const start = new Date(now); start.setUTCDate(start.getUTCDate() - day); start.setUTCHours(1, 10, 0, 0);
    punches.push({id: employee.id + '-in-' + day, employeeId: employee.id, companyId: 'default', type: 'in', timestamp: start, source: 'app'} as unknown as Punch);
    if (day) punches.push({id: employee.id + '-out-' + day, employeeId: employee.id, companyId: 'default', type: 'out', timestamp: new Date(start.getTime() + 8 * 3600000), source: 'app'} as unknown as Punch);
  }
}
let started = performance.now();
const records = buildLateRecords(employees, punches, [], [], now, { period: 'today' });
const lateMs = performance.now() - started;
const own = punches.filter(p => p.employeeId === employees[0].id);
started = performance.now();
getLiveAttendanceStatus(employees[0], own, now);
computeRegularWorkedMsForDay(employees[0], own, now, now);
console.log(JSON.stringify({employees: employees.length, punches: punches.length, records: records.length, lateMs: Math.round(lateMs), employeeTickMs: Math.round(performance.now() - started)}));
