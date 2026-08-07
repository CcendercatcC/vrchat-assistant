/**
 * VRChat API client — handles auth and API calls
 * 
 * Auth lifecycle:
 * 1. Load cookie from file → validate with /auth/user
 * 2. If cookie expired → auto-attempt Basic auth login (email+password)
 * 3. If Basic auth needs 2FA → save temp cookie, signal "need OTP"
 * 4. User provides OTP via submitOtp() → complete login, save new cookie
 * 5. Proactive cookie refresh via heartbeat endpoint
 */
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_BASE = 'https://api.vrchat.cloud/api/1';

export class VrchatApiClient {
  /** @type {Promise|null} single-flight lock for ensureAuth / ensureAuthWithAutoOtp */
  #authLock = null;

  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.authCookie = '';
    this.currentUser = null;
    this.requiresOtp = false;       // true after Basic auth when 2FA needed
    this.tempAuthCookie = '';       // partial cookie before OTP verify
    this._cookiePath = '';
    this.#authLock = null;       // single-flight lock for ensureAuth / ensureAuthWithAutoOtp
  }

  loadCookieFromFile(path) {
    this._cookiePath = path;
    if (existsSync(path)) {
      this.authCookie = readFileSync(path, 'utf-8').trim();
      return !!this.authCookie;
    }
    return false;
  }

  saveCookieToFile(path) {
    this._cookiePath = path || this._cookiePath;
    if (this._cookiePath) {
      writeFileSync(this._cookiePath, this.authCookie);
    }
  }

  /**
   * Make an HTTPS request with cookie
   */
  _request(method, path, body = null, customCookies = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(API_BASE + path);
      const cookieStr = customCookies || (this.authCookie ? `auth=${this.authCookie}` : '');

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Accept': 'application/json',
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        },
      };

      if (body) {
        options.headers['Content-Type'] = 'application/json';
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * If VRChat API accepted a basic auth login but still wants 2FA,
   * the `authCookie` variable still gets set to a valid temp cookie
   * that we need to send alongside the OTP verification request.
   * 
   * Full login flow: Basic auth → OTP verify → get user info
   */
  async loginWithOtp(otpCode) {
    if (!this.tempAuthCookie) throw new Error('No pending OTP session. Call tryLoginWithCredentials() first.');

    const otpCookieStr = `auth=${this.tempAuthCookie}`;

    // Step 2: Verify OTP
    const r2 = await this._rawRequest('POST', '/auth/twofactorauth/emailotp/verify',
      { code: otpCode }, otpCookieStr);
    if (r2.status !== 200) {
      throw new Error(`OTP 验证失败 (HTTP ${r2.status})`);
    }

    // Extract the REAL auth cookie from verify response Set-Cookie header.
    // VRChat may not re-send the cookie here — it can upgrade the temp
    // session in place, so keep the existing (now-upgraded) authCookie.
    const cookies = this._extractCookies(r2.headers);
    if (cookies.auth) {
      this.authCookie = cookies.auth;
    }

    // Step 3: Get user with the auth cookie
    const r3 = await this._request('GET', '/auth/user');
    if (r3.status !== 200 || !r3.data?.id) {
      throw new Error(`OTP 登录后获取用户信息失败 (HTTP ${r3.status})`);
    }

    this.currentUser = r3.data;
    this.requiresOtp = false;
    this.tempAuthCookie = '';
    this.saveCookieToFile();
    return this.currentUser;
  }

  /**
   * Attempt to login with email+password credentials.
   * Uses proper Authorization: Basic header for the initial auth request.
   * Returns { success: true, user } if no 2FA needed.
   * Returns { requiresOtp: true } if 2FA needed.
   * Throws on failure.
   */
  async tryLoginWithCredentials() {
    const basic = Buffer.from(`${this.email}:${this.password}`).toString('base64');

    // Use _rawRequest for Basic auth (proper Authorization header, not Cookie)
    const r1 = await this._basicAuthRequest('GET', '/auth/user', basic);
    const cookies = this._extractCookies(r1.headers);

    if (!cookies.auth) {
      const isLimited = r1.status === 401;
      console.error(`[VRChat API] ❌ Login failed. Status: ${r1.status}${isLimited ? ' [限流?]' : ''}, Body: ${JSON.stringify(r1.data).slice(0, 200)}`);
      const err = new Error('No auth cookie from login — check credentials or account status');
      if (isLimited) err.isRateLimited = true;
      throw err;
    }

    // Save the auth cookie regardless — it may be a temp cookie
    this.authCookie = cookies.auth;

    if (r1.data?.requiresTwoFactorAuth) {
      // 2FA required — save the temp cookie for OTP step
      this.requiresOtp = true;
      this.tempAuthCookie = cookies.auth;
      return { requiresOtp: true, message: 'Email OTP required. Please provide the code sent to your email.' };
    }

    // Success — no 2FA needed
    this.currentUser = r1.data;
    this.requiresOtp = false;
    this.tempAuthCookie = '';
    this.saveCookieToFile();
    return { success: true, user: r1.data };
  }

  /**
   * Make a request with Authorization: Basic header (for initial login)
   */
  async _basicAuthRequest(method, path, basicToken) {
    return new Promise((resolve, reject) => {
      const url = new URL(API_BASE + path);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Accept': 'application/json',
          'Authorization': `Basic ${basicToken}`,
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  _extractCookies(headers) {
    const result = {};
    const setCookie = headers['set-cookie'];
    if (setCookie) {
      for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
        const m = c.split(';')[0].match(/^([^=]+)=(.*)/);
        if (m) result[m[1]] = m[2];
      }
    }
    return result;
  }

  async _rawRequest(method, path, body, cookieStr) {
    return new Promise((resolve, reject) => {
      const url = new URL(API_BASE + path);
      const options = {
        hostname: url.hostname, path: url.pathname, method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Ensure logged in. Auto-tries credential re-login if cookie is expired.
   * Single-flight: concurrent callers wait for the same auth attempt.
   * Returns current user data on success.
   * Throws { needsOtp: true } if re-login requires 2FA.
   */
  async ensureAuth() {
    if (this.#authLock) return this.#authLock;
    this.#authLock = this._doEnsureAuth();
    try {
      return await this.#authLock;
    } finally {
      this.#authLock = null;
    }
  }

  async _doEnsureAuth() {
    // If we already know we need OTP, throw needsOtp signal
    if (this.requiresOtp) {
      const err = new Error('Auth requires email OTP. Use submit_otp tool.');
      err.needsOtp = true;
      throw err;
    }

    if (!this.authCookie) {
      // No cookie at all — try fresh login
      const result = await this.tryLoginWithCredentials();
      if (result.requiresOtp) {
        const err = new Error(result.message);
        err.needsOtp = true;
        throw err;
      }
      return result.user;
    }

    // Validate existing cookie
    const r = await this._request('GET', '/auth/user');
    if (r.status === 200 && r.data?.id) {
      // Cookie valid — update from Set-Cookie headers (VRChat extends expiry on use)
      const cookies = this._extractCookies(r.headers);
      if (cookies.auth) {
        this.authCookie = cookies.auth;
        this.saveCookieToFile();
      }
      this.currentUser = r.data;
      return r.data;
    }

    // Cookie expired — try re-login
    console.log('[VRChat API] ⚠️ Auth cookie expired, attempting re-login...');
    const result = await this.tryLoginWithCredentials();
    if (result.requiresOtp) {
      const err = new Error(result.message);
      err.needsOtp = true;
      throw err;
    }
    return result.user;
  }

  /**
   * Ensure authenticated, auto-fetching OTP from email if needed.
   * Single-flight: concurrent callers wait for the same auth attempt.
   * @param {Function} otpFetcher - async function that returns 6-digit OTP code
   * @returns {Object} current user data
   */
  async ensureAuthWithAutoOtp(otpFetcher) {
    if (this.#authLock) return this.#authLock;
    this.#authLock = this._doEnsureAuthWithAutoOtp(otpFetcher);
    try {
      return await this.#authLock;
    } finally {
      this.#authLock = null;
    }
  }

  async _doEnsureAuthWithAutoOtp(otpFetcher) {
    try {
      return await this._doEnsureAuth();
    } catch (err) {
      if (!err.needsOtp) throw err;
      console.log('[VRChat API] ⚠️ 需要邮箱验证码，自动获取中...');
      try {
        const otpCode = await otpFetcher();
        if (!otpCode || !/^\d{6}$/.test(String(otpCode))) {
          throw new Error(`无效的验证码: "${otpCode}"，应为6位数字`);
        }
        return await this.loginWithOtp(String(otpCode));
      } catch (otpErr) {
        this.requiresOtp = false;
        this.tempAuthCookie = '';
        throw new Error(`OTP 自动登录失败: ${otpErr.message}`);
      }
    }
  }

  /**
   * Quick health check — validates cookie without side effects.
   * Returns { valid: true, user } or { valid: false }.
   */
  async checkAuth() {
    if (!this.authCookie) return { valid: false };
    try {
      const r = await this._request('GET', '/auth/user');
      if (r.status === 200 && r.data?.id) {
        // Update cookie from response headers (extends lifespan)
        const cookies = this._extractCookies(r.headers);
        if (cookies.auth) {
          this.authCookie = cookies.auth;
          this.saveCookieToFile();
        }
        return { valid: true, user: r.data, displayName: r.data.displayName };
      }
      return { valid: false };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Send a boop (poke) to a user
   */
  async sendBoop(userId, emojiId = '') {
    const user = await this.ensureAuth();
    return await this._request('POST', `/users/${encodeURIComponent(userId)}/boop`,
      emojiId ? { emojiId } : {});
  }

  /**
   * Invite a user to your instance
   */
  async sendInvite(userId, worldId, instanceId, message = '') {
    await this.ensureAuth();
    // VRChat API expects combined instanceId format: "worldId:instanceDetails"
    const inviteBody = { instanceId: `${worldId}:${instanceId}` };
    if (message) inviteBody.message = message;
    return await this._request('POST', `/invite/${encodeURIComponent(userId)}`, inviteBody);
  }

  /**
   * Request invite from a user
   */
  async requestInvite(userId, message = '') {
    await this.ensureAuth();
    return await this._request('POST', `/requestInvite/${encodeURIComponent(userId)}`, {
      message: message || 'Can I join you?', platform: 'standalonewindows',
    });
  }

  /**
   * Send a friend request to a user
   */
  async sendFriendRequest(userId) {
    await this.ensureAuth();
    return await this._request('POST', `/user/${encodeURIComponent(userId)}/friendRequest`, {});
  }

  /**
   * Remove a friend
   */
  async removeFriend(userId) {
    await this.ensureAuth();
    return await this._request('DELETE', `/auth/user/friends/${encodeURIComponent(userId)}`);
  }

  /**
   * Get user info
   */
  async getUser(userId) {
    await this.ensureAuth();
    return await this._request('GET', `/users/${encodeURIComponent(userId)}`);
  }

  /**
   * Upload an image file via multipart/form-data (used for custom emojis)
   */
  async uploadImageFile(fileBuffer, filename, params) {
    await this.ensureAuth();
    // 显式 contentType: image/png（默认 fileDisplayName 'blob' 无扩展名 → octet-stream → 服务端 400 "must be an image"）
    return this._multipartRequest('POST', '/file/image', fileBuffer, filename, params, { fileFieldName: 'file', fileDisplayName: 'blob', contentType: 'image/png' });
  }

  /**
   * Upload a photo to VRChat Plus prints album
   */
  async uploadPrint(fileBuffer, filename, { note = '', timestamp } = {}) {
    await this.ensureAuth();
    return this._multipartRequest('POST', '/prints', fileBuffer, filename, { note, timestamp }, { fileFieldName: 'image', fileDisplayName: 'image', contentType: 'image/png' });
  }

  /**
   * Upload an image to VRChat Plus gallery
   */
  async uploadGalleryImage(fileBuffer, filename) {
    await this.ensureAuth();
    // 文件字段名 "file"/"blob"；显式指定 image/png（blob 无扩展名会被识别为 octet-stream 导致服务端拒收）
    return this._multipartRequest('POST', '/file/image', fileBuffer, filename, { tag: 'gallery' }, { fileFieldName: 'file', fileDisplayName: 'blob', contentType: 'image/png' });
  }

  _multipartRequest(method, path, fileBuffer, filename, params, { fileFieldName = 'file', fileDisplayName = 'blob', contentType } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(API_BASE + path);
      const boundary = `----VrcMonitorBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const cookieStr = this.authCookie ? `auth=${this.authCookie}` : '';
      const fieldName = fileFieldName || 'file';
      const displayName = fileDisplayName || 'blob';

      // VRChat /file/image 期望每个 JSON 参数作为独立 multipart 字段（VRCX BuildImageUploadRequest 实测）
      // 文件字段名/文件名可配置，默认 "file"/"blob"
      const parts = [];
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null) continue;
        parts.push(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key}"\r\n` +
          `\r\n${value}\r\n`
        );
      }
      const ct = contentType || this._guessContentType(displayName);
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${displayName}"\r\n` +
        `Content-Type: ${ct}\r\n\r\n`
      );
      const pre = Buffer.from(parts.join(''));
      const post = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([pre, fileBuffer, post]);

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Accept': 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _guessContentType(filename) {
    if (!filename) return 'application/octet-stream';
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
    };
    return map[ext] || 'application/octet-stream';
  }

  /**
   * Download a binary file (VRChat file endpoints require Cookie + UA, otherwise 403)
   * @param {string} url Full URL (e.g. https://api.vrchat.cloud/api/1/file/xxx/1/file)
   * @returns {Promise<Buffer>}
   */
  async downloadFile(url) {
    await this.ensureAuth();
    return this._downloadWithRedirects(url, 0);
  }

  _downloadWithRedirects(url, redirectCount) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const options = {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Cookie': `auth=${this.authCookie}`,
        },
      };

      const req = https.request(options, (res) => {
        // 302/301 重定向（VRChat 文件 URL → files.vrchat.cloud CDN 签名 URL）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error(`重定向次数过多 (${url})`));
            return;
          }
          // 相对/绝对 location 解析
          const next = new URL(res.headers.location, url).toString();
          res.resume(); // 释放连接
          resolve(this._downloadWithRedirects(next, redirectCount + 1));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`下载失败 HTTP ${res.statusCode}`));
            return;
          }
          const buffer = Buffer.concat(chunks);
          buffer.contentType = res.headers['content-type'] || null;
          resolve(buffer);
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}
