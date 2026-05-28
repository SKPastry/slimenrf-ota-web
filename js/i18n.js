// Lightweight i18n for Alpine.js
// Provides $t('key') magic and $store.i18n for language switching.

import Alpine from 'alpinejs';
import en from './i18n/en.js';
import zhCN from './i18n/zh-CN.js';

const translations = { en, 'zh-CN': zhCN };
const supportedLocales = Object.keys(translations);
const localeNames = { en: 'EN', 'zh-CN': '中文' };

/** Detect initial locale from browser or localStorage. */
function detectLocale() {
  const stored = localStorage.getItem('slimevr-ota-locale');
  if (stored && translations[stored]) return stored;

  // Match browser language (e.g. zh-CN, zh, en-US → zh-CN, en)
  for (const lang of navigator.languages || [navigator.language]) {
    if (translations[lang]) return lang;
    const base = lang.split('-')[0];
    const match = supportedLocales.find(l => l.startsWith(base));
    if (match) return match;
  }
  return 'en';
}

/** Resolve a dotted key path against a translations object. */
function resolve(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Alpine Store ──────────────────────────────────────────
Alpine.store('i18n', {
  locale: detectLocale(),
  locales: supportedLocales,
  localeNames,

  /** Get a translation by dotted key. Supports {placeholder} interpolation. */
  t(key, params) {
    // Access this.locale to ensure Alpine reactivity
    const value = resolve(translations[this.locale], key)
                ?? resolve(translations.en, key)
                ?? key;
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  },

  /** Switch locale and persist. */
  setLocale(locale) {
    if (translations[locale]) {
      this.locale = locale;
      localStorage.setItem('slimevr-ota-locale', locale);
      document.documentElement.lang = locale;
    }
  },

  /** Cycle to next locale (for simple toggle buttons). */
  nextLocale() {
    const idx = supportedLocales.indexOf(this.locale);
    this.setLocale(supportedLocales[(idx + 1) % supportedLocales.length]);
  },
});

// ── Alpine Magic $t ───────────────────────────────────────
// Usage in templates: $t('conn.title') or $t('update.autoDismiss', { seconds: 5 })
Alpine.magic('t', () => {
  return (key, params) => Alpine.store('i18n').t(key, params);
});

// Set initial html lang attribute
document.documentElement.lang = Alpine.store('i18n').locale;
