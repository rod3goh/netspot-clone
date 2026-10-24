'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * PowerShell cannot read a script directly from an asar archive, so the helper
 * is copied to the temp directory before spawning it. Falls back to the source
 * path when the copy is not possible (e.g. running from a plain checkout).
 */
function materialiseHelperScript() {
  const source = path.join(__dirname, 'wlan-helper.ps1');
  try {
    const content = fs.readFileSync(source, 'utf8');
    const target = path.join(os.tmpdir(), `netspot-wlan-helper-${process.pid}.ps1`);
    fs.writeFileSync(target, content, 'utf8');
    return target;
  } catch {
    return source;
  }
}

/**
 * Long-lived PowerShell process that exposes the native Windows WLAN API.
 * Using wlanapi.dll gives true RSSI (dBm), center frequency, channel width
 * and security suites, which `netsh` does not report. If anything fails the
 * scanner silently falls back to the netsh parser.
 */
class WlanApiClient {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = null;
    this.disabled = false;
    this.lastError = null;
    this.stderr = '';
    this.readyPromise = null;
  }

  get available() {
    return process.platform === 'win32' && !this.disabled && process.env.NETSPOT_WLANAPI !== '0';
  }

  start() {
    if (this.proc || this.disabled) return;
    const script = materialiseHelperScript();
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      this.disabled = true;
      this.lastError = String(err.message || err);
      return;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.proc.on('error', (err) => {
      this.lastError = String(err.message || err);
      this._failPending(this.lastError);
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (code !== 0) this.lastError = `WLAN helper encerrou (código ${code})`;
      this._failPending(this.lastError || 'WLAN helper encerrou');
    });
  }

  _failPending(message) {
    if (this.pending) {
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      reject(new Error(message));
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.startsWith('DATA ')) {
        const pending = this.pending;
        this.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          try {
            pending.resolve(JSON.parse(line.slice(5)));
          } catch (err) {
            pending.reject(err);
          }
        }
      } else if (line.startsWith('ERR ')) {
        const pending = this.pending;
        this.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(line.slice(4)));
        }
      } else if (line.startsWith('READY')) {
        // helper compiled successfully
      } else if (line.startsWith('FATAL ')) {
        this.disabled = true;
        this.lastError = line.slice(6);
        this._failPending(line.slice(6));
      }
    }
  }

  scan(timeoutMs = 20000) {
    if (!this.available) return Promise.reject(new Error('WLAN API indisponível'));
    this.start();
    if (!this.proc) return Promise.reject(new Error(this.lastError || 'WLAN API indisponível'));
    if (this.pending) return Promise.reject(new Error('Varredura WLAN API já em andamento'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.disabled = true;
        try {
          this.proc?.kill();
        } catch {}
        this.proc = null;
        reject(new Error('Tempo esgotado ao consultar a WLAN API'));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        this.proc.stdin.write('scan\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      }
    });
  }

  stop() {
    this._failPending('Encerrado');
    if (this.proc) {
      try {
        this.proc.stdin.write('quit\n');
      } catch {}
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }
}

module.exports = { WlanApiClient };
