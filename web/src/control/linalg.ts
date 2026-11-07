/** Small dense helpers for the inverse kinematics. Matrices are row-major Float64Arrays. */

/**
 * Solves A x = b for a symmetric positive definite n x n matrix A, by Cholesky.
 * Returns null if A is not positive definite. A and b are not modified.
 */
export function solveSpd(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j]!;
      for (let k = 0; k < j; k++) sum -= l[i * n + k]! * l[j * n + k]!;
      if (i === j) {
        if (!(sum > 0)) return null;
        l[i * n + i] = Math.sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j]!;
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i * n + k]! * y[k]!;
    y[i] = sum / l[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i]! * x[k]!;
    x[i] = sum / l[i * n + i]!;
  }
  return x;
}

/**
 * One damped least squares step: dq = J^T (J J^T + lambda^2 I)^-1 e.
 * J is rows x cols. Returns null only if the damped system cannot be solved.
 */
export function dampedLeastSquares(
  jacobian: Float64Array,
  error: Float64Array,
  rows: number,
  cols: number,
  lambda: number,
): Float64Array | null {
  const jjt = new Float64Array(rows * rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < rows; j++) {
      let sum = 0;
      for (let k = 0; k < cols; k++) sum += jacobian[i * cols + k]! * jacobian[j * cols + k]!;
      jjt[i * rows + j] = sum + (i === j ? lambda * lambda : 0);
    }
  }
  const y = solveSpd(jjt, error, rows);
  if (!y) return null;
  const dq = new Float64Array(cols);
  for (let k = 0; k < cols; k++) {
    let sum = 0;
    for (let i = 0; i < rows; i++) sum += jacobian[i * cols + k]! * y[i]!;
    dq[k] = sum;
  }
  return dq;
}
