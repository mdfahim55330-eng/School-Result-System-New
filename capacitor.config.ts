import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mdfahim.schoolresult',
  appName: 'School Result System',
  webDir: 'public',
  server: {
    // The existing website remains online and continues to serve both the browser and app.
    // Keep this same-origin so the current API and Admin session-cookie flow keep working.
    url: 'https://school-result-system-0k9n.onrender.com',
    cleartext: false,
    allowNavigation: ['school-result-system-0k9n.onrender.com'],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
