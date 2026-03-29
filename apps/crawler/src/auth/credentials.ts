import { TOTP, Secret } from "otpauth";

type Credentials = {
  username: string;
  password: string;
};

export async function getCredentials(): Promise<Credentials> {
  const username = process.env.MF_USERNAME;
  const password = process.env.MF_PASSWORD;

  if (!username || !password) {
    console.error("MF_USERNAME and MF_PASSWORD environment variables are required");
    process.exit(1);
  }

  return { username, password };
}

export async function getOTP(): Promise<string> {
  const secret = process.env.MF_TOTP_SECRET;

  if (!secret) {
    throw new Error("MF_TOTP_SECRET environment variable is required for OTP generation");
  }

  // Base32シークレットからSecretオブジェクトを作成
  const secretObj = Secret.fromBase32(secret);

  const totp = new TOTP({
    secret: secretObj,
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });

  const otp = totp.generate();
  console.log(`OTP generated successfully: ${otp}`);
  return otp;
}

export function _resetOpClient(): void {
  // no-op
}
