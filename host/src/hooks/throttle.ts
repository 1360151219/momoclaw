const THROTTLE_MS = 500;

export const useThrottleFn = (
  fn: (...args: any[]) => void,
  ms = THROTTLE_MS,
) => {
  let lastTime = 0;
  return (...args: any[]) => {
    const now = Date.now();
    if (now - lastTime > ms) {
      lastTime = now;
      fn(...args);
    }
  };
};
