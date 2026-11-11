/**
 * engine/factory — EngineConfig → Engine。
 * 未知 kind 直接抛出描述性中文错误(配置错误属于装配期缺陷,不属成员级失败)。
 */

import type { Engine, EngineConfig, EngineFactory } from '../contracts/index.js';
import { MockEngine } from './mock.js';
import { OpencodeEngine } from './opencode.js';

export const createEngine: EngineFactory = (config: EngineConfig): Engine => {
  switch (config.kind) {
    case 'opencode':
      return new OpencodeEngine();
    case 'mock':
      return new MockEngine();
    default:
      throw new Error(
        `AIWF(factory): 未知的 engine kind "${String((config as { kind: unknown }).kind)}"(支持: 'opencode' | 'mock')`,
      );
  }
};
