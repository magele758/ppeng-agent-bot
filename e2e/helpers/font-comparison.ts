import { test as base } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFontMeter } from '../../scripts/bombadil/font-meter.mjs';

// Opt-in instrumentation of the existing four test bodies.
export const test = base.extend({
  page: async ({ page }, use, info) => {
    const directory = process.env.PLAYWRIGHT_FONT_COMPARISON_DIR;
    if (!directory) return use(page);
    await page.addInitScript(installFontMeter);
    await use(page);
    const sample = await page.evaluate(() => (window as any).__fontComparison);
    if (!sample) throw new Error('Font comparison did not observe the regression page');
    writeFileSync(join(directory, info.testId + '.json'), JSON.stringify(sample));
    if (sample.violation) throw new Error('Font preview mismatch: ' + sample.violation);
  }
});
