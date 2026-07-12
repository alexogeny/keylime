declare module "playwright" {
  export const chromium: {
    launch(options?: Record<string, unknown>): Promise<any>;
  };
}
