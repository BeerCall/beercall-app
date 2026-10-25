import { defineConfig } from '@playwright/test';
import uxConfig from './playwright.ux.config';

process.env.BEERCALL_EXPECT_HDR = 'absent';

// Exercise the canonical optimized build, not the older integration checkout.
export default defineConfig({
    ...uxConfig,
    testMatch: [/ux-.*\.spec\.ts/, /fluidite-diagnostics\.spec\.ts/],
    webServer: {
        command: 'npm --prefix ../../beercall-frontend run preview -- --host 127.0.0.1 --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: false,
    },
});
