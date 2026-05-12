import {
  _initTestDatabase as _initCoreTestDatabase,
  isDatabaseHealthy,
} from '../../db.js';
import { _initClawrocketTestSchema } from './init.js';

export { _initClawrocketTestSchema, initClawrocketSchema } from './init.js';
export * from './accessors.js';
export * from './agent-accessors.js';
export * from './browser-accessors.js';
export * from './browser-run-accessors.js';
export * from './channel-accessors.js';
export * from './connector-accessors.js';
export * from './context-accessors.js';
export * from './job-accessors.js';
export * from './output-accessors.js';
export * from './talk-tools-accessors.js';
export { isDatabaseHealthy };

/** @internal - for tests only. Initializes core + clawrocket schemas. */
export function _initTestDatabase(): void {
  _initCoreTestDatabase();
  _initClawrocketTestSchema();
}
