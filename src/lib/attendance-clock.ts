let anchor: { serverMs: number; monotonicMs: number } | null = null;
export function calibrateAttendanceClock(serverMs: number, roundTripMs = 0) {
  if (!Number.isFinite(serverMs) || !Number.isFinite(roundTripMs) || roundTripMs < 0) return;
  anchor = { serverMs: serverMs + roundTripMs / 2, monotonicMs: performance.now() };
}
export function attendanceNow(): Date {
  return new Date(anchor ? anchor.serverMs + performance.now() - anchor.monotonicMs : Date.now());
}
