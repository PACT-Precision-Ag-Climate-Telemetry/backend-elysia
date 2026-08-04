import { betterAuth } from "better-auth";
import { admin, openAPI, organization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createId } from "@paralleldrive/cuid2";
import db from "@/utils/db";
import {
  ac,
  ownerRole,
  adminRole,
  memberRole,
  orgHierarchy,
} from "@/utils/auth/permission";

import {
  sendVerificationEmail,
  sendForgotPasswordEmail,
} from "@/utils/mailgun";

function getVerificationLink(token: string): string {
  return `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
}

function getPasswordResetLink(token: string): string {
  return `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
}

export const auth = betterAuth({
  basePath: "/api",
  baseURL: process.env.BETTER_AUTH_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  advanced: {
    database: {
      generateId: () => createId(),
    },
  },
  experimental: { joins: true },
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url, token }, request) => {
      const passwordResetLink = getPasswordResetLink(token);
      await sendForgotPasswordEmail(user.email, passwordResetLink);
    },
  },
  emailVerification: {
    sendOnSignup: true,
    sendVerificationEmail: async ({ user, url, token }, request) => {
      const verificationLink = getVerificationLink(token);
      await sendVerificationEmail(user.email, verificationLink);
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  plugins: [
    admin(),
    openAPI(),
    organization({
      ac,
      roles: {
        owner: ownerRole,
        admin: adminRole,
        member: memberRole,
      },
      schema: {
        organization: {
          additionalFields: {
            orgType: {
              type: "string",
              required: true,
              enum: Object.keys(orgHierarchy),
            },
            parentOrgId: {
              type: "string",
              required: false,
            },
          },
        },
      },
      allowUserToCreateOrganization: async (user) => {
        return true;
      },
    }),
  ],
});

let _schema: ReturnType<typeof auth.api.generateOpenAPISchema>;
const getSchema = async () => (_schema ??= auth.api.generateOpenAPISchema());
export const OpenAPI = {
  getPaths: (prefix = "/auth/api") =>
    getSchema().then(({ paths }) => {
      const reference: typeof paths = Object.create(null);
      for (const path of Object.keys(paths)) {
        const key = prefix + path;
        reference[key] = paths[path];
        for (const method of Object.keys(paths[path])) {
          const operation = (reference[key] as any)[method];
          operation.tags = ["Better Auth"];
        }
      }
      return reference;
    }) as Promise<any>,
  components: getSchema().then(({ components }) => components) as Promise<any>,
} as const;
