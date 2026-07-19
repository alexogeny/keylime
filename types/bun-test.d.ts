declare module "bun:test" {
  export type TestCallback = () => unknown | Promise<unknown>;
  export interface TestFunction {
    (name: string, callback: TestCallback, timeout?: number): void;
    each(cases: readonly unknown[]): (name: string, callback: (...args: any[]) => unknown | Promise<unknown>) => void;
  }
  export const test: TestFunction;
  export const it: TestFunction;
  export const describe: (name: string, callback: TestCallback) => void;
  export const beforeEach: (callback: TestCallback) => void;
  export const afterEach: (callback: TestCallback) => void;
  export const beforeAll: (callback: TestCallback) => void;
  export const afterAll: (callback: TestCallback) => void;
  export interface ExpectFunction {
    <T = unknown>(value?: T, message?: string): any;
    arrayContaining(value: unknown[]): any;
    objectContaining(value: Record<string, unknown>): any;
    stringContaining(value: string): any;
    anything(): any;
  }
  export const expect: ExpectFunction;
  export const mock: any;
  export const spyOn: any;
}

declare const Bun: {
  spawn(args: string[], options?: Record<string, unknown>): { exited: Promise<number>; stdout?: unknown; stderr?: unknown };
  file(path: string): any;
};
