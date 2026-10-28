const sensitiveKeyPattern = /(authorization|cookie|set-cookie|api[-_]?key|token|secret|credential|password)/i;

export function maskSecret(secret: string, visibleTail = 4) {
  if (secret.length <= visibleTail) {
    return "*".repeat(secret.length);
  }

  return `${"*".repeat(Math.max(8, secret.length - visibleTail))}${secret.slice(-visibleTail)}`;
}

export function redactForLogging<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => redactForLogging(item)) as T;
  }

  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactForLogging(value)
      ])
    ) as T;
  }

  return input;
}
