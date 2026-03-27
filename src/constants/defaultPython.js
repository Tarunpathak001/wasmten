export const DEFAULT_PYTHON = `import numpy as np

# WasmForge — Phase 1 smoke test
# No backend. Pure WebAssembly.

print("hello world from WasmForge")

a = np.array([[1, 2], [3, 4]])
b = np.array([[5, 6], [7, 8]])

print("\\nMatrix A:")
print(a)
print("\\nMatrix B:")
print(b)
print("\\nA @ B:")
print(a @ b)
print(f"\\ndet(A): {np.linalg.det(a):.6f}")
print(f"sum(B): {b.sum()}")
`
