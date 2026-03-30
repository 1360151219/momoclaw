export class SessionQueue {
  private queues: Map<string, Promise<any>> = new Map();

  /**
   * 将任务加入特定会话的队列中。
   * 相同会话的任务将串行执行，不同会话的任务可并发执行。
   * 
   * @param sessionId 会话 ID
   * @param task 要执行的异步任务
   * @returns 任务执行的 Promise 结果
   */
  async enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    // 获取当前会话的最后一个 Promise，如果没有则使用已 resolve 的 Promise
    const currentPromise = this.queues.get(sessionId) || Promise.resolve();

    // 创建新的 Promise，在上一个完成后执行 task
    const nextPromise = currentPromise.then(() => task());

    // 无论成功还是失败，都生成一个确保 resolve 的 Promise 存入队列，防止阻塞后续任务
    const safePromise = nextPromise.catch((err) => {
      console.error(`[SessionQueue] Task error in queue for session ${sessionId}:`, err);
    });

    this.queues.set(sessionId, safePromise);

    // 任务结束后，如果是当前会话的最后一个任务，则清理掉，避免内存泄漏
    safePromise.finally(() => {
      if (this.queues.get(sessionId) === safePromise) {
        this.queues.delete(sessionId);
      }
    });

    return nextPromise;
  }
}

export const sessionQueue = new SessionQueue();
