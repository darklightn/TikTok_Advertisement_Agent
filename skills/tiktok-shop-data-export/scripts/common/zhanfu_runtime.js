'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { codedError } = require('./zhanfu_client');

const DEFAULT_IPC_PORT = 45008;
const INTERACTIVE_IPC_PORT = 45009;

function executableCandidates(env = process.env) {
  const local = env.LOCALAPPDATA || '';
  return [env.ZHANFU_CLIENT_PATH, 'D:\\download\\战斧\\ZhanFu\\站斧.exe', local && path.join(local, 'Programs', 'ZhanFu', '站斧.exe'), local && path.join(local, 'ZhanFu', '站斧.exe')].filter(Boolean);
}

function resolveZhanFuExecutable(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const matches = [...new Set(executableCandidates(options.env || process.env))].filter(existsSync);
  if (!matches.length) throw codedError('zhanfu_client_not_found', 'ZhanFu executable was not found');
  return matches[0];
}

function zhanfuLaunchArgs(port = DEFAULT_IPC_PORT) {
  return ['--multip', '--run_type=web_driver', '--ipc_type=http', `--httpport=${Number(port)}`];
}

function runtimeMode(env = process.env) {
  const mode = String(env.ZHANFU_RUNTIME_MODE || 'interactive_shared');
  if (!['interactive_shared', 'background_unattended'].includes(mode)) throw codedError('zhanfu_runtime_mode_invalid', `Unsupported ZHANFU_RUNTIME_MODE: ${mode}`);
  return mode;
}

function defaultIpcPort(mode) { return mode === 'background_unattended' ? DEFAULT_IPC_PORT : INTERACTIVE_IPC_PORT; }

async function resolveIpcPort(mode, options = {}) {
  const explicit = options.ipcPort || options.env?.ZHANFU_IPC_PORT;
  if (explicit) return Number(explicit);
  const preferred = defaultIpcPort(mode);
  if (mode !== 'interactive_shared') return preferred;
  const inspect = options.inspectSessions || inspectWindowsSessions;
  const preferredSession = await inspect(preferred, options);
  if (Number.isInteger(preferredSession.active_session_id) && preferredSession.service_session_id === preferredSession.active_session_id) return preferred;
  const legacySession = await inspect(DEFAULT_IPC_PORT, options);
  if (Number.isInteger(legacySession.active_session_id) && legacySession.service_session_id === legacySession.active_session_id) return DEFAULT_IPC_PORT;
  return preferred;
}

async function inspectWindowsSessions(port, options = {}) {
  if (options.platform && options.platform !== 'win32') throw codedError('zhanfu_interactive_session_unavailable', 'Interactive ZhanFu mode requires Windows');
  const script = `$active=@(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 } | Select-Object -ExpandProperty SessionId -Unique); if($active.Count -ne 1){throw 'active_session_not_unique'}; $conn=Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1; $ownerPid=$null; if($conn){$ownerPid=[int]$conn.OwningProcess}; if(-not $ownerPid){$line=netstat -ano -p tcp | Select-String -Pattern ('127\\.0\\.0\\.1:${Number(port)}\\s+.*LISTENING\\s+(\\d+)') | Select-Object -First 1; if($line -and $line.Matches.Count -gt 0){$ownerPid=[int]$line.Matches[0].Groups[1].Value}}; $serviceSession=$null; if($ownerPid){$serviceSession=(Get-Process -Id $ownerPid -ErrorAction Stop).SessionId}; [pscustomobject]@{active_session_id=[int]$active[0];service_session_id=$serviceSession}|ConvertTo-Json -Compress`;
  try { const { execFile } = require('child_process'); const { promisify } = require('util'); const { stdout } = await (options.execFileAsync || promisify(execFile))('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }); return JSON.parse(stdout.trim()); }
  catch (error) { throw codedError('zhanfu_interactive_session_unavailable', String(error.stderr || error.message || error)); }
}

async function launchInInteractiveSession(executable, args, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  try { const child = spawnProcess(executable, args, { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false }); child.unref(); }
  catch (error) { throw codedError('zhanfu_interactive_launch_failed', String(error.message || error)); }
}

async function probeZhanFuService(client) {
  try {
    const response = await client.callWebDriver('GetBrowserList', JSON.stringify({ page: 1, limit: 1 }), undefined, 5000);
    return String(response?.ret) === '200' && String(response?.returnObj?.success).toLowerCase() === 'true';
  } catch { return false; }
}

async function ensureZhanFuService(client, options = {}) {
  const mode = options.runtimeMode || runtimeMode(options.env || process.env); const port = Number(options.ipcPort || defaultIpcPort(mode));
  const inspect = options.inspectSessions || inspectWindowsSessions;
  if (!options.allowModePortConflict) {
    const otherPort = port === DEFAULT_IPC_PORT ? INTERACTIVE_IPC_PORT : DEFAULT_IPC_PORT; const other = await inspect(otherPort, options);
    if (Number.isInteger(other.service_session_id)) throw codedError('zhanfu_mode_conflict', `Another ZhanFu runtime mode is already listening on port ${otherPort}`, { runtime_mode: mode, conflicting_port: otherPort, conflicting_session_id: other.service_session_id });
  }
  async function verified(modeName) {
    if (mode === 'background_unattended') return { serviceMode: modeName, runtimeMode: mode };
    const sessions = await inspect(port, options);
    if (!Number.isInteger(sessions.active_session_id) || sessions.service_session_id !== sessions.active_session_id) throw codedError('zhanfu_session_mismatch', 'ZhanFu service is not in the active interactive session', sessions);
    return { serviceMode: modeName, runtimeMode: mode, ...sessions };
  }
  if (await probeZhanFuService(client)) return verified('reused');
  const executable = options.executablePath || resolveZhanFuExecutable(options);
  if (mode === 'interactive_shared') await (options.launchInteractive || launchInInteractiveSession)(executable, zhanfuLaunchArgs(port), { ...options, ipcPort: port });
  else { const spawnProcess = options.spawnProcess || spawn; let child; try { child = spawnProcess(executable, zhanfuLaunchArgs(port), { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); } catch (error) { throw codedError('zhanfu_service_unavailable', String(error.message || error)); } }
  const deadline = Date.now() + Number(options.timeoutMs || 60000);
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  do {
    if (await probeZhanFuService(client)) return verified('started');
    await delay(Number(options.pollMs || 1000));
  } while (Date.now() < deadline);
  throw codedError('zhanfu_service_unavailable', 'ZhanFu WebDriver service did not become ready');
}

module.exports = { DEFAULT_IPC_PORT, INTERACTIVE_IPC_PORT, defaultIpcPort, ensureZhanFuService, executableCandidates, inspectWindowsSessions, launchInInteractiveSession, probeZhanFuService, resolveIpcPort, resolveZhanFuExecutable, runtimeMode, zhanfuLaunchArgs };
