/** Each scenario owns its state directory; process generations inside it stay sequential. */
export async function runIndependentScenarios(cases, run) {
  const results = [];
  for (let index = 0; index < cases.length; index += 2) {
    const pair = await Promise.allSettled(cases.slice(index, index + 2).map(run));
    const failed = pair.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    results.push(...pair.map(result => result.value));
  }
  return results;
}
