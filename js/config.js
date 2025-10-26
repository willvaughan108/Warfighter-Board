(() => {
  'use strict';
  const settingsNode = document.getElementById('settings-json');
  const parsedSettings = settingsNode ? JSON.parse(settingsNode.textContent || '{}') : {};

  window.AppConfig = {
    SETTINGS: parsedSettings,
    APP_VERSION: parsedSettings.version || 'v1.0',
    EMAIL_DOMAIN: parsedSettings.emailDomain || 'us.navy.mil',
    AUTO_SAVE_MS: Number(parsedSettings.autoSaveMs || 400),
    POLL_MS: Number(parsedSettings.pollMs || 5000),
    ABBREV_MAX: Number(parsedSettings.abbrevMax || 3),
    HIGHLIGHTS: parsedSettings.highlights || { mine: '#2e7d32', others: '#1f3a93' }
  };
})();
