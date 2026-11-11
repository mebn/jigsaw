// Runs fn at most once every ms. A call sooner than that is put off until it may run, so the last
// call always gets through, late; fn reads what is current when it runs.
export class Throttle {
  private last = 0
  private timer = 0
  private ms: number
  private fn: () => void

  constructor(ms: number, fn: () => void) {
    this.ms = ms
    this.fn = fn
  }

  // Runs fn now if it may (or force), otherwise as soon as it may.
  call(force = false) {
    clearTimeout(this.timer)
    const now = performance.now()
    if (force || now - this.last >= this.ms) {
      this.last = now
      this.fn()
    } else this.timer = setTimeout(() => this.call(true), this.ms - (now - this.last))
  }

  cancel() {
    clearTimeout(this.timer)
  }

  // Counts as having just run: something else said the same.
  ran() {
    this.last = performance.now()
  }
}
