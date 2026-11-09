import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPollLoop, type PollLoop } from "./poll-loop";

describe("startPollLoop", () => {
  let loop: PollLoop | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    loop?.stop();
    loop = null;
    vi.useRealTimers();
  });

  it("abandons a poll that never settles and keeps polling", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    loop = startPollLoop({
      run: (signal) => {
        calls++;
        signals.push(signal);
        // The first read hangs forever (and ignores its signal); later ones answer.
        return calls === 1 ? new Promise<number>(() => {}) : Promise.resolve(100);
      },
      timeoutMs: 1_000,
      retryMs: 50,
      hiddenMs: 2_000,
      isHidden: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(5);
  });

  it("gives a slow server longer after each abandoned poll, so its answer finally lands (D109)", async () => {
    let calls = 0;
    let answered = 0;
    // Every read takes 2.5 s: longer than the 1 s limit, shorter than its doubled doublings.
    loop = startPollLoop({
      run: (signal) => {
        calls++;
        return new Promise<number>((resolve, reject) => {
          const t = setTimeout(() => {
            answered++;
            resolve(10_000);
          }, 2_500);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      },
      timeoutMs: 1_000,
      retryMs: 10,
      hiddenMs: 2_000,
      isHidden: () => false,
    });
    // 1 s (abandoned), 2 s (abandoned), then 4 s: the third read answers.
    await vi.advanceTimersByTimeAsync(1_000 + 10 + 2_000 + 10 + 2_500);
    expect(answered).toBe(1);
    expect(calls).toBe(3);
  });

  it("retries after a failed poll", async () => {
    let calls = 0;
    loop = startPollLoop({
      run: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(10_000);
      },
      timeoutMs: 1_000,
      retryMs: 200,
      hiddenMs: 2_000,
      isHidden: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(2);
  });

  it("never runs two polls at once, and a wake during one polls right after it", async () => {
    let active = 0;
    let most = 0;
    let calls = 0;
    const resolvers: ((ms: number) => void)[] = [];
    loop = startPollLoop({
      run: () => {
        calls++;
        active++;
        most = Math.max(most, active);
        return new Promise<number>((resolve) =>
          resolvers.push((ms) => {
            active--;
            resolve(ms);
          }),
        );
      },
      timeoutMs: 5_000,
      retryMs: 50,
      hiddenMs: 2_000,
      isHidden: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    loop.wake();
    loop.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    resolvers[0](3_000); // the poll asks for a slow next one, but a wake is waiting
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(most).toBe(1);
  });

  it("brings a far-off poll forward on wake, but never postpones a sooner one", async () => {
    let calls = 0;
    loop = startPollLoop({
      run: () => {
        calls++;
        return Promise.resolve(10_000);
      },
      timeoutMs: 1_000,
      retryMs: 50,
      hiddenMs: 2_000,
      isHidden: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    loop.wake(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    loop.wake(50);
    loop.wake(5_000); // later than the pending one: ignored
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(3);
  });

  it("keeps polling a hidden tab, only more slowly", async () => {
    let calls = 0;
    loop = startPollLoop({
      run: () => {
        calls++;
        return Promise.resolve(100);
      },
      timeoutMs: 1_000,
      retryMs: 50,
      hiddenMs: 1_000,
      isHidden: () => true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(4);
    // An input (wake) still polls at once.
    loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(5);
  });

  it("stops, aborting the poll in flight", async () => {
    let signal: AbortSignal | null = null;
    let calls = 0;
    loop = startPollLoop({
      run: (s) => {
        calls++;
        signal = s;
        return new Promise<number>(() => {});
      },
      timeoutMs: 1_000,
      retryMs: 50,
      hiddenMs: 1_000,
      isHidden: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    expect(signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
  });
});
