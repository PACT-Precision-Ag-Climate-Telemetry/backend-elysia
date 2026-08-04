import { Elysia } from "elysia";
import { auth } from "@/utils/auth";
import {
  checkOrgHierarchyPermission,
  requireOrgHierarchyPermission,
} from "@/utils/auth/hierarchy";
import { statement, type Action } from "@/utils/auth/permission";

const allowedActions = statement.myOrg as readonly string[];

function isAction(value: string): value is Action {
  return allowedActions.includes(value);
}

const hierarchyExampleApp = new Elysia({ name: "hierarchy-example" })
  .get(
    "/examples/hierarchy/check/:targetOrgId/:action",
    async ({ request, params, status }) => {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session) {
        return status(401, {
          message: "Unauthorized",
        });
      }

      const action = params.action;
      if (!isAction(action)) {
        return status(400, {
          message: "Invalid action",
          allowedActions,
        });
      }

      const result = await checkOrgHierarchyPermission({
        userId: session.user.id,
        targetOrgId: params.targetOrgId,
        action,
      });

      if (!result.allowed) {
        return status(403, result);
      }

      return result;
    },
  )
  .post(
    "/examples/hierarchy/require/:targetOrgId/:action",
    async ({ request, params, status }) => {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session) {
        return status(401, {
          message: "Unauthorized",
        });
      }

      const action = params.action;
      if (!isAction(action)) {
        return status(400, {
          message: "Invalid action",
          allowedActions,
        });
      }

      try {
        const permission = await requireOrgHierarchyPermission({
          userId: session.user.id,
          targetOrgId: params.targetOrgId,
          action,
        });

        return {
          allowed: true,
          ...permission,
        };
      } catch (error) {
        return status(403, {
          allowed: false,
          message: error instanceof Error ? error.message : "Forbidden",
        });
      }
    },
  );

export default hierarchyExampleApp;
