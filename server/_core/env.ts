function required(name: string, value: string) {
  if (!value && process.env.NODE_ENV === "production") {
    console.error(`[ENV] ${name} is not set. The app will not work correctly.`);
  }
  return value;
}

export const ENV = {
  /** Public origin of this deployment, e.g. https://ax-research-production.up.railway.app */
  appUrl: (process.env.APP_URL ?? "").replace(/\/+$/, ""),
  /** Signs the session cookie. Rotating it logs everyone out. */
  cookieSecret: required("JWT_SECRET", process.env.JWT_SECRET ?? ""),
  /**
   * Railway's MySQL plugin publishes its connection string as MYSQL_URL, while most other
   * hosts use DATABASE_URL. Accepting either removes a rename step that otherwise shows up
   * as a database-less app with no obvious cause.
   */
  databaseUrl: process.env.DATABASE_URL || process.env.MYSQL_URL || "",

  googleClientId: required(
    "GOOGLE_CLIENT_ID",
    process.env.GOOGLE_CLIENT_ID ?? ""
  ),
  googleClientSecret: required(
    "GOOGLE_CLIENT_SECRET",
    process.env.GOOGLE_CLIENT_SECRET ?? ""
  ),
  /**
   * Google account IDs allowed to sign in, comma separated. Empty means anyone with a
   * Google account may sign in. Set this while the app holds only your own notes.
   */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean),
  /** The first account to sign in with this email becomes admin. */
  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),

  /** Fallback Gemini key, used when a user has not supplied their own. */
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  inferenceModel: process.env.INFERENCE_MODEL?.trim() ?? "",

  r2AccountId: process.env.R2_ACCOUNT_ID ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  r2Bucket: process.env.R2_BUCKET ?? "",

  isProduction: process.env.NODE_ENV === "production",
};
