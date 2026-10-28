export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertDevelopmentUnlimitedBalanceGuard } = await import("@/server/entitlements/development");
    assertDevelopmentUnlimitedBalanceGuard();
  }
}
