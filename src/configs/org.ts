import { z } from "zod";

export const orgNameSchema = z
  .string()
  .min(5, { message: "Organization name must be at least 5 characters long" });
// .max(50, { message: "Organization name must be at most 50 characters long" });
