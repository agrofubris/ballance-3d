// The MSVCRT `qsort` that CK2.dll imports for CKBehavior::SortSubs, ported
// operation for operation (shortsort below nine elements, median-of-three
// quicksort with an explicit stack above). It is not stable: equal keys are
// permuted, which decides the execution order of a compound's equal-priority
// sub-behaviors. Checked against the 32-bit system msvcrt.dll.

/** Sort `items` in place with MSVCRT qsort semantics; `compare` as in C. */
export function crtQsort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  const swap = (i: number, j: number) => { if (i !== j) { const t = items[i]!; items[i] = items[j]!; items[j] = t } }
  const comp = (i: number, j: number) => compare(items[i]!, items[j]!)
  const shortsort = (lo: number, hi: number) => {
    while (hi > lo) {
      let max = lo
      for (let p = lo + 1; p <= hi; p++) if (comp(p, max) > 0) max = p
      swap(max, hi)
      hi--
    }
  }
  if (items.length < 2) return items
  const stack: [number, number][] = []
  let lo = 0, hi = items.length - 1
  for (;;) {
    const size = hi - lo + 1
    let recurse = false
    if (size <= 8) {
      shortsort(lo, hi)
    } else {
      let mid = lo + Math.floor(size / 2)
      if (comp(lo, mid) > 0) swap(lo, mid)
      if (comp(lo, hi) > 0) swap(lo, hi)
      if (comp(mid, hi) > 0) swap(mid, hi)
      let loguy = lo, higuy = hi
      for (;;) {
        if (mid > loguy) { do loguy++; while (loguy < mid && comp(loguy, mid) <= 0) }
        if (mid <= loguy) { do loguy++; while (loguy <= hi && comp(loguy, mid) <= 0) }
        do higuy--; while (higuy > mid && comp(higuy, mid) > 0)
        if (higuy < loguy) break
        swap(loguy, higuy)
        if (mid === higuy) mid = loguy
      }
      higuy++
      if (mid < higuy) { do higuy--; while (higuy > mid && comp(higuy, mid) === 0) }
      if (mid >= higuy) { do higuy--; while (higuy > lo && comp(higuy, mid) === 0) }
      if (higuy - lo >= hi - loguy) {
        if (lo < higuy) stack.push([lo, higuy])
        if (loguy < hi) { lo = loguy; recurse = true }
      } else {
        if (loguy < hi) stack.push([loguy, hi])
        if (lo < higuy) { hi = higuy; recurse = true }
      }
    }
    if (recurse) continue
    const next = stack.pop()
    if (!next) return items
    ;[lo, hi] = next
  }
}
