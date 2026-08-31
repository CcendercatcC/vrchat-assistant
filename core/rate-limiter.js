/**
 * VRChat 好友监控系统 — API 请求限流器
 * 
 * VRChat API 限制约 30 次/分钟
 * 安全间隔：2.5 秒/次（约 24 次/分钟）
 * 
 * 支持：请求队列、自动等待、并发控制
 */
export class RateLimiter {
  constructor(options = {}) {
    this.minInterval = options.minInterval || 2600;  // 毫秒
    this.maxQueueSize = options.maxQueueSize || 50;
    // 任务级超时兜底：>0 时单个任务超过该时长即 reject，防止死任务锁死队列。
    // 默认 30000ms；taskTimeoutMs=0 表示关闭该兜底。
    this.taskTimeoutMs = options.taskTimeoutMs ?? 30000;
    this._lastCallTime = 0;
    this._queue = [];
    this._processing = false;
    this._totalCalls = 0;
    this._totalWaited = 0;
  }

  /**
   * 执行一个限流请求
   * @param {Function} fn - 返回 Promise 的异步函数
   * @returns {Promise<any>}
   */
  async execute(fn) {
    return new Promise((resolve, reject) => {
      if (this._queue.length >= this.maxQueueSize) {
        reject(new Error('Rate limiter queue full'));
        return;
      }
      this._queue.push({ fn, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this._lastCallTime;
      const waitTime = Math.max(0, this.minInterval - elapsed);

      if (waitTime > 0) {
        this._totalWaited += waitTime;
        await new Promise(r => setTimeout(r, waitTime));
      }

      const item = this._queue.shift();
      this._lastCallTime = Date.now();
      this._totalCalls++;

      // 任务级超时兜底：即使 fn 内部死等（网络 socket 挂起、handler 逻辑卡死），
      // 也会在 taskTimeoutMs 后 reject，防止一个任务占住队头把整条队列锁死。
      // 若 fn 已自行设置了更短超时/先完成，此处兑现 Promise.race 即可，无副作用。
      try {
        if (this.taskTimeoutMs > 0) {
          const result = await Promise.race([
            item.fn(),
            new Promise((_, rej) => {
              const t = setTimeout(() => {
                rej(new Error(`Rate limiter 任务超时 (${this.taskTimeoutMs}ms)`));
              }, this.taskTimeoutMs);
              // 若 item.fn 先完成，清掉这个闲置的定时器，避免进程被挂住
              if (typeof t.unref === 'function') t.unref();
            }),
          ]);
          item.resolve(result);
        } else {
          const result = await item.fn();
          item.resolve(result);
        }
      } catch (err) {
        item.reject(err);
      }
    }

    this._processing = false;
  }

  /** 获取统计 */
  getStats() {
    return {
      totalCalls: this._totalCalls,
      totalWaitedMs: this._totalWaited,
      queueLength: this._queue.length,
      isProcessing: this._processing,
      minInterval: this.minInterval,
    };
  }

  /** 重置统计 */
  resetStats() {
    this._totalCalls = 0;
    this._totalWaited = 0;
  }
}
