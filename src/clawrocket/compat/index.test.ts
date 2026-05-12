import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { COMPAT_TOUCHPOINTS } from './index.js';

describe('COMPAT_TOUCHPOINTS', () => {
  it('references files that exist in this repo', () => {
    for (const [name, relPath] of Object.entries(COMPAT_TOUCHPOINTS)) {
      const absPath = path.resolve(process.cwd(), relPath);
      expect(
        fs.existsSync(absPath),
        `Missing touchpoint "${name}" at ${relPath}`,
      ).toBe(true);
    }
  });
});
