import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';

test('config missing gives clear error', () => {
  expect(() => loadConfig('/nonexistent/config.json')).toThrow('run ga setup first');
});
