import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '../../../i18n.js': path.resolve(__dirname, 'test/__mocks__/i18n.js'),
        },
    },
});
