import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/performance/**/*.test.ts'],
        testTimeout: 120_000,
        alias: {
            vscode: new URL('./tests/unit/__mocks__/vscode.ts', import.meta.url).pathname,
        },
    },
});
