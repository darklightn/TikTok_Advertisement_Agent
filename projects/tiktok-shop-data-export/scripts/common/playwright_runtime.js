'use strict';

const path = require('path');
const Module = require('module');

function loadPlaywright(options = {}) {
  const requireImpl = options.requireImpl || require;
  try { return requireImpl('playwright'); } catch (initialError) {
    const userProfile = options.userProfile || process.env.USERPROFILE || '';
    const bundled = path.join(userProfile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
    const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
    process.env.NODE_PATH = [bundled, ...existing].filter(Boolean).join(path.delimiter);
    Module._initPaths();
    try { return requireImpl('playwright'); } catch { throw initialError; }
  }
}

async function connectExistingBrowser(cdpUrl, options = {}) {
  const playwright = options.playwright || loadPlaywright(options);
  let lastError;
  for (let attempt = 1; attempt <= Number(options.attempts || 3); attempt += 1) {
    try { return await playwright.chromium.connectOverCDP(cdpUrl, { timeout: Number(options.timeoutMs || 30000) }); }
    catch (error) { lastError = error; if (attempt < Number(options.attempts || 3)) await (options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(attempt * 1000); }
  }
  throw Object.assign(new Error(String(lastError?.message || lastError || 'CDP connection failed')), { code: 'cdp_connect_failed' });
}

module.exports = { connectExistingBrowser, loadPlaywright };
