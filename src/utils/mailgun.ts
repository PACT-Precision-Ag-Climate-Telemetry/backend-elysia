import FormData from "form-data";
import Mailgun from "mailgun.js";
import logger from "@/utils/logger";

import { getEmailVerificationTemplate } from "@/templates/emailVerification";
import { getPasswordResetTemplate } from "@/templates/passwordReset";

async function sendVerificationEmail(to: string, verificationLink: string) {
  const mailgun = new Mailgun(FormData);
  const mg = mailgun.client({
    username: "api",
    key: process.env.MAILGUN_API_KEY!,
    url: process.env.MAILGUN_API_URL!,
  });

  const html = getEmailVerificationTemplate(verificationLink);

  try {
    const result = await mg.messages.create(process.env.MAILGUN_DOMAIN!, {
      from: `PACT <noreply@${process.env.MAILGUN_DOMAIN}>`,
      to,
      subject: "ยืนยันอีเมลของคุณ",
      text: `โปรดยืนยันอีเมลของคุณโดยคลิกที่ลิงก์นี้ ${verificationLink}`,
      html,
    });

    logger.debug({
      message: `(mailgun.util.ts) Verification email sent to ${to} with id ${result.id}`,
    });
  } catch (error) {
    logger.error({
      message: `(mailgun.util.ts) Failed to send verification email to ${to}`,
      error,
    });
    throw error;
  }
}

async function sendForgotPasswordEmail(to: string, passwordResetLink: string) {
  const mailgun = new Mailgun(FormData);
  const mg = mailgun.client({
    username: "api",
    key: process.env.MAILGUN_API_KEY!,
    url: process.env.MAILGUN_API_URL!,
  });

  const html = getPasswordResetTemplate(passwordResetLink);

  try {
    const result = await mg.messages.create(process.env.MAILGUN_DOMAIN!, {
      from: `PACT <noreply@${process.env.MAILGUN_DOMAIN}>`,
      to,
      subject: "รีเซ็ตรหัสผ่านของคุณ",
      text: `โปรดรีเซ็ตรหัสผ่านของคุณโดยคลิกที่ลิงก์นี้ ${passwordResetLink}`,
      html,
    });

    logger.debug({
      message: `(mailgun.util.ts) Password reset email sent to ${to} with id ${result.id}`,
    });
  } catch (error) {
    logger.error({
      message: `(mailgun.util.ts) Failed to send password reset email to ${to}`,
      error,
    });
    throw error;
  }
}

export { sendVerificationEmail, sendForgotPasswordEmail };
