/** Convert a local wall time to an instant in an explicit IANA zone.
 * Repeated times choose the first occurrence; nonexistent times reject.
 */
export function zonedLocalToIso(local: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new RangeError("Invalid scheduled time");
  const [, year, month, day, hour, minute] = match;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const asWall = (at: number) => {
    const p = Object.fromEntries(
      formatter
        .formatToParts(new Date(at))
        .map((part) => [part.type, part.value]),
    );
    return Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
  };
  const candidates = [-36, 0, 36]
    .map((h) => wall + h * 3600000)
    .map((at) => wall - (asWall(at) - at))
    .filter((at) => asWall(at) === wall);
  if (!candidates.length)
    throw new RangeError(
      "Scheduled local time does not exist in this time zone",
    );
  return new Date(Math.min(...candidates)).toISOString();
}

export function zonedInstantToLocal(instant: string, timezone: string): string {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
 return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
