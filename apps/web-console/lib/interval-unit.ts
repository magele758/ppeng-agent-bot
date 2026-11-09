export function intervalUnit(value: string) {
  const milliseconds = Number(value);
  for (const [unit, divisor] of [['day',86400000],['hour',3600000],['minute',60000]] as const) {
    if (milliseconds >= divisor && milliseconds % divisor === 0) return {unit,count:milliseconds/divisor};
  }
  return {unit:'second' as const,count:milliseconds/1000};
}
