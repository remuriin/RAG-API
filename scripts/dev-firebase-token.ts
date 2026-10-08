// Signs in the test account from .env and prints a Firebase ID token, for testing the management API with curl.
// The token is valid for about an hour.
import "dotenv/config";

async function main() {
  const { FIREBASE_WEB_API_KEY, TEST_EMAIL, TEST_PASSWORD } = process.env;
  if (!FIREBASE_WEB_API_KEY || !TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error("FIREBASE_WEB_API_KEY, TEST_EMAIL and TEST_PASSWORD must be set in .env");
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true }),
    }
  );
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Sign-in failed: ${data?.error?.message ?? res.status}`);

  console.log(data.idToken);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
