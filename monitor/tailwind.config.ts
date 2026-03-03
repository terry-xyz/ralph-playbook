import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/client/**/*.{js,ts,jsx,tsx}',
    './index.html',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
