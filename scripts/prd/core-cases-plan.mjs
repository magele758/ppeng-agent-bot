import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function loadCoreCases(root, file = join(root, 'doc/prd/core-cases.yaml')) {
  const doc = parseYaml(readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.cases)) {
    throw new Error('core cases file needs a cases list');
  }
  const cases = doc.cases.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`core case ${index} is not a mapping`);
    }
    return {
      id: typeof item.id === 'string' ? item.id.trim() : '',
      title: typeof item.title === 'string' ? item.title.trim() : '',
      chapters: Array.isArray(item.chapters) ? item.chapters.map((chapter) => String(chapter).trim()) : [],
      specs: Array.isArray(item.specs) ? item.specs.map((id) => String(id).trim()).filter(Boolean) : [],
    };
  });
  return { note: typeof doc.note === 'string' ? doc.note.trim() : '', cases };
}

/**
 * A core journey counts only when every named spec is implemented and has an active tagged test.
 * Anything else is a failure, not an empty pass.
 */
export function validateCoreCases(cases, index) {
  const errors = [];
  const list = Array.isArray(cases) ? cases : [];
  if (list.length < 8 || list.length > 10) errors.push(`core journeys must be between 8 and 10 (got ${list.length})`);
  const files = new Set();
  const seen = new Set();
  for (const item of list) {
    const caseId = item?.id || '(missing id)';
    if (!item?.id) errors.push('a core case is missing an id');
    else if (seen.has(item.id)) errors.push(`duplicate core case ${item.id}`);
    else seen.add(item.id);
    if (!item?.title) errors.push(`${caseId} is missing a title`);
    if (!Array.isArray(item?.specs) || item.specs.length === 0) {
      errors.push(`${caseId} names no features`);
      continue;
    }
    for (const id of item.specs) {
      const spec = index.specsById.get(id);
      if (!spec) {
        errors.push(`${caseId} names unknown feature ${id}`);
        continue;
      }
      if (spec.status !== 'implemented') {
        errors.push(`${caseId} names ${id}, which is ${spec.status}, not implemented`);
        continue;
      }
      const tagged = index.testsBySpec.get(id) ?? [];
      if (tagged.length === 0) {
        errors.push(`${caseId} names ${id}, which has no active tagged test`);
        continue;
      }
      for (const file of tagged) files.add(file);
    }
  }
  return { ok: errors.length === 0, errors, files: [...files].sort() };
}

export function planCoreRun(cases, index) {
  const checked = validateCoreCases(cases, index);
  const byRunner = { unit: [], vitest: [], e2e: [] };
  if (!checked.ok) return { ...checked, byRunner };
  const errors = [];
  for (const file of checked.files) {
    const runner = index.runnerByFile?.get(file);
    if (runner !== 'unit' && runner !== 'vitest' && runner !== 'e2e') errors.push(`${file} is not on a known test runner`);
    else byRunner[runner].push(file);
  }
  return { ok: errors.length === 0, errors, files: checked.files, byRunner };
}
