/** 取消等待，继续观察底层操作的迟到结果；调用方负责保护其副作用。 */
export async function waitWithAbort<T>(operation: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
