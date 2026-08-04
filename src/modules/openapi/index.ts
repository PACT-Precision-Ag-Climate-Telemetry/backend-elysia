import { Elysia } from "elysia";
import { openapi, fromTypes } from "@elysia/openapi";
import { OpenAPI } from "@/utils/auth";

const openapiApp = new Elysia({ name: "openapi" }).use(
  openapi({
    path: "/openapi",
    documentation: {
      components: await OpenAPI.components,
      paths: await OpenAPI.getPaths(),
    },
    references: fromTypes(
      process.env.NODE_ENV === "production"
        ? "dist/index.d.ts"
        : "src/index.ts",
    ),
  }),
);

export default openapiApp;
